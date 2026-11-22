'use strict';

// 场馆的读写：对端推送（upsert）、管理员落点（place / ignore）、跳转解析（resolve）。
//
// 一个场馆经历三个阶段，都在同一行上流转：
//   pending  收到对端推送，等管理员在地图上落点 —— 只有这个状态算「待办」
//   placed   已指定坐标，跳转时聚焦到这里 —— 实体态
//   ignored  不需要（重复、或该活动不需要落点）
//
// 命名以实体为准：表是 Venue、状态是 placed。「待办」只是 pending 的别名，
// 不构成第二个名字（见 doc/README.md）。
//
// 场馆不是 Place：不建地点、不写评分、不进搜索与随机推荐。坐标只来自管理员在地图上的选点，
// 不落任何高德搜索结果；对端给的文字原样保存，不做地理编码。

const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');

const STATUS = Object.freeze({ PENDING: 'pending', PLACED: 'placed', IGNORED: 'ignored' });
const EXTERNAL_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATCH = 50;
const FIELD_LIMITS = Object.freeze({ label: 120, address: 200, city: 40 });
// 与地点一致：Web Mercator 只画到 ±85.0511°，超出这个范围的点在地图上无法显示，存了也没用。
const MAX_MERCATOR_LAT = 85.0511;

function failure(status, code, message) {
    return Object.assign(new Error(message), { status, code, publicMessage: message });
}

/** 纯文本：去首尾空白、拒绝控制字符（含换行）、限制长度。空值返回 null。 */
function plainText(value, { field, max, required = false }) {
    if (value === undefined || value === null) {
        if (required) throw failure(400, 'MISSING_FIELD', `缺少 ${field}`);
        return null;
    }
    if (typeof value !== 'string') throw failure(400, 'INVALID_FIELD', `${field} 必须是字符串`);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw failure(400, 'INVALID_FIELD', `${field} 含非法字符`);
    const text = value.trim();
    if (!text) {
        if (required) throw failure(400, 'MISSING_FIELD', `缺少 ${field}`);
        return null;
    }
    if (text.length > max) throw failure(400, 'INVALID_FIELD', `${field} 最多 ${max} 字`);
    return text;
}

/** 校验一条推送事件。坐标不来自对端，所以这里只认文字。 */
function normalizeEvent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw failure(400, 'INVALID_FIELD', '事件格式错误');
    }
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!EXTERNAL_KEY.test(key)) throw failure(400, 'INVALID_KEY', 'key 只能是小写字母、数字、下划线与连字符，最长 64 位');
    return {
        externalKey: key,
        label: plainText(input.label, { field: 'label', max: FIELD_LIMITS.label, required: true }),
        address: plainText(input.address, { field: 'address', max: FIELD_LIMITS.address }),
        city: plainText(input.city, { field: 'city', max: FIELD_LIMITS.city })
    };
}

/** 落点坐标：GCJ-02，范围与地点一致；(0,0) 视为未选。 */
function normalizeCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw failure(400, 'INVALID_COORDINATE', '坐标无效');
    if (lng < -180 || lng > 180) throw failure(400, 'INVALID_COORDINATE', '经度超出范围');
    if (Math.abs(lat) > MAX_MERCATOR_LAT) throw failure(400, 'INVALID_COORDINATE', '纬度超出范围');
    if (lat === 0 && lng === 0) throw failure(400, 'INVALID_COORDINATE', '请选择有效位置');
    return { latitude: lat, longitude: lng };
}

/**
 * 一批推送的 upsert。已是 placed 的场馆只更新展示文字，坐标不动；
 * ignored 的保持 ignored（对端换个 key 才是另一条记录）。
 */
const upsertTransaction = db._raw.transaction((source, events) => {
    const select = db._raw.prepare('SELECT id, status, label, address, city FROM Venue WHERE source = ? AND external_key = ?');
    const update = db._raw.prepare(`UPDATE Venue SET label = ?, address = ?, city = ?, updated_time = ? WHERE id = ?`);
    const insert = db._raw.prepare(`INSERT INTO Venue (source, external_key, label, address, city) VALUES (?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    const results = [];
    for (const event of events) {
        const existing = select.get(source, event.externalKey);
        if (!existing) {
            insert.run(source, event.externalKey, event.label, event.address, event.city);
            results.push({ key: event.externalKey, result: 'accepted' });
            continue;
        }
        const unchanged = existing.label === event.label
            && existing.address === event.address
            && existing.city === event.city;
        if (!unchanged) update.run(event.label, event.address, event.city, now, existing.id);
        results.push({
            key: event.externalKey,
            result: existing.status === STATUS.IGNORED ? 'ignored' : (unchanged ? 'accepted' : 'updated')
        });
    }
    return results;
});

function receivePush({ source = 'denpawave', events }) {
    if (!Array.isArray(events) || !events.length) throw failure(400, 'EMPTY_BATCH', '至少要有一条场馆');
    if (events.length > MAX_BATCH) throw failure(400, 'BATCH_TOO_LARGE', `单次最多 ${MAX_BATCH} 条`);
    return upsertTransaction(source, events);
}

/** 待办：只有 pending 的场馆需要管理员动手 */
function pendingVenues(sql = db._raw) {
    return sql.prepare(`SELECT id, source, external_key, label, address, city, created_time
        FROM Venue WHERE status = 'pending' ORDER BY id`).all();
}

function venueById(id, sql = db._raw) {
    return sql.prepare('SELECT * FROM Venue WHERE id = ?').get(id) || null;
}

const placeTransaction = db._raw.transaction(({ id, latitude, longitude, adminId }) => {
    const row = db._raw.prepare('SELECT * FROM Venue WHERE id = ?').get(id);
    if (!row) throw failure(404, 'VENUE_NOT_FOUND', '场馆不存在');
    if (row.status !== STATUS.PENDING) throw failure(409, 'VENUE_ALREADY_HANDLED', '这个场馆已经处理过');
    const coordinates = normalizeCoordinates(latitude, longitude);
    const now = new Date().toISOString();
    db._raw.prepare(`UPDATE Venue SET latitude = ?, longitude = ?, status = ?, placed_by = ?, placed_time = ?
        WHERE id = ? AND status = 'pending'`)
        .run(coordinates.latitude, coordinates.longitude, STATUS.PLACED, String(adminId), now, id);
    insertAdminAction(adminId, 'place-venue', null, JSON.stringify({
        venue_id: id, external_key: row.external_key, latitude: coordinates.latitude, longitude: coordinates.longitude
    }));
    return { latitude: coordinates.latitude, longitude: coordinates.longitude };
});

const ignoreTransaction = db._raw.transaction(({ id, note, adminId }) => {
    const row = db._raw.prepare('SELECT * FROM Venue WHERE id = ?').get(id);
    if (!row) throw failure(404, 'VENUE_NOT_FOUND', '场馆不存在');
    if (row.status !== STATUS.PENDING) throw failure(409, 'VENUE_ALREADY_HANDLED', '这个场馆已经处理过');
    const now = new Date().toISOString();
    db._raw.prepare(`UPDATE Venue SET status = ?, note = ?, placed_by = ?, placed_time = ?
        WHERE id = ? AND status = 'pending'`).run(STATUS.IGNORED, note || null, String(adminId), now, id);
    insertAdminAction(adminId, 'ignore-venue', null, JSON.stringify({ venue_id: id, external_key: row.external_key, note: note || null }));
    return { ignored: true };
});

/**
 * 跳转解析：只回状态和坐标，不泄露 label / address / city。
 * placed 才带坐标；pending / ignored / unknown 一律 null，前端据此提示「还没标记」。
 */
function resolve(externalKey, { source = 'denpawave' } = {}, sql = db._raw) {
    const row = sql.prepare('SELECT status, latitude, longitude FROM Venue WHERE source = ? AND external_key = ?')
        .get(source, externalKey);
    if (!row) return { status: 'unknown', latitude: null, longitude: null };
    if (row.status === STATUS.PLACED && Number.isFinite(row.latitude) && Number.isFinite(row.longitude)) {
        return { status: STATUS.PLACED, latitude: row.latitude, longitude: row.longitude };
    }
    // 状态是 placed 但没有有效坐标：对观众等价于「还没标记」
    if (row.status === STATUS.PLACED) return { status: 'unknown', latitude: null, longitude: null };
    if (row.status === STATUS.IGNORED) return { status: STATUS.IGNORED, latitude: null, longitude: null };
    return { status: STATUS.PENDING, latitude: null, longitude: null };
}

module.exports = {
    STATUS,
    EXTERNAL_KEY,
    MAX_BATCH,
    FIELD_LIMITS,
    MAX_MERCATOR_LAT,
    normalizeEvent,
    normalizeCoordinates,
    receivePush,
    pendingVenues,
    venueById,
    place: (input) => placeTransaction(input),
    ignore: (input) => ignoreTransaction(input),
    resolve,
    _internal: { upsertTransaction, placeTransaction, ignoreTransaction }
};
