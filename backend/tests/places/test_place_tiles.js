// 地图标记分层瓦片（services/placeTiles.js、routes/placeTiles.js）与防爬第 1 阶段的路由改动：
// 聚合瓦片不带 id / 店名 / 单店坐标且各级店数守恒；只含公开地点；字典与匿名行能还原筛选字段；
// 清单与聚合瓦片的公共缓存头、内容哈希跳转、404；明细瓦片 private、按 IP / 票据限流及日志归属；
// 改一家店只换它所在的几块瓦片；GET /places 停用、旧版地图的完整地点范围与快照开关。
// 临时 SQLite + 本地 express；评价汇总的外部计算换成本地实现（同 test_place_markers.js）。npm run test:place-tiles
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-tiles-'));
Object.assign(process.env, {
    DB_FILE: path.join(temp, 'test.sqlite'),
    LOG_DIR: path.join(temp, 'logs'), LOG_LEVEL: 'info', LOG_TO_FILE: 'true', LOG_TO_CONSOLE: 'false',
    LOG_NOISY_PATH_PREFIXES: '/unused-test-prefix',
    TILE_SNAPSHOT_TTL_MS: '60000', ANTI_SCRAPE_MODE: 'observe'
});
delete process.env.ANTI_SCRAPE_LIMITS;
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
const logger = require('../../infrastructure/logger');
const { db, init } = require('../../infrastructure/database');
const { publicCache, skipForPublic } = require('../../http/middleware/publicCache');
const { jsonCompression } = require('../../http/middleware/jsonCompression');
const { requestLogger } = require('../../http/middleware/requestLogger');
const placeTiles = require('../../modules/places/services/placeTiles');
const { resetForTesting } = require('../../http/middleware/rateLimit');
const sql = db._raw;
let server = null;

const bearer = (id) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key')}`;

async function main() {
    init();
    for (const id of ['owner', 'viewer', 'other']) sql.prepare('INSERT INTO User(id, username, password) VALUES(?, ?, ?)').run(id, id, 'unused');
    const insert = sql.prepare(`INSERT INTO Place(id, name, category, description, latitude, longitude, per_person_cost, creator_id, moderation_status)
        VALUES (?, ?, ?, '很长的描述', ?, ?, ?, ?, ?)`);
    insert.run(1, '鱼粥', '粥, 避雷', 23.1291, 113.2644, 30, 'owner', 'visible');
    insert.run(2, '面馆', '面食，小吃', 23.1295, 113.2650, null, 'other', 'visible');
    insert.run(3, '甜品铺', '甜品, 待探索', 23.1301, 113.2702, 25, 'other', 'visible');
    insert.run(4, '审核中', '甜品', 23.1302, 113.2703, 20, 'owner', 'pending');
    insert.run(5, '没通过', '甜品', 23.1303, 113.2704, 20, 'other', 'rejected');
    insert.run(1048577, '北京烤鸭', '烤鸭', 39.9042, 116.4074, 120, 'other', 'visible');
    sql.prepare("INSERT INTO PlaceRegion(place_id, province, city, district, checked_at) VALUES (1, '广东省', '广州市', '越秀区', 0)").run();
    sql.prepare("INSERT INTO PlaceRegion(place_id, province, city, district, checked_at) VALUES (2, '广东省', '广州市', '越秀区', 0)").run();
    const ratings = require('../../modules/ratings/services/placeRatings');
    ratings.insertCreationRating(1, 'owner', 1, Date.now(), 'creation_default');
    ratings.insertCreationRating(2, 'other', 4, Date.now(), 'creation_default');

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(requestLogger);
    app.use(publicCache());
    app.use(skipForPublic(cors({ origin: true, credentials: true, maxAge: 3600 })));
    app.use(jsonCompression());
    app.use('/places/tiles', require('../../modules/places/routes/placeTiles'));
    app.use('/places', require('../../modules/places/routes/places'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (url, headers = {}) => fetch(base + url, { headers, redirect: 'manual' });

    // ---- 清单：公共缓存、四级瓦片 ----
    const manifestResponse = await get('/places/tiles/manifest', { Origin: 'https://localhost' });
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('access-control-allow-origin'), '*');
    assert.match(manifestResponse.headers.get('cache-control'), /^public, max-age=30, s-maxage=60/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.count, 4, '只算公开地点');
    assert.deepEqual(Object.keys(manifest.tiles).sort(), ['12', '2', '5', '8']);
    assert.ok(!JSON.stringify(manifest).includes('鱼粥'));

    // ---- 字典与聚合瓦片：公共、永不过期、不带 id / 店名 / 坐标 ----
    const dictResponse = await get(`/places/tiles/${manifest.dict}/dict`);
    assert.equal(dictResponse.status, 200);
    assert.match(dictResponse.headers.get('cache-control'), /^public, max-age=31536000, s-maxage=31536000, immutable/);
    const dict = await dictResponse.json();
    assert.deepEqual(dict.tags, ['粥', '避雷', '面食', '小吃', '甜品', '待探索', '烤鸭'], '按 id 顺序第一次出现编号，全角逗号也拆开');
    assert.deepEqual(dict.regions, [['广东省', '广州市', '越秀区']]);

    const readAggregate = async (z) => {
        const out = [];
        for (const [key, hash] of Object.entries(manifest.tiles[z])) {
            const response = await get(`/places/tiles/${hash}/${z}/${key}`, { Origin: 'https://localhost' });
            assert.equal(response.status, 200);
            assert.match(response.headers.get('cache-control'), /immutable/);
            assert.equal(response.headers.get('access-control-allow-origin'), '*');
            const text = await response.text();
            for (const secret of ['鱼粥', '面馆', '1048577', '113.26', '很长的描述', '审核中']) assert.ok(!text.includes(secret), `聚合瓦片不带 ${secret}`);
            out.push(JSON.parse(text));
        }
        return out;
    };
    for (const level of placeTiles.AGGREGATE_LEVELS) {
        const bodies = await readAggregate(level.tile);
        const rows = bodies.flatMap((body) => body.cells.flatMap((cell) => cell[4]));
        assert.equal(rows.length, 4, `z${level.tile} 各级店数守恒`);
        for (const body of bodies) for (const cell of body.cells) {
            assert.ok(cell[2] >= 0 && cell[2] <= 7 && cell[3] >= 0 && cell[3] <= 7, '重心取整到 1/8 格');
            assert.ok(cell[0] >= 0 && cell[0] < 2 ** (level.cell - level.tile));
            assert.equal(level.sub, 16, '每一级都带 1/16 小格');
            assert.equal(body.sub, level.sub);
            for (const row of cell[4]) {
                assert.ok(row.length === 5 && Number.isInteger(row[4]) && row[4] >= 0 && row[4] < level.sub ** 2, '行带 1/16 小格编号');
            }
        }
        // 匿名行能还原筛选字段：标签、人均、地区、图标类型
        const decoded = rows.map(([tags, cost, region, glyph]) => ({
            tags: tags.map((i) => dict.tags[i]).sort().join(','), cost, region: region >= 0 ? dict.regions[region].join('/') : null, glyph
        })).sort((a, b) => a.tags.localeCompare(b.tags));
        assert.deepEqual(decoded, [
            { tags: '小吃,面食', cost: -1, region: '广东省/广州市/越秀区', glyph: placeTiles.GLYPH.place },
            { tags: '待探索,甜品', cost: 25, region: null, glyph: placeTiles.GLYPH.unexplored },
            { tags: '烤鸭', cost: 120, region: null, glyph: placeTiles.GLYPH.place },
            { tags: '粥,避雷', cost: 30, region: '广东省/广州市/越秀区', glyph: placeTiles.GLYPH.avoid }
        ].sort((a, b) => a.tags.localeCompare(b.tags)));
    }
    // 城市级（z14 格约 2 km）：广州三家、北京一家分在不同瓦片
    assert.equal(Object.keys(manifest.tiles[8]).length, 2);

    // ---- 与前端对照：frontend/src/map/markerTiles.js 读这些瓦片得到同样的点，筛选照常生效 ----
    const { pathToFileURL } = require('node:url');
    const front = await import(pathToFileURL(path.join(__dirname, '../../../frontend/src/map/markerTiles.js')).href);
    const { matchesPlaceFilter, normalizePlaceFilter } = await import(pathToFileURL(path.join(__dirname, '../../../frontend/src/places/placeFilter.js')).href);
    assert.deepEqual(front.bandForZoom(manifest, 12), { kind: 'aggregate', ...placeTiles.AGGREGATE_LEVELS[2] });
    assert.equal(front.bandForZoom(manifest, 13).kind, 'leaf');
    const gzCity = front.tileOf(113.2644, 23.1291, 8).join('/');
    assert.ok(manifest.tiles[8][gzCity], '前后端的瓦片坐标一致');
    const cityBody = await (await get(`/places/tiles/${manifest.tiles[8][gzCity]}/8/${gzCity}`)).json();
    const anonymous = front.expandAggregateTile(cityBody, dict, gzCity);
    assert.equal(anonymous.length, 3);
    assert.ok(anonymous.every((p) => p.aggregate && p.name === '' && p.id === undefined));
    for (const point of anonymous) {
        assert.ok(Math.abs(point.longitude - 113.267) < 0.03 && Math.abs(point.latitude - 23.13) < 0.03, '匿名点落在格子里');
    }
    // 匿名点在店所在的 1/16 小格（z18 瓦片）中心：与三家公开店的小格一一对应，但不是精确坐标
    const subTile = (lng, lat) => front.tileOf(lng, lat, 18).join('/');
    assert.deepEqual(anonymous.map((p) => subTile(p.longitude, p.latitude)).sort(),
        [[113.2644, 23.1291], [113.2650, 23.1295], [113.2702, 23.1301]].map(([lng, lat]) => subTile(lng, lat)).sort());
    assert.ok(anonymous.every((p) => p.aggregateCell[3] === 18));
    for (const point of anonymous) {
        const [x, y] = front.tileOf(point.longitude, point.latitude, 18);
        assert.ok(Math.abs(front.worldX(point.longitude, 18) - x - 0.5) < 1e-6 && Math.abs(front.worldY(point.latitude, 18) - y - 0.5) < 1e-6, '坐标取小格中心');
    }
    // 粗两级同样画在小格中心（z9 格 → z13，z12 格 → z16），不是全格的重心：筛选后只剩一家时也画在店附近
    for (const level of placeTiles.AGGREGATE_LEVELS.slice(0, 2)) {
        const subZoom = level.cell + Math.log2(level.sub);
        const key = front.tileOf(113.2644, 23.1291, level.tile).join('/');
        const body = await (await get(`/places/tiles/${manifest.tiles[level.tile][key]}/${level.tile}/${key}`)).json();
        // z2 瓦片很大，也包含别的城市的测试店，只看广州这几家
        const points = front.expandAggregateTile(body, dict, key).filter((p) => Math.abs(p.longitude - 113.27) < 1);
        const at = (lng, lat) => front.tileOf(lng, lat, subZoom).join('/');
        assert.deepEqual(points.map((p) => at(p.longitude, p.latitude)).sort(),
            [[113.2644, 23.1291], [113.2650, 23.1295], [113.2702, 23.1301]].map(([lng, lat]) => at(lng, lat)).sort(), `z${level.cell} 格的点在店所在的 z${subZoom} 小格`);
        assert.ok(points.every((p) => p.aggregateCell[3] === subZoom));
    }
    const matching = (raw) => anonymous.filter((p) => matchesPlaceFilter(p, normalizePlaceFilter(raw))).length;
    assert.equal(matching({ tags: ['甜品'] }), 1);
    assert.equal(matching({ excludeTags: ['避雷'] }), 2);
    assert.equal(matching({ minCost: 20, maxCost: 40 }), 2);
    assert.equal(matching({ province: '广东省', city: '广州市', district: '越秀区' }), 2);
    assert.deepEqual(anonymous.map((p) => p.glyph).sort(), ['avoid', 'place', 'unexplored']);

    // ---- 明细瓦片：带店名和坐标，private，按 CORS 回 Origin ----
    const leafKeys = Object.keys(manifest.tiles[12]);
    assert.equal(leafKeys.length, 2);
    const gzKey = leafKeys.find((key) => Number(key.split('/')[0]) < 3340);
    const leaf = await get(`/places/tiles/${manifest.tiles[12][gzKey]}/12/${gzKey}`, { Origin: 'https://localhost' });
    assert.equal(leaf.status, 200);
    assert.equal(leaf.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(leaf.headers.get('access-control-allow-origin'), 'https://localhost', '明细瓦片不走公共缓存');
    const leafBody = await leaf.json();
    assert.deepEqual(leafBody.fields, placeTiles.LEAF_FIELDS);
    assert.deepEqual(leafBody.rows.map((row) => row[0]), [1, 2, 3]);
    const first = Object.fromEntries(leafBody.fields.map((field, i) => [field, leafBody.rows[0][i]]));
    assert.equal(first.name, '鱼粥');
    assert.equal(first.rating_average, 1);
    assert.ok(!JSON.stringify(leafBody).includes('很长的描述'), '描述等详情不在瓦片里');
    // fetch 带 If-None-Match 时会自动加 Cache-Control: no-cache，这里用原始 http 请求
    const etag = leaf.headers.get('etag');
    const conditional = await new Promise((resolve, reject) => {
        const request = require('node:http').request(`${base}/places/tiles/${manifest.tiles[12][gzKey]}/12/${gzKey}`, { headers: { 'If-None-Match': etag } }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end();
    });
    assert.equal(conditional, 304);

    // ---- 哈希对不上：302 到当前哈希（相对地址，保留票据参数）；没有的瓦片 404 ----
    const stale = await get(`/places/tiles/000000000000/12/${gzKey}?t=abc`);
    assert.equal(stale.status, 302);
    assert.equal(stale.headers.get('location'), `../../../${manifest.tiles[12][gzKey]}/12/${gzKey}?t=abc`);
    assert.equal(stale.headers.get('cache-control'), 'no-store');
    const staleDict = await get('/places/tiles/000000000000/dict');
    assert.equal(staleDict.status, 302);
    assert.equal(staleDict.headers.get('location'), `../${manifest.dict}/dict`);
    const missing = await get(`/places/tiles/${manifest.tiles[12][gzKey]}/12/1/1`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal((await get(`/places/tiles/${manifest.dict}/11/1/1`)).status, 404, '不是约定的级别');

    // ---- 明细瓦片限流：游客按 IP，票据认出账号；票据坏了按游客 ----
    process.env.ANTI_SCRAPE_MODE = 'enforce';
    process.env.ANTI_SCRAPE_LIMITS = JSON.stringify({ tiles: { guest: [{ distinct: true, limit: 1, per: 'day' }], user: [{ distinct: true, limit: 2, per: 'day' }] } });
    resetForTesting();
    const leafUrl = (key, query = '') => `/places/tiles/${manifest.tiles[12][key]}/12/${key}${query}`;
    const [keyA, keyB] = leafKeys;
    const guestHeaders = { 'X-Forwarded-For': '192.0.2.5' };
    assert.equal((await get(leafUrl(keyA), guestHeaders)).status, 200);
    assert.equal((await get(leafUrl(keyA), guestHeaders)).status, 200, '同一块再拉不扣额度');
    const guestLimited = await get(leafUrl(keyB), guestHeaders);
    assert.equal(guestLimited.status, 429);
    assert.equal((await guestLimited.json()).code, 'rate_limited');
    const ticketResponse = await get('/places/tiles/ticket', { Authorization: bearer('viewer') });
    assert.equal(ticketResponse.status, 200);
    assert.equal(ticketResponse.headers.get('cache-control'), 'no-store');
    const { ticket, expires_at } = await ticketResponse.json();
    assert.ok(expires_at > Date.now());
    assert.equal((await get('/places/tiles/ticket')).status, 401, '票据要登录');
    const ticketQuery = `?t=${encodeURIComponent(ticket)}`;
    assert.equal((await get(leafUrl(keyB, ticketQuery), guestHeaders)).status, 200, '票据按账号计额度');
    assert.equal((await get(leafUrl(keyB, ticketQuery), guestHeaders)).status, 200);
    assert.equal((await get(leafUrl(keyB, `?t=${encodeURIComponent(ticket)}x`), guestHeaders)).status, 429, '票据被改过按游客');
    assert.equal(placeTiles.verifyTicket(ticket).id, 'viewer');
    assert.equal(placeTiles.verifyTicket(ticket, expires_at + 1), null, '过期的票据无效');
    // 聚合瓦片不限流
    for (let i = 0; i < 3; i += 1) assert.equal((await get(`/places/tiles/${manifest.tiles[8][Object.keys(manifest.tiles[8])[0]]}/8/${Object.keys(manifest.tiles[8])[0]}`, guestHeaders)).status, 200);

    // 观察模式记录撞线，两个明细瓦片请求都成功。
    process.env.ANTI_SCRAPE_MODE = 'observe';
    resetForTesting();
    const observingHeaders = { 'X-Forwarded-For': '198.51.100.5' };
    assert.equal((await get(leafUrl(keyA), observingHeaders)).status, 200);
    assert.equal((await get(leafUrl(keyB), observingHeaders)).status, 200);

    // 读取实际请求日志，核对票据归属、瓦片去重、撞线和按用户查询。
    await logger.flush();
    const reportScript = path.join(__dirname, '../../scripts/diagnostics/scrape_report.js');
    const runReport = (...subjectArgs) => JSON.parse(execFileSync(process.execPath,
        [reportScript, '--since', '1h', '--json', ...subjectArgs],
        { encoding: 'utf8', env: { ...process.env, LOG_TO_FILE: 'false' } }));
    const { topTiles } = runReport();
    for (const [subject, expected] of [
        ['u:viewer', { requests: 2, tiles: 1, limited: 0, wouldLimit: 0 }],
        ['ip:192.0.2.0/24', { requests: 4, tiles: 2, limited: 1, wouldLimit: 0 }],
        ['ip:198.51.100.0/24', { requests: 2, tiles: 2, limited: 0, wouldLimit: 1 }]
    ]) {
        const row = topTiles.find((entry) => entry.subject === subject);
        assert.ok(row, `报表缺少主体 ${subject}`);
        const { requests, tiles, limited, wouldLimit } = row;
        assert.deepEqual({ requests, tiles, limited, wouldLimit }, expected, subject);
    }
    const viewerReport = runReport('--user-id', 'viewer');
    assert.deepEqual(viewerReport.ips, ['192.0.2.5']);
    assert.equal(viewerReport.days.reduce((total, day) => total + day.requests, 0), 2);
    assert.ok(viewerReport.days.every((day) => day.tiles === 1), '同一账户同一天重复读取同一块只记一块');

    delete process.env.ANTI_SCRAPE_LIMITS;
    resetForTesting();

    // ---- 内容寻址：新增一家店只换它所在的瓦片（每级一块）和字典 ----
    insert.run(7, '新粥铺', '粥', 23.1292, 113.2645, 18, 'owner', 'visible');
    placeTiles.invalidateTileSnapshot();
    const next = await (await get('/places/tiles/manifest')).json();
    assert.notEqual(next.version, manifest.version);
    let changed = 0;
    for (const z of Object.keys(manifest.tiles)) {
        for (const [key, hash] of Object.entries(manifest.tiles[z])) if (next.tiles[z][key] !== hash) changed += 1;
    }
    assert.equal(changed, 4, '只有广州那一片的四块瓦片变了');
    assert.equal(next.dict, manifest.dict, '没有新标签，字典不变');
    placeTiles.invalidateTileSnapshot();
    assert.equal((await (await get('/places/tiles/manifest')).json()).generated_at, next.generated_at, '内容不变时清单不变');

    // ---- GET /places 停用；旧版地图的大 / 小范围查询和快照继续可用 ----
    const root = await get('/places');
    assert.equal(root.status, 410);
    process.env.NEARBY_LARGE_AREA_ROWS = '2';
    const wideUrl = '/places/nearby?minLng=100&minLat=20&maxLng=120&maxLat=40&viewMinLng=113&viewMinLat=22.8&viewMaxLng=113.8&viewMaxLat=23.5';
    const wide = await get(wideUrl);
    assert.equal(wide.status, 200);
    assert.equal(wide.headers.get('cache-control'), 'no-store');
    const large = await wide.json();
    assert.deepEqual(large.map((place) => place.id).sort((a, b) => a - b), [1, 2, 3, 7, 1048577], '旧版客户端把成功响应视为整个请求范围内的完整地点集合');
    assert.equal(large.find((place) => place.id === 3).description, '很长的描述', '旧版点位卡片直接使用附近响应里的详情');
    assert.equal(large.find((place) => place.id === 3).creator_name, 'other');
    const small = await (await get('/places/nearby?minLng=113.2&minLat=23.1&maxLng=113.3&maxLat=23.2')).json();
    assert.deepEqual(small.map((place) => place.id).sort((a, b) => a - b), [1, 2, 3, 7], '小范围照旧给完整行');
    assert.equal(small.find((place) => place.id === 1).description, '很长的描述');
    delete process.env.NEARBY_LARGE_AREA_ROWS;
    process.env.LEGACY_MARKER_SNAPSHOT = 'off';
    const legacy = await get('/places/markers');
    assert.equal(legacy.status, 410);
    assert.equal(legacy.headers.get('cache-control'), 'no-store');
    delete process.env.LEGACY_MARKER_SNAPSHOT;
    assert.equal((await get('/places/markers')).status, 200, '默认仍给旧版 App');

    // ---- 单店接口按去重地点数限流 ----
    process.env.ANTI_SCRAPE_MODE = 'enforce';
    process.env.ANTI_SCRAPE_LIMITS = JSON.stringify({ detail: { guest: [{ distinct: true, limit: 1, per: 'day' }], user: [{ distinct: true, limit: 5, per: 'day' }] } });
    resetForTesting();
    const detailHeaders = { 'X-Forwarded-For': '192.0.2.77' };
    assert.equal((await get('/places/1', detailHeaders)).status, 200);
    assert.equal((await get('/places/1', detailHeaders)).status, 200);
    assert.equal((await get('/places/2', detailHeaders)).status, 429);
    assert.equal((await get('/places/2', { ...detailHeaders, Authorization: bearer('viewer') })).status, 200, '登录后按账号');

    process.env.ANTI_SCRAPE_LIMITS = JSON.stringify({ legacy: { guest: [{ limit: 1, per: 3600 }] } });
    resetForTesting();
    assert.equal((await get(wideUrl, detailHeaders)).status, 200);
    const limitedNearby = await get(wideUrl, detailHeaders);
    assert.equal(limitedNearby.status, 429, '旧版附近接口在 enforce 模式下仍限流');
    assert.equal(limitedNearby.headers.get('cache-control'), 'no-store');
    assert.ok(Number(limitedNearby.headers.get('retry-after')) > 0);

    console.log('Place tiles passed: aggregate tiles without ids/names (every level with 1/16 sub-cells), counts per level, dictionary and anonymous rows, public/private cache headers, hash redirects and 404, leaf limits with tickets, content-addressed changes, /places 410, complete legacy nearby responses, legacy snapshot switch, legacy and detail limits.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    delete process.env.ANTI_SCRAPE_LIMITS;
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await logger.flush();
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
