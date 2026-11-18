const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { db } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');
const { publicPlaceSql } = require('./placeVisibility');

// 地图标记快照（GET /places/markers）：全部公开地点，只含画标记、筛选、聚合成员列表与卡片标题要用的字段。
// 与观看者无关，由 CDN 和浏览器缓存（http/middleware/publicCache.js）；描述、图片、创建者等在打开卡片时
// 再读 GET /places/:id。自己还在审核中的地点、屏蔽的住民创建的地点由 GET /places/overlay 单独给出。
// 前端 frontend/src/map/markerSnapshot.js 按 fields 展开，字段增删两边一起改。
//
// 按列存（fields + rows），不重复键名：3800 个地点约 290 KB，br 压缩后约 100 KB。
// 进程内缓存 MARKER_SNAPSHOT_TTL_MS（默认 15 秒），并预先压缩好 br / gzip，CDN 回源时直接发送。

const MARKER_FIELDS = Object.freeze([
    'id', 'name', 'category', 'longitude', 'latitude', 'per_person_cost',
    'province', 'city', 'district', 'rating_count', 'rating_average', 'rating_negative_count', 'checkin_count'
]);

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

function ttlMs() {
    const value = Number(process.env.MARKER_SNAPSHOT_TTL_MS ?? 15000);
    return Number.isFinite(value) && value >= 0 ? value : 15000;
}

function readRows(database = db._raw) {
    return database.prepare(`SELECT p.id, p.name, p.category, p.longitude, p.latitude, p.per_person_cost,
            pr.province, pr.city, pr.district,${RATING_COLUMNS_SQL}
        FROM Place p
        LEFT JOIN PlaceRegion pr ON pr.place_id = p.id
        WHERE ${publicPlaceSql('p')} AND p.longitude IS NOT NULL AND p.latitude IS NOT NULL
        ORDER BY p.id`).all();
}

/** 构建快照正文（同步读库）。version 只由内容决定：内容不变时 ETag 不变，CDN 与浏览器都能用 304 */
function buildSnapshotBody(database = db._raw, now = Date.now()) {
    const rows = readRows(database).map((row) => MARKER_FIELDS.map((field) => (row[field] === undefined ? null : row[field])));
    const content = JSON.stringify([MARKER_FIELDS, rows]);
    const version = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
    return { version, generated_at: now, fields: MARKER_FIELDS, rows };
}

let cached = null;
let pending = null;

async function encode(body) {
    const json = Buffer.from(JSON.stringify(body), 'utf8');
    const [br, gz] = await Promise.all([
        brotli(json, {
            params: {
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length
            }
        }),
        gzip(json, { level: 7 })
    ]);
    return { version: body.version, etag: `W/"m-${body.version}"`, count: body.rows.length, identity: json, br, gzip: gz };
}

/**
 * 当前快照（含预压缩的正文）。TTL 内直接复用；过期后重建，同时到来的请求共用一次重建。
 * 内容没变时沿用旧的 generated_at 与编码结果，避免重复压缩。
 */
async function markerSnapshot({ now = Date.now() } = {}) {
    if (cached && now - cached.builtAt < ttlMs()) return cached;
    if (pending) return pending;
    pending = (async () => {
        const body = buildSnapshotBody(db._raw, now);
        if (cached && cached.version === body.version) {
            cached = { ...cached, builtAt: now };
            return cached;
        }
        cached = { ...(await encode(body)), builtAt: now };
        return cached;
    })().finally(() => { pending = null; });
    return pending;
}

/** 测试与写入后立即生效用：下一次请求重建快照 */
function invalidateMarkerSnapshot() {
    if (cached) cached = { ...cached, builtAt: -Infinity };
}

module.exports = { MARKER_FIELDS, buildSnapshotBody, markerSnapshot, invalidateMarkerSnapshot };
