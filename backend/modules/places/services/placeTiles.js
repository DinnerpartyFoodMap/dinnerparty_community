'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { db } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, isAvoidedPlace } = require('../../ratings/services/placeRatings');
const { hasExploreTag } = require('../../ratings/services/ratingWarning');
const { publicPlaceSql } = require('./placeVisibility');

// 地图标记的分层瓦片（取代一次给出全部店名和坐标的 GET /places/markers）。说明见 ../doc/README.md#分层瓦片，
// 前端 frontend/src/map/markerTiles.js 按同样的级别和格式读取，两边一起改。
//
// - 三级聚合瓦片：格子位置（成员重心，取整到 1/8 格）、店数、每家店匿名的一行（标签编号、人均、地区编号、图标类型）。
//   不带 id、店名和单店坐标：拉齐这些瓦片也对不上具体的店，id 只出现在明细瓦片和单店接口里（两处都有配额）。
//   行按内容排序，不保留 id 顺序。公共缓存，URL 带内容哈希，永不过期。
// - 明细瓦片（z12）：与旧快照相同的字段（id、店名、坐标、标签、人均、省市区、评价汇总），按 IP / 账号限流，只在浏览器缓存。
// - 字典：标签名、地区名（聚合瓦片里用编号）；清单：每块瓦片的内容哈希。
//
// 所有内容在内存里建好，TILE_SNAPSHOT_TTL_MS（默认 15 秒）内复用；压缩结果按需生成并缓存，内容没变的瓦片沿用旧的。

const AGGREGATE_LEVELS = Object.freeze([
    Object.freeze({ tile: 2, cell: 9, minZoom: 0, maxZoom: 7 }),
    Object.freeze({ tile: 5, cell: 12, minZoom: 8, maxZoom: 10 }),
    Object.freeze({ tile: 8, cell: 14, minZoom: 11, maxZoom: 12 })
]);
const LEAF_LEVEL = Object.freeze({ tile: 12, minZoom: 13 });
const LEAF_FIELDS = Object.freeze([
    'id', 'name', 'category', 'longitude', 'latitude', 'per_person_cost',
    'province', 'city', 'district', 'rating_count', 'rating_average', 'rating_negative_count'
]);
// 聚合行的图标类型：0 普通、1 避雷、2 待探索（与前端 map/markerContent.js 的 placeGlyphKind 对应）
const GLYPH = Object.freeze({ place: 0, avoid: 1, unexplored: 2 });
const FORMAT_VERSION = 1;

function ttlMs() {
    const value = Number(process.env.TILE_SNAPSHOT_TTL_MS ?? 15000);
    return Number.isFinite(value) && value >= 0 ? value : 15000;
}

// ---- Web Mercator 瓦片坐标（与高德、Supercluster 相同的 256px 瓦片划分；坐标照存的 GCJ-02 原样换算） ----

const MAX_LAT = 85.0511;
function worldX(lng, z) { return ((lng + 180) / 360) * 2 ** z; }
function worldY(lat, z) {
    const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
function tileIndex(value, z) { return Math.max(0, Math.min(2 ** z - 1, Math.floor(value))); }

function tagsOf(category) {
    return [...new Set(String(category || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function glyphOf(row) {
    if (isAvoidedPlace(row)) return GLYPH.avoid;
    if (hasExploreTag(row.category) && !(Number(row.rating_count) > 0)) return GLYPH.unexplored;
    return GLYPH.place;
}

function hashOf(text) {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function readRows(database) {
    return database.prepare(`SELECT p.id, p.name, p.category, p.longitude, p.latitude, p.per_person_cost,
            pr.province, pr.city, pr.district,${RATING_COLUMNS_SQL}
        FROM Place p
        LEFT JOIN PlaceRegion pr ON pr.place_id = p.id
        WHERE ${publicPlaceSql('p')} AND p.longitude IS NOT NULL AND p.latitude IS NOT NULL
        ORDER BY p.id`).all();
}

/** 由地点行建出全部瓦片（纯计算，测试直接调用）。返回 { manifest, files: Map<路径, { hash, json }> } */
function buildTiles(rows, now = Date.now()) {
    const places = rows.filter((row) => Number.isFinite(Number(row.longitude)) && Number.isFinite(Number(row.latitude))
        && Math.abs(Number(row.latitude)) <= MAX_LAT && Math.abs(Number(row.longitude)) <= 180);

    // 字典：按地点 id 顺序第一次出现的先后编号（新地点多半排在最后，编号尽量不随新增而变）
    const tagIndex = new Map();
    const regionIndex = new Map();
    const regionKey = (row) => (row.province ? [row.province, row.city || null, row.district || null] : null);
    for (const row of places) {
        for (const tag of tagsOf(row.category)) if (!tagIndex.has(tag)) tagIndex.set(tag, tagIndex.size);
        const region = regionKey(row);
        if (region) {
            const key = JSON.stringify(region);
            if (!regionIndex.has(key)) regionIndex.set(key, regionIndex.size);
        }
    }
    const dictionary = {
        v: FORMAT_VERSION,
        tags: [...tagIndex.keys()],
        regions: [...regionIndex.keys()].map((key) => JSON.parse(key))
    };

    const files = new Map();
    const put = (path, body) => {
        const json = JSON.stringify(body);
        const hash = hashOf(json);
        files.set(path, { hash, json });
        return hash;
    };
    const dictHash = put('dict', dictionary);

    const tiles = {};
    for (const level of AGGREGATE_LEVELS) {
        const byTile = new Map();
        const shift = 2 ** (level.cell - level.tile);
        for (const row of places) {
            const lng = Number(row.longitude);
            const lat = Number(row.latitude);
            const cxf = worldX(lng, level.cell);
            const cyf = worldY(lat, level.cell);
            const cx = tileIndex(cxf, level.cell);
            const cy = tileIndex(cyf, level.cell);
            const tx = Math.floor(cx / shift);
            const ty = Math.floor(cy / shift);
            const tileKey = `${tx}/${ty}`;
            if (!byTile.has(tileKey)) byTile.set(tileKey, new Map());
            const cells = byTile.get(tileKey);
            const cellKey = `${cx}/${cy}`;
            if (!cells.has(cellKey)) cells.set(cellKey, { cx, cy, sx: 0, sy: 0, rows: [] });
            const cell = cells.get(cellKey);
            cell.sx += cxf - cx;
            cell.sy += cyf - cy;
            const region = regionKey(row);
            const cost = Number(row.per_person_cost);
            cell.rows.push([
                tagsOf(row.category).map((tag) => tagIndex.get(tag)).sort((a, b) => a - b),
                Number.isFinite(cost) && cost > 0 ? Math.round(cost) : -1,
                region ? regionIndex.get(JSON.stringify(region)) : -1,
                glyphOf(row)
            ]);
        }
        tiles[level.tile] = {};
        for (const [tileKey, cells] of [...byTile.entries()].sort()) {
            const [tx, ty] = tileKey.split('/').map(Number);
            const body = {
                v: FORMAT_VERSION,
                z: level.tile,
                cell: level.cell,
                cells: [...cells.values()]
                    .sort((a, b) => a.cx - b.cx || a.cy - b.cy)
                    .map((cell) => {
                        const n = cell.rows.length;
                        const rowsSorted = cell.rows.map((r) => [r, JSON.stringify(r)]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([r]) => r);
                        return [cell.cx - tx * shift, cell.cy - ty * shift,
                            Math.min(7, Math.floor((cell.sx / n) * 8)), Math.min(7, Math.floor((cell.sy / n) * 8)), rowsSorted];
                    })
            };
            tiles[level.tile][tileKey] = put(`${level.tile}/${tileKey}`, body);
        }
    }

    // 明细瓦片
    const leafTiles = new Map();
    for (const row of places) {
        const key = `${tileIndex(worldX(Number(row.longitude), LEAF_LEVEL.tile), LEAF_LEVEL.tile)}/${tileIndex(worldY(Number(row.latitude), LEAF_LEVEL.tile), LEAF_LEVEL.tile)}`;
        if (!leafTiles.has(key)) leafTiles.set(key, []);
        leafTiles.get(key).push(row);
    }
    tiles[LEAF_LEVEL.tile] = {};
    for (const [tileKey, list] of [...leafTiles.entries()].sort()) {
        const body = {
            v: FORMAT_VERSION,
            z: LEAF_LEVEL.tile,
            fields: LEAF_FIELDS,
            rows: list.map((row) => LEAF_FIELDS.map((field) => (row[field] === undefined ? null : row[field])))
        };
        tiles[LEAF_LEVEL.tile][tileKey] = put(`${LEAF_LEVEL.tile}/${tileKey}`, body);
    }

    const manifestCore = {
        v: FORMAT_VERSION,
        levels: AGGREGATE_LEVELS,
        leaf: LEAF_LEVEL,
        dict: dictHash,
        tiles
    };
    const version = hashOf(JSON.stringify(manifestCore));
    return { version, manifest: { ...manifestCore, version, generated_at: now, count: places.length }, files };
}

// ---- 进程内缓存与压缩 ----

let cached = null;

function compressed(file, encoding) {
    if (!file.encoded) file.encoded = {};
    if (!file.encoded[encoding]) {
        const buffer = Buffer.from(file.json, 'utf8');
        file.encoded[encoding] = encoding === 'br'
            ? zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } })
            : encoding === 'gzip' ? zlib.gzipSync(buffer, { level: 7 }) : buffer;
    }
    return file.encoded[encoding];
}

/** 当前的全部瓦片。TTL 内复用；重建时内容没变的文件沿用旧的压缩结果，整体没变时连 generated_at 也不变 */
function tileSnapshot({ now = Date.now(), database = db._raw } = {}) {
    if (cached && now - cached.builtAt < ttlMs()) return cached;
    const built = buildTiles(readRows(database), now);
    if (cached && cached.version === built.version) {
        cached = { ...cached, builtAt: now };
        return cached;
    }
    if (cached) {
        for (const [path, file] of built.files) {
            const previous = cached.files.get(path);
            if (previous && previous.hash === file.hash) built.files.set(path, previous);
        }
    }
    const manifestJson = JSON.stringify(built.manifest);
    cached = { version: built.version, builtAt: now, manifest: built.manifest, manifestFile: { hash: built.version, json: manifestJson }, files: built.files };
    return cached;
}

function invalidateTileSnapshot() {
    if (cached) cached = { ...cached, builtAt: -Infinity };
}

// ---- 明细瓦片票据：登录住民的明细瓦片请求不带 Authorization 头（免得 App 里每块瓦片一次预检），
// 用这张短期票据认出账号，额度按账号算 ----

const TICKET_TTL_MS = 24 * 3600 * 1000;

function ticketKey() {
    const secret = process.env.TILE_TICKET_SECRET || process.env.JWT_SECRET || 'yuyuko_secret_key';
    return crypto.createHmac('sha256', String(secret)).update('place-tile-ticket').digest();
}

function signTicket(user, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ u: String(user.id), a: Number(user.admin_level) || 0, e: now + TICKET_TTL_MS })).toString('base64url');
    const mac = crypto.createHmac('sha256', ticketKey()).update(payload).digest('base64url').slice(0, 32);
    return { ticket: `${payload}.${mac}`, expires_at: now + TICKET_TTL_MS };
}

/** 票据有效时返回 { id, admin_level }，否则 null（按游客算） */
function verifyTicket(ticket, now = Date.now()) {
    const text = String(ticket || '');
    if (!text || text.length > 400) return null;
    const [payload, mac] = text.split('.');
    if (!payload || !mac) return null;
    const expected = crypto.createHmac('sha256', ticketKey()).update(payload).digest('base64url').slice(0, 32);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data || typeof data.u !== 'string' || !Number.isFinite(data.e) || data.e < now) return null;
        return { id: data.u, admin_level: Number(data.a) || 0 };
    } catch (_) {
        return null;
    }
}

module.exports = {
    AGGREGATE_LEVELS, LEAF_LEVEL, LEAF_FIELDS, GLYPH, FORMAT_VERSION,
    buildTiles, tileSnapshot, invalidateTileSnapshot, compressed, signTicket, verifyTicket,
    worldX, worldY
};
