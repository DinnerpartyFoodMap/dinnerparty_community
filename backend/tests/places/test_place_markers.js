// 地图标记快照与公共缓存（GET /places/markers、GET /places/overlay、http/middleware/publicCache.js）：
// 只含公开地点、按列存、预压缩与 304、CDN 可缓存的响应头（Access-Control-Allow-Origin: *、不按 Origin 变化），
// 出错时 no-store，非公共接口仍按 Origin 回 CORS；叠加层只给自己审核中的地点与屏蔽的住民的地点 id。
// 临时 SQLite + 本地 express；评价汇总的外部计算服务换成本地实现（同 test_place_duplicates.js）。npm run test:place-markers
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-markers-'));
Object.assign(process.env, { DB_FILE: path.join(temp, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', MARKER_SNAPSHOT_TTL_MS: '60000' });
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

require('../../infrastructure/numericAlgorithmClient').compute = async (_operation, input) => {
    const scores = new Map();
    for (const rating of input.ratings || []) {
        if (!scores.has(rating.place_id)) scores.set(rating.place_id, []);
        scores.get(rating.place_id).push(rating.score);
    }
    return {
        summaries: (input.place_ids || []).map((placeId) => {
            const list = scores.get(placeId) || [];
            const distribution = { 1: 0, 2: 0, 3: 0, 4: 0 };
            list.forEach((score) => { distribution[score] += 1; });
            const average = list.length ? list.reduce((sum, score) => sum + score, 0) / list.length : null;
            return { place_id: placeId, count: list.length, average, tier: average === null ? null : Math.round(average), distribution };
        })
    };
};
require('../../modules/ratings/services/ratingEstimateAdapter').ratingViews = async () => ({ estimates: [], predictions: [] });

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const { publicCache, skipForPublic } = require('../../http/middleware/publicCache');
const { jsonCompression } = require('../../http/middleware/jsonCompression');
const { invalidateMarkerSnapshot } = require('../../modules/places/services/placeMarkers');
const sql = db._raw;
let server = null;

const token = (id) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key')}`;

function decode(response, raw) {
    const encoding = response.headers['content-encoding'];
    if (encoding === 'br') return JSON.parse(zlib.brotliDecompressSync(raw).toString('utf8'));
    if (encoding === 'gzip') return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    return JSON.parse(raw.toString('utf8'));
}

async function main() {
    init();
    for (const id of ['owner', 'viewer', 'other']) sql.prepare('INSERT INTO User(id, username, password) VALUES(?, ?, ?)').run(id, id, 'unused');
    const insert = sql.prepare(`INSERT INTO Place(id, name, category, description, latitude, longitude, per_person_cost, creator_id, moderation_status)
        VALUES (?, ?, ?, '很长的描述', 23.1, ?, ?, ?, ?)`);
    insert.run(1, '鱼粥', '粥, 避雷', 113.1, 30, 'owner', 'visible');
    insert.run(2, '面馆', '面食', 113.2, null, 'other', 'visible');
    insert.run(3, '审核中', '甜品', 113.3, 20, 'owner', 'pending');
    insert.run(4, '没通过', '甜品', 113.4, 20, 'other', 'rejected');
    sql.prepare("INSERT INTO PlaceRegion(place_id, province, city, district, checked_at) VALUES (1, '广东省', '广州市', '番禺区', 0)").run();
    const ratings = require('../../modules/ratings/services/placeRatings');
    ratings.insertCreationRating(1, 'owner', 1, Date.now(), 'creation_default');
    ratings.insertCreationRating(2, 'other', 4, Date.now(), 'creation_default');

    const app = express();
    app.use(publicCache());
    app.use(skipForPublic(cors({ origin: true, credentials: true, maxAge: 3600 })));
    app.use(jsonCompression());
    app.get('/exhibitions', (req, res) => res.status(500).json({ error: '展会加载失败' }));
    app.use('/notices', require('../../modules/community/routes/notices'));
    app.use('/places', require('../../modules/places/routes/places'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    // 原始字节（fetch 会自动解压，这里要看压缩后的正文），headers 为小写键的对象
    const get = (url, headers = {}) => new Promise((resolve, reject) => {
        const request = http.request(base + url, { headers }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ response: { status: response.statusCode, headers: response.headers }, raw: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.end();
    });

    // ---- 快照：公共缓存头、只含公开地点、按列存 ----
    const { response: first, raw } = await get('/places/markers', { Origin: 'https://localhost', 'Accept-Encoding': 'br, gzip' });
    assert.equal(first.status, 200);
    assert.equal((first.headers['access-control-allow-origin'] ?? null), '*', 'App 与网页共用一份 CDN 缓存');
    assert.equal((first.headers['access-control-allow-credentials'] ?? null), null);
    assert.match((first.headers['cache-control'] ?? null), /^public, .*s-maxage=60/);
    assert.ok(!/origin/i.test((first.headers['vary'] ?? null) || ''), '响应不能按 Origin 变化');
    assert.match((first.headers['vary'] ?? null) || '', /Accept-Encoding/i);
    assert.equal((first.headers['content-encoding'] ?? null), 'br');
    const body = decode(first, raw);
    assert.equal(typeof body.version, 'string');
    assert.deepEqual(body.fields, ['id', 'name', 'category', 'longitude', 'latitude', 'per_person_cost', 'province', 'city', 'district', 'rating_count', 'rating_average', 'rating_negative_count']);
    assert.deepEqual(body.rows.map((row) => row[0]), [1, 2], '审核中、未通过的地点不进公共快照');
    const place1 = Object.fromEntries(body.fields.map((field, index) => [field, body.rows[0][index]]));
    assert.deepEqual(place1, { id: 1, name: '鱼粥', category: '粥, 避雷', longitude: 113.1, latitude: 23.1, per_person_cost: 30, province: '广东省', city: '广州市', district: '番禺区', rating_count: 1, rating_average: 1, rating_negative_count: 1 });
    assert.ok(!raw.includes('很长的描述') && !JSON.stringify(body).includes('很长的描述'), '描述等详情不在快照里');

    // gzip、不压缩与 br 内容相同；ETag 对得上时 304
    const gz = await get('/places/markers', { 'Accept-Encoding': 'gzip' });
    assert.equal((gz.response.headers['content-encoding'] ?? null), 'gzip');
    assert.deepEqual(decode(gz.response, gz.raw), body);
    const plain = await get('/places/markers', { 'Accept-Encoding': 'identity' });
    assert.equal((plain.response.headers['content-encoding'] ?? null), null);
    assert.deepEqual(decode(plain.response, plain.raw), body);
    const etag = (first.headers['etag'] ?? null);
    assert.match(etag, /^W\/"m-[0-9a-f]{16}"$/);
    assert.equal((gz.response.headers['etag'] ?? null), etag);
    const notModified = await get('/places/markers', { 'If-None-Match': etag, 'Accept-Encoding': 'br' });
    assert.equal(notModified.response.status, 304);
    assert.match((notModified.response.headers['cache-control'] ?? null), /^public/);

    // 内存缓存期内内容不变；作废后看到新地点，版本随内容变化
    insert.run(5, '新店', '烧烤', 113.5, 50, 'other', 'visible');
    assert.deepEqual(decode(...Object.values(await get('/places/markers'))).rows.map((row) => row[0]), [1, 2]);
    invalidateMarkerSnapshot();
    const refreshed = await get('/places/markers');
    const refreshedBody = decode(refreshed.response, refreshed.raw);
    assert.deepEqual(refreshedBody.rows.map((row) => row[0]), [1, 2, 5]);
    assert.notEqual(refreshedBody.version, body.version);
    assert.notEqual((refreshed.response.headers['etag'] ?? null), etag);
    invalidateMarkerSnapshot();
    const same = decode(...Object.values(await get('/places/markers')));
    assert.equal(same.version, refreshedBody.version, '内容不变时版本不变');

    // ---- 其他公共接口：同样的头；出错 no-store ----
    const notice = await fetch(`${base}/notices/current`, { headers: { Origin: 'https://www.dinnerparty.cc' } });
    assert.equal(notice.headers.get('access-control-allow-origin'), '*');
    assert.match(notice.headers.get('cache-control'), /^public, max-age=30, s-maxage=60/);
    const failed = await fetch(`${base}/exhibitions`, { headers: { Origin: 'https://localhost' } });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('cache-control'), 'no-store', 'CDN 不缓存出错的响应');
    const query = await fetch(`${base}/notices/current?fresh=1`);
    assert.match(query.headers.get('cache-control'), /^public/, '一次性参数只改缓存键，仍是公共接口');

    // 预检与非公共接口照旧按 Origin 回 CORS
    const preflight = await fetch(`${base}/places/markers`, { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    const nearby = await fetch(`${base}/places/nearby?minLng=113&minLat=23&maxLng=114&maxLat=24`, { headers: { Origin: 'https://localhost' } });
    assert.equal(nearby.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(nearby.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await nearby.json()).map((place) => place.id).sort(), [1, 2, 5], '旧版 App 的附近接口不变');

    // ---- 个人叠加层 ----
    const overlay = async (who) => {
        const response = await fetch(`${base}/places/overlay`, { headers: who ? { Authorization: token(who) } : {} });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.json();
    };
    assert.deepEqual(await overlay(null), { own: [], hidden_ids: [] });
    const own = await overlay('owner');
    assert.deepEqual(own.own.map((place) => place.id), [3], '只有自己审核中 / 未通过的地点');
    assert.equal(own.own[0].description, '很长的描述', '叠加层是完整的地点');
    assert.equal(own.own[0].moderation_status, 'pending');
    assert.deepEqual((await overlay('other')).own.map((place) => place.id), [4]);
    assert.deepEqual((await overlay('viewer')).hidden_ids, []);
    require('../../modules/accounts/services/userRelations').setBlocked('viewer', 'other', true);
    assert.deepEqual((await overlay('viewer')).hidden_ids, [2, 5], '屏蔽的住民创建的公开地点');
    const invalid = await fetch(`${base}/places/overlay`, { headers: { Authorization: 'Bearer broken' } });
    assert.deepEqual(await invalid.json(), { own: [], hidden_ids: [] }, '无效 token 按游客');

    console.log('Place markers passed: public snapshot fields and visibility, br/gzip/identity, ETag 304, memory cache, public cache headers, error no-store, CORS for other routes, overlay.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
