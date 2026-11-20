'use strict';

// 场馆请求的读写：对端推送（upsert）、管理员待办（list / link / ignore）、跳转解析（resolve）。
//
// 状态只有三态，且只由我们自己推进：
//   pending  收到请求，等管理员建档
//   linked   已关联到一个 Place（place_id 可能被删，解析时按 LEFT JOIN 判存活）
//   ignored  不需要（重复、或该活动不需要落点）
//
// 不存活动日期、不改写历史：对端再推一次只更新展示文字，linked 的 place_id 不动。

const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { publicPlaceSql } = require('../../places/services/placeVisibility');

const STATUS = Object.freeze({ PENDING: 'pending', LINKED: 'linked', IGNORED: 'ignored' });
const EXTERNAL_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATCH = 50;
const FIELD_LIMITS = Object.freeze({ label: 120, address: 200, city: 40 });

function failure(status, code, message) {
    return Object.assign(new Error(message), { status, code, publicMessage: message });
}

/** 纯文本：去首尾空白、拒绝控制字符、限制长度。返回 null 表示留空。 */
function plainText(value, { field, max, required = false }) {
    if (value === undefined || value === null) {
        if (required) throw failure(400, 'MISSING_FIELD', `缺少 ${field}`);
        return null;
    }
    if (typeof value !== 'string') throw failure(400, 'INVALID_FIELD', `${field} 必须是字符串`);
    // 控制字符会破坏日志与展示；换行也在内。
    if (/[\u0000-\u001f\u007f]/.test(value)) throw failure(400, 'INVALID_FIELD', `${field} 含非法字符`);
    const text = value.trim();
    if (!text) {
        if (required) throw failure(400, 'MISSING_FIELD', `缺少 ${field}`);
        return null;
    }
    if (text.length > max) throw failure(400, 'INVALID_FIELD', `${field} 最多 ${max} 字`);
    return text;
}

/** 校验一条推送事件，返回可直接写库的值。 */
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

/**
 * 一批推送的 upsert。已是 linked 的行只更新展示文字，不动 place_id；
 * ignored 的行保持 ignored（除非对端换了个 key，那是另一条请求）。
 * 返回每条的结果，便于调用方统计 accepted / updated / ignored。
 */
const upsertTransaction = db._raw.transaction((source, events) => {
    const select = db._raw.prepare('SELECT id, status, label, address, city FROM VenueRequest WHERE source = ? AND external_key = ?');
    const update = db._raw.prepare(`UPDATE VenueRequest SET label = ?, address = ?, city = ?, updated_time = ?
        WHERE id = ?`);
    const insert = db._raw.prepare(`INSERT INTO VenueRequest (source, external_key, label, address, city)
        VALUES (?, ?, ?, ?, ?)`);
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
            // ignored 的行收到重复推送算 ignored，不改状态
            result: existing.status === STATUS.IGNORED ? 'ignored' : (unchanged ? 'accepted' : 'updated')
        });
    }
    return results;
});

/** 接收一批推送。events 已经过 normalizeEvent。 */
function receivePush({ source = 'denpawave', events }) {
    if (!Array.isArray(events) || !events.length) throw failure(400, 'EMPTY_BATCH', '至少要有一条场馆请求');
    if (events.length > MAX_BATCH) throw failure(400, 'BATCH_TOO_LARGE', `单次最多 ${MAX_BATCH} 条`);
    return upsertTransaction(source, events);
}

function pendingRequests(sql = db._raw) {
    return sql.prepare(`SELECT id, source, external_key, label, address, city, created_time
        FROM VenueRequest WHERE status = 'pending' ORDER BY id`).all();
}

function requestById(id, sql = db._raw) {
    return sql.prepare('SELECT * FROM VenueRequest WHERE id = ?').get(id) || null;
}

const linkTransaction = db._raw.transaction(({ id, placeId, adminId }) => {
    const row = db._raw.prepare('SELECT * FROM VenueRequest WHERE id = ?').get(id);
    if (!row) throw failure(404, 'VENUE_REQUEST_NOT_FOUND', '场馆请求不存在');
    if (row.status !== STATUS.PENDING) throw failure(409, 'VENUE_REQUEST_ALREADY_HANDLED', '这条请求已经处理过');
    const place = db._raw.prepare('SELECT id, name, moderation_status FROM Place WHERE id = ?').get(placeId);
    if (!place) throw failure(404, 'PLACE_NOT_FOUND', '地点不存在');
    const now = new Date().toISOString();
    db._raw.prepare(`UPDATE VenueRequest SET place_id = ?, status = ?, handled_by = ?, handled_time = ?
        WHERE id = ? AND status = 'pending'`).run(place.id, STATUS.LINKED, String(adminId), now, id);
    insertAdminAction(adminId, 'link-venue-request', null, JSON.stringify({ venue_request_id: id, place_id: place.id, external_key: row.external_key }));
    return { placeId: place.id };
});

const ignoreTransaction = db._raw.transaction(({ id, note, adminId }) => {
    const row = db._raw.prepare('SELECT * FROM VenueRequest WHERE id = ?').get(id);
    if (!row) throw failure(404, 'VENUE_REQUEST_NOT_FOUND', '场馆请求不存在');
    if (row.status !== STATUS.PENDING) throw failure(409, 'VENUE_REQUEST_ALREADY_HANDLED', '这条请求已经处理过');
    const now = new Date().toISOString();
    db._raw.prepare(`UPDATE VenueRequest SET status = ?, note = ?, handled_by = ?, handled_time = ?
        WHERE id = ? AND status = 'pending'`).run(STATUS.IGNORED, note || null, String(adminId), now, id);
    insertAdminAction(adminId, 'ignore-venue-request', null, JSON.stringify({ venue_request_id: id, external_key: row.external_key, note: note || null }));
    return { ignored: true };
});

/**
 * 跳转解析：只回状态和 placeId，不泄露 label / address / city。
 * place_id 指向的地点可能被删（我们不追生命周期），所以按 LEFT JOIN 判存活：
 * 关联不存在或已下架时返回 unknown，前端按「还没标记」处理。
 */
function resolve(externalKey, { source = 'denpawave' } = {}, sql = db._raw) {
    const row = sql.prepare(`SELECT v.status, v.place_id, p.id AS live_place_id
        FROM VenueRequest v
        LEFT JOIN Place p ON p.id = v.place_id AND ${publicPlaceSql('p')}
        WHERE v.source = ? AND v.external_key = ?`).get(source, externalKey);
    if (!row) return { status: 'unknown', placeId: null };
    if (row.status === STATUS.LINKED && row.live_place_id) {
        return { status: STATUS.LINKED, placeId: row.live_place_id };
    }
    // linked 但地点没了：对观众等价于「还没标记」
    if (row.status === STATUS.LINKED) return { status: 'unknown', placeId: null };
    if (row.status === STATUS.IGNORED) return { status: 'ignored', placeId: null };
    return { status: STATUS.PENDING, placeId: null };
}

module.exports = {
    STATUS,
    EXTERNAL_KEY,
    MAX_BATCH,
    FIELD_LIMITS,
    normalizeEvent,
    receivePush,
    pendingRequests,
    requestById,
    link: (input) => linkTransaction(input),
    ignore: (input) => ignoreTransaction(input),
    resolve,
    // 测试用：允许传入只读的 sql 句柄
    _internal: { upsertTransaction, linkTransaction, ignoreTransaction }
};
