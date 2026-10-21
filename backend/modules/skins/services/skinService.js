const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');

// 可兑换的皮肤登记在 catalog.json；前端 src/skins/packs/<id>/skin.json 是同一套皮肤的素材（npm run test:skins 核对两边一致）。
// 默认样式 'default' 人人可用，不登记、不发兑换码。
const DEFAULT_SKIN_ID = 'default';
const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// 去掉易混的 0/O、1/I/L；12 位约 4×10^17 种组合，配合失败次数限制无法穷举
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const MAX_BATCH = 200;
const MAX_USES = 10000;
const MAX_EXPIRES_DAYS = 3650;
const MAX_NOTE_LENGTH = 100;
// 每位住民每小时最多输错 10 次（成功或“已拥有”不计）
const FAILURE_LIMIT = 10;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

class SkinError extends Error {
    constructor(status, reason, message) {
        super(message);
        this.status = status;
        this.reason = reason;
    }
}

const CATALOG_FILE = path.join(__dirname, '..', 'catalog.json');

function parseCatalog(data) {
    const skins = Array.isArray(data && data.skins) ? data.skins : [];
    const seen = new Set();
    return skins.map((entry) => {
        const id = String(entry && entry.id || '');
        const name = String(entry && entry.name || '').trim();
        if (!SKIN_ID_PATTERN.test(id) || id === DEFAULT_SKIN_ID || seen.has(id) || !name) {
            throw new Error(`Invalid skin catalog entry: ${JSON.stringify(entry)}`);
        }
        seen.add(id);
        return Object.freeze({ id, name });
    });
}

const readCatalog = () => parseCatalog(JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')));
let catalog = readCatalog();

function listCatalog() {
    return catalog.slice();
}

function findSkin(id) {
    return catalog.find((skin) => skin.id === id) || null;
}

/** 测试用：替换皮肤目录（传入 null 恢复 catalog.json） */
function setCatalogForTesting(entries) {
    catalog = entries ? parseCatalog({ skins: entries }) : readCatalog();
}

/** 兑换码输入：忽略大小写、空格与连字符 */
function normalizeCode(input) {
    const code = String(input == null ? '' : input).toUpperCase().replace(/[\s-]/g, '');
    return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

function formatCode(code) {
    return String(code || '').match(/.{1,4}/g)?.join('-') || '';
}

function generateCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return code;
}

function codeStatus(row, now = new Date()) {
    if (row.revoked) return 'revoked';
    if (row.expires_time && Date.parse(row.expires_time) <= now.getTime()) return 'expired';
    if (row.current_uses >= row.max_uses) return 'exhausted';
    return 'active';
}

// ---- 住民 ----

function getSkinState(userId) {
    const rows = db._raw.prepare('SELECT skin_id, unlocked_time FROM UserSkin WHERE user_id = ? ORDER BY unlocked_time, skin_id').all(userId);
    const owned = rows
        .map((row) => ({ skin: findSkin(row.skin_id), unlocked_time: row.unlocked_time }))
        .filter((item) => item.skin)
        .map((item) => ({ id: item.skin.id, name: item.skin.name, unlocked_time: item.unlocked_time }));
    const user = db._raw.prepare('SELECT active_skin FROM User WHERE id = ?').get(userId);
    const active = user && user.active_skin && owned.some((item) => item.id === user.active_skin) ? user.active_skin : DEFAULT_SKIN_ID;
    return { active, owned };
}

const failures = new Map();

function failureKey(userId) {
    return String(userId);
}

function assertRedeemAllowed(userId, now = Date.now()) {
    const entry = failures.get(failureKey(userId));
    if (entry && now - entry.startedAt < FAILURE_WINDOW_MS && entry.count >= FAILURE_LIMIT) {
        throw new SkinError(429, 'rate_limited', '兑换码输错次数过多，请一小时后再试');
    }
}

function recordFailure(userId, now = Date.now()) {
    const key = failureKey(userId);
    const entry = failures.get(key);
    if (!entry || now - entry.startedAt >= FAILURE_WINDOW_MS) failures.set(key, { startedAt: now, count: 1 });
    else entry.count += 1;
    if (failures.size > 5000) {
        for (const [k, value] of failures) if (now - value.startedAt >= FAILURE_WINDOW_MS) failures.delete(k);
    }
}

function resetFailuresForTesting() {
    failures.clear();
}

const redeemTransaction = db._raw.transaction(({ userId, code, activate, now }) => {
    const row = db._raw.prepare(`SELECT id, skin_id, max_uses, current_uses, expires_time, revoked
        FROM InviteCode WHERE code = ? AND skin_id IS NOT NULL`).get(code);
    if (!row) throw new SkinError(404, 'not_found', '兑换码不存在，请检查后重新输入');
    const skin = findSkin(row.skin_id);
    const status = codeStatus(row, now);
    if (status === 'revoked') throw new SkinError(410, 'revoked', '这个兑换码已作废');
    if (status === 'expired') throw new SkinError(410, 'expired', '这个兑换码已过期');
    if (!skin) throw new SkinError(410, 'unavailable', '这套皮肤已下架，暂时无法兑换');
    const owned = db._raw.prepare('SELECT 1 FROM UserSkin WHERE user_id = ? AND skin_id = ?').get(userId, skin.id);
    if (owned) {
        // 已经拥有：不消耗兑换码的次数
        if (activate) db._raw.prepare('UPDATE User SET active_skin = ? WHERE id = ?').run(skin.id, userId);
        return { skin, alreadyOwned: true, codeId: row.id };
    }
    if (status === 'exhausted') throw new SkinError(410, 'exhausted', '这个兑换码的次数已经用完');
    const consumed = db._raw.prepare('UPDATE InviteCode SET current_uses = current_uses + 1 WHERE id = ? AND current_uses < max_uses').run(row.id);
    if (consumed.changes !== 1) throw new SkinError(410, 'exhausted', '这个兑换码的次数已经用完');
    db._raw.prepare('INSERT INTO UserSkin (user_id, skin_id, invite_code_id, unlocked_time) VALUES (?, ?, ?, ?)')
        .run(userId, skin.id, row.id, now.toISOString());
    if (activate) db._raw.prepare('UPDATE User SET active_skin = ? WHERE id = ?').run(skin.id, userId);
    return { skin, alreadyOwned: false, codeId: row.id };
});

/**
 * 兑换：成功解锁（并默认立即使用）；已经拥有时不消耗次数。
 * @returns {{ skin: {id, name}, alreadyOwned: boolean, codeId: number, state: object }}
 */
function redeemCode(userId, input, { activate = true, now = new Date() } = {}) {
    assertRedeemAllowed(userId, now.getTime());
    const code = normalizeCode(input);
    try {
        if (!code) throw new SkinError(400, 'invalid_format', '兑换码格式不正确');
        const result = redeemTransaction.immediate({ userId, code, activate: !!activate, now });
        return { ...result, state: getSkinState(userId) };
    } catch (error) {
        if (error instanceof SkinError) recordFailure(userId, now.getTime());
        throw error;
    }
}

function setActiveSkin(userId, skinId) {
    const id = String(skinId == null ? '' : skinId);
    if (id === DEFAULT_SKIN_ID || id === '') {
        db._raw.prepare('UPDATE User SET active_skin = NULL WHERE id = ?').run(userId);
        return getSkinState(userId);
    }
    if (!findSkin(id)) throw new SkinError(400, 'unknown_skin', '没有这套皮肤');
    const owned = db._raw.prepare('SELECT 1 FROM UserSkin WHERE user_id = ? AND skin_id = ?').get(userId, id);
    if (!owned) throw new SkinError(403, 'not_owned', '还没有解锁这套皮肤');
    db._raw.prepare('UPDATE User SET active_skin = ? WHERE id = ?').run(id, userId);
    return getSkinState(userId);
}

// ---- 管理 ----

function integerInRange(value, min, max) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function parseCreateRequest(body = {}) {
    const skinId = String(body.skin_id || '');
    if (!findSkin(skinId)) throw new SkinError(400, 'unknown_skin', '请选择已登记的皮肤');
    const count = integerInRange(body.count == null ? 1 : body.count, 1, MAX_BATCH);
    if (count === null) throw new SkinError(400, 'invalid_count', `每次生成 1 到 ${MAX_BATCH} 个兑换码`);
    const maxUses = integerInRange(body.max_uses == null ? 1 : body.max_uses, 1, MAX_USES);
    if (maxUses === null) throw new SkinError(400, 'invalid_max_uses', `每个兑换码可用 1 到 ${MAX_USES} 次`);
    const blank = body.expires_days === undefined || body.expires_days === null || body.expires_days === '';
    const expiresDays = blank ? null : integerInRange(body.expires_days, 1, MAX_EXPIRES_DAYS);
    if (!blank && expiresDays === null) throw new SkinError(400, 'invalid_expiry', `有效期为 1 到 ${MAX_EXPIRES_DAYS} 天，或留空表示长期有效`);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > MAX_NOTE_LENGTH) throw new SkinError(400, 'invalid_note', `备注最多 ${MAX_NOTE_LENGTH} 字`);
    return { skinId, count, maxUses, expiresDays, note };
}

const createTransaction = db._raw.transaction(({ adminId, skinId, count, maxUses, expiresTime, note }) => {
    const exists = db._raw.prepare('SELECT 1 FROM InviteCode WHERE code = ?');
    const insert = db._raw.prepare(`INSERT INTO InviteCode (code, max_uses, current_uses, skin_id, note, created_by, expires_time)
        VALUES (?, ?, 0, ?, ?, ?, ?)`);
    const created = [];
    while (created.length < count) {
        const code = generateCode();
        // 与旧邀请码也不重复，避免同一串码对应两种含义
        if (exists.get(code)) continue;
        const result = insert.run(code, maxUses, skinId, note || null, adminId, expiresTime);
        created.push(Number(result.lastInsertRowid));
    }
    insertAdminAction(adminId, 'create-skin-codes', null, JSON.stringify({ skin_id: skinId, count, max_uses: maxUses, expires_time: expiresTime }));
    return created;
});

function createCodes(adminId, body, { now = new Date() } = {}) {
    const request = parseCreateRequest(body);
    const expiresTime = request.expiresDays ? new Date(now.getTime() + request.expiresDays * 86400000).toISOString() : null;
    const ids = createTransaction.immediate({ adminId, ...request, expiresTime });
    return listCodes({ ids, now });
}

function toCodeView(row, now) {
    const skin = findSkin(row.skin_id);
    return {
        id: row.id,
        code: formatCode(row.code),
        skin_id: row.skin_id,
        skin_name: skin ? skin.name : row.skin_id,
        max_uses: row.max_uses,
        current_uses: row.current_uses,
        expires_time: row.expires_time || null,
        note: row.note || '',
        created_by: row.created_by_name || row.created_by || null,
        created_time: row.created_time,
        status: codeStatus(row, now)
    };
}

function listCodes({ skinId = null, ids = null, limit = 200, now = new Date() } = {}) {
    const where = ['c.skin_id IS NOT NULL'];
    const params = [];
    if (skinId) {
        where.push('c.skin_id = ?');
        params.push(String(skinId));
    }
    if (ids) {
        if (!ids.length) return [];
        where.push(`c.id IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
    }
    const rows = db._raw.prepare(`SELECT c.id, c.code, c.skin_id, c.max_uses, c.current_uses, c.expires_time, c.revoked, c.note,
            c.created_by, u.username AS created_by_name, c.created_time
        FROM InviteCode c LEFT JOIN User u ON u.id = c.created_by
        WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`).all(...params, Math.max(1, Math.min(1000, Number(limit) || 200)));
    return rows.map((row) => toCodeView(row, now));
}

const revokeTransaction = db._raw.transaction(({ adminId, id }) => {
    const row = db._raw.prepare('SELECT id, skin_id, revoked FROM InviteCode WHERE id = ? AND skin_id IS NOT NULL').get(id);
    if (!row) return false;
    if (!row.revoked) {
        db._raw.prepare('UPDATE InviteCode SET revoked = 1 WHERE id = ?').run(id);
        insertAdminAction(adminId, 'revoke-skin-code', null, JSON.stringify({ code_id: id, skin_id: row.skin_id }));
    }
    return true;
});

/** 作废：之后不能再兑换；已经解锁的住民保留皮肤 */
function revokeCode(adminId, id) {
    const codeId = integerInRange(id, 1, Number.MAX_SAFE_INTEGER);
    if (codeId === null || !revokeTransaction.immediate({ adminId, id: codeId })) throw new SkinError(404, 'not_found', '兑换码不存在');
    return listCodes({ ids: [codeId] })[0];
}

module.exports = {
    DEFAULT_SKIN_ID,
    SkinError,
    listCatalog,
    findSkin,
    normalizeCode,
    formatCode,
    getSkinState,
    redeemCode,
    setActiveSkin,
    createCodes,
    listCodes,
    revokeCode,
    setCatalogForTesting,
    resetFailuresForTesting
};
