// 地图标记分层瓦片（src/map/markerTiles.js）：瓦片坐标、按缩放选级、聚合瓦片展开成匿名点（筛选照常生效）、
// 明细瓦片、清单 / 字典 / 瓦片的请求（公共请求不带任何头，明细带票据）、额度用完（429）、预取的限制、
// 换级时等瓦片到齐再切、明细缺块用城市级聚合顶上、个人叠加与本地修改。后端格式见 backend placeTiles.js，
// 两边的对照在 backend 的 test_place_tiles.js。npm run test:map
import assert from 'node:assert/strict';
import {
    tileOf, lngOf, latOf, worldX, worldY, tileKeysForBounds, bandForZoom, nextBandZoom,
    expandAggregateTile, expandLeafTile, MarkerTileSource, MarkerTileStore, PREFETCH
} from '../../../src/map/markerTiles.js';
import { placeKey } from '../../../src/map/cluster/engine.js';
import { matchesPlaceFilter, normalizePlaceFilter } from '../../../src/places/placeFilter.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LEVELS = [
    { tile: 2, cell: 9, minZoom: 0, maxZoom: 7 },
    { tile: 5, cell: 12, minZoom: 8, maxZoom: 10 },
    { tile: 8, cell: 14, minZoom: 11, maxZoom: 12 }
];
const LEAF = { tile: 12, minZoom: 13 };

// ---- 瓦片坐标 ----
{
    const [x, y] = tileOf(113.2644, 23.1291, 12);
    assert.ok(Math.abs(lngOf(x + 0.5, 12) - 113.2644) < 0.1 && Math.abs(latOf(y + 0.5, 12) - 23.1291) < 0.1);
    assert.ok(Math.abs(lngOf(worldX(113.2644, 14), 14) - 113.2644) < 1e-9, '经度往返');
    assert.ok(Math.abs(latOf(worldY(23.1291, 14), 14) - 23.1291) < 1e-9, '纬度往返');
    const keys = tileKeysForBounds({ minLng: 113.2, maxLng: 113.4, minLat: 23.0, maxLat: 23.2 }, 12);
    assert.ok(keys.length >= 6 && keys.length <= 16);
    const [cx0, cy0] = tileOf(113.3, 23.1, 12);
    const [fx, fy] = keys[0].split('/').map(Number);
    assert.ok(Math.abs(fx - cx0) <= 1 && Math.abs(fy - cy0) <= 1, '离中心近的块排在前面');
    assert.equal(tileKeysForBounds({ minLng: -180, maxLng: 180, minLat: -85, maxLat: 85 }, 12).length, 48, '一级最多取 48 块');
    const manifest = { levels: LEVELS, leaf: LEAF };
    assert.deepEqual(bandForZoom(manifest, 5), { kind: 'aggregate', ...LEVELS[0] });
    assert.deepEqual(bandForZoom(manifest, 9), { kind: 'aggregate', ...LEVELS[1] });
    assert.deepEqual(bandForZoom(manifest, 12), { kind: 'aggregate', ...LEVELS[2] });
    assert.deepEqual(bandForZoom(manifest, 13), { kind: 'leaf', ...LEAF });
    assert.equal(bandForZoom(null, 13), null);
    assert.equal(nextBandZoom(manifest, 6.4), 8);
    assert.equal(nextBandZoom(manifest, 11.2), 13);
    assert.equal(nextBandZoom(manifest, 14), 16, '已在明细级：再放大两级');
}

// ---- 测试数据：两家在广州（同一块 z12），一家在北京 ----
const dict = { v: 1, tags: ['粥', '避雷', '面食', '小吃', '烤鸭'], regions: [['广东省', '广州市', '越秀区']] };
const places = [
    { id: 1, name: '鱼粥', category: '粥, 避雷', longitude: 113.2644, latitude: 23.1291, per_person_cost: 30, region: 0, tags: [0, 1], glyph: 1 },
    { id: 2, name: '面馆', category: '面食，小吃', longitude: 113.2650, latitude: 23.1295, per_person_cost: null, region: 0, tags: [2, 3], glyph: 0 },
    { id: 1048577, name: '北京烤鸭', category: '烤鸭', longitude: 116.4074, latitude: 39.9042, per_person_cost: 120, region: -1, tags: [4], glyph: 0 }
];
function aggregateBody(level, tileKey) {
    const [tx, ty] = tileKey.split('/').map(Number);
    const shift = 2 ** (level.cell - level.tile);
    const cells = new Map();
    for (const p of places) {
        const [cx, cy] = tileOf(p.longitude, p.latitude, level.cell);
        if (Math.floor(cx / shift) !== tx || Math.floor(cy / shift) !== ty) continue;
        const key = `${cx}/${cy}`;
        if (!cells.has(key)) cells.set(key, [cx - tx * shift, cy - ty * shift, 3, 4, []]);
        cells.get(key)[4].push([p.tags, p.per_person_cost ?? -1, p.region, p.glyph]);
    }
    return { v: 1, z: level.tile, cell: level.cell, cells: [...cells.values()] };
}
const LEAF_FIELDS = ['id', 'name', 'category', 'longitude', 'latitude', 'per_person_cost', 'province', 'city', 'district', 'rating_count', 'rating_average', 'rating_negative_count'];
function leafBody(tileKey) {
    const rows = places.filter((p) => tileOf(p.longitude, p.latitude, 12).join('/') === tileKey)
        .map((p) => [p.id, p.name, p.category, p.longitude, p.latitude, p.per_person_cost, p.region >= 0 ? '广东省' : null, p.region >= 0 ? '广州市' : null, p.region >= 0 ? '越秀区' : null, 1, p.glyph ? 1 : 4, p.glyph ? 1 : 0]);
    return { v: 1, z: 12, fields: LEAF_FIELDS, rows };
}
const tiles = {};
const bodies = new Map();
let hashSeq = 0;
for (const level of [...LEVELS, LEAF]) {
    tiles[level.tile] = {};
    for (const p of places) {
        const key = tileOf(p.longitude, p.latitude, level.tile).join('/');
        if (tiles[level.tile][key]) continue;
        const hash = String(++hashSeq).padStart(12, '0');
        tiles[level.tile][key] = hash;
        bodies.set(`${hash}/${level.tile}/${key}`, level.tile === 12 ? leafBody(key) : aggregateBody(level, key));
    }
}
const manifest = { v: 1, version: 'm1', generated_at: 1, levels: LEVELS, leaf: LEAF, dict: 'dddddddddddd', tiles, count: 3 };
const gzLeafKey = tileOf(113.2644, 23.1291, 12).join('/');
const gzCityKey = tileOf(113.2644, 23.1291, 8).join('/');

// ---- 展开：聚合瓦片 → 匿名点；明细瓦片 → 地点 ----
{
    const anon = expandAggregateTile(aggregateBody(LEVELS[2], gzCityKey), dict, gzCityKey);
    assert.equal(anon.length, 2);
    for (const point of anon) {
        assert.equal(point.aggregate, true);
        assert.equal(point.name, '', '匿名点没有店名');
        assert.equal(point.id, undefined, '匿名点没有 id');
        assert.match(placeKey(point), /^agg:14\/\d+\/\d+#\d$/);
        assert.equal(tileOf(point.longitude, point.latitude, 14).join('/'), point.aggregateCell.slice(1).join('/'), '坐标落在自己的格子里');
    }
    const byTags = Object.fromEntries(anon.map((p) => [p.category, p]));
    assert.deepEqual(Object.keys(byTags).sort(), ['粥,避雷', '面食,小吃'].sort());
    assert.equal(byTags['粥,避雷'].glyph, 'avoid');
    assert.equal(byTags['粥,避雷'].per_person_cost, 30);
    assert.equal(byTags['面食,小吃'].per_person_cost, null);
    assert.equal(byTags['粥,避雷'].province, '广东省');
    // 筛选照常作用在匿名点上
    const filter = (raw) => normalizePlaceFilter(raw);
    assert.equal(anon.filter((p) => matchesPlaceFilter(p, filter({ tags: ['小吃'] }))).length, 1);
    assert.equal(anon.filter((p) => matchesPlaceFilter(p, filter({ excludeTags: ['避雷'] }))).length, 1);
    assert.equal(anon.filter((p) => matchesPlaceFilter(p, filter({ minCost: 20 }))).length, 1, '没填人均的设了范围就不显示');
    assert.equal(anon.filter((p) => matchesPlaceFilter(p, filter({ province: '广东省', city: '广州市' }))).length, 2);
    assert.equal(expandAggregateTile(null, dict, '0/0').length, 0);
    const leaf = expandLeafTile(leafBody(gzLeafKey));
    assert.deepEqual(leaf.map((p) => p.id), [1, 2]);
    assert.equal(leaf[0].marker_only, true);
    assert.equal(leaf[0].name, '鱼粥');
    assert.equal(placeKey(leaf[0]), 'place:1');
}

// ---- 数据源：请求、缓存、票据、429、预取 ----
function fakeServer({ leafStatus = 200 } = {}) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        const u = new URL(url);
        calls.push({ path: u.pathname, query: u.search, options });
        const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => data });
        if (u.pathname === '/places/tiles/manifest') return json(manifest);
        if (u.pathname === `/places/tiles/${manifest.dict}/dict`) return json(dict);
        if (u.pathname === '/places/tiles/ticket') return json({ ticket: 'tk-1', expires_at: 10 ** 13 });
        const match = u.pathname.match(/^\/places\/tiles\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/);
        if (match) {
            if (match[2] === '12' && leafStatus !== 200) return json({ code: 'rate_limited', retry_after: 60, guest: true }, leafStatus);
            const body = bodies.get(`${match[1]}/${match[2]}/${match[3]}/${match[4]}`);
            return body ? json(body) : json({ error: 'missing' }, 404);
        }
        return json({}, 404);
    };
    return { calls, fetchImpl };
}

{
    const server = fakeServer();
    const stored = new Map();
    const source = new MarkerTileSource({
        backendUrl: 'https://example.test', fetchImpl: server.fetchImpl,
        readStored: async (key) => stored.get(key) ?? null, writeStored: async (key, value) => { stored.set(key, value); }
    });
    await source.start();
    assert.ok(source.hasData);
    assert.deepEqual(server.calls.map((c) => c.path), ['/places/tiles/manifest', `/places/tiles/${manifest.dict}/dict`]);
    assert.ok(server.calls.every((c) => c.options === undefined || !c.options.headers), '公共请求不带任何头（CDN 一份、不发预检）');
    // 聚合瓦片
    const city = await source.load(8, gzCityKey);
    assert.equal(city.length, 2);
    assert.equal(server.calls.at(-1).path, `/places/tiles/${tiles[8][gzCityKey]}/8/${gzCityKey}`);
    assert.equal(server.calls.at(-1).query, '');
    assert.equal(source.peek(8, gzCityKey), city, '内存里按哈希复用');
    assert.deepEqual(source.peek(8, '0/0'), [], '清单上没有的块就是空的');
    await sleep(5);
    assert.ok(stored.has(`map.tiles.v1:https://example.test:8/${gzCityKey}`), '瓦片存进本机');
    // 游客的明细瓦片不带票据
    const leaf = await source.load(12, gzLeafKey);
    assert.deepEqual(leaf.map((p) => p.id), [1, 2]);
    assert.equal(server.calls.at(-1).query, '');
    // 本机有存的、哈希对得上的，不再走网络
    const again = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: server.fetchImpl, readStored: async (key) => stored.get(key) ?? null });
    await again.start();
    const before = server.calls.length;
    await again.load(8, gzCityKey);
    assert.equal(server.calls.slice(before).filter((c) => c.path.includes('/8/')).length, 0);

    // 登录后：明细瓦片带票据（票据请求带 Authorization，瓦片请求不带）
    const userServer = fakeServer();
    const userSource = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: userServer.fetchImpl });
    userSource.setToken('jwt');
    await userSource.start();
    await userSource.load(12, gzLeafKey);
    const ticketCall = userServer.calls.find((c) => c.path === '/places/tiles/ticket');
    assert.equal(ticketCall.options.headers.Authorization, 'Bearer jwt');
    const leafCall = userServer.calls.find((c) => c.path.includes('/12/'));
    assert.equal(leafCall.query, '?t=tk-1');
    assert.ok(!leafCall.options.headers, '瓦片请求不带 Authorization');
}

{
    // 额度用完：只通知一次，之后明细瓦片不再请求、预取也停
    const server = fakeServer({ leafStatus: 429 });
    const source = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: server.fetchImpl });
    const limited = [];
    source.onLimited((info) => limited.push(info));
    await source.start();
    assert.equal(await source.load(12, gzLeafKey), null);
    assert.deepEqual(limited, [{ guest: true, retryAfter: 60 }]);
    assert.equal(source.leafLimited, true);
    const count = server.calls.length;
    assert.equal(await source.load(12, gzLeafKey), null);
    assert.equal(source.prefetchLeafAt([[116.4074, 39.9042]]), 0);
    assert.equal(server.calls.length, count, '超额后不再请求明细瓦片');
}

{
    // 预取：每次最多 maxTiles 块，同时在飞的不超过 PREFETCH.maxInFlight，已有的不拉，清单上没有的不拉
    const server = fakeServer();
    const source = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: server.fetchImpl });
    await source.start();
    const points = [[113.2644, 23.1291], [113.2650, 23.1295], [116.4074, 39.9042], [0, 0]];
    assert.equal(source.prefetchLeafAt(points), 2, '两块不同的瓦片（广州那两家在同一块）');
    assert.equal(source.prefetchInFlight, PREFETCH.maxInFlight);
    assert.equal(source.prefetchLeafAt(points), 0, '在飞的满了');
    await sleep(10);
    assert.equal(source.prefetchInFlight, 0);
    assert.equal(source.prefetchLeafAt(points), 0, '都已经有了');
    assert.equal(server.calls.filter((c) => c.path.includes('/12/')).length, 2);
    const priority = server.calls.find((c) => c.path.includes('/12/')).options.priority;
    assert.equal(priority, 'low', '预取用低优先级');
}

// ---- 每个地图一份：换级、缺块顶上、叠加与本地修改 ----
{
    const server = fakeServer();
    const source = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: server.fetchImpl });
    let now = 1000;
    const store = new MarkerTileStore(source, { now: () => now, switchWaitMs: 500 });
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    const gzBounds = { minLng: 113.255, maxLng: 113.275, minLat: 23.12, maxLat: 23.14 };
    assert.equal(store.setView({ bounds: gzBounds, zoom: 12 }), false, '清单还没到');
    await source.start();
    await sleep(40);
    assert.equal(store.band.kind, 'aggregate');
    assert.equal(store.band.tile, 8);
    let list = store.all();
    assert.equal(list.length, 2, '城市级：广州两家的匿名点');
    assert.ok(list.every((p) => p.aggregate));
    assert.ok(notified >= 1);

    // 放大到街区级：明细到了才整体切换
    const pending = store.setView({ bounds: gzBounds, zoom: 14 });
    assert.equal(pending, false, '明细瓦片还没到，先不切');
    assert.ok(store.all().every((p) => p.aggregate), '切换前保持城市级，不闪空');
    await sleep(40);
    assert.equal(store.band.kind, 'leaf');
    list = store.all();
    assert.deepEqual(list.map((p) => p.id).sort((a, b) => a - b), [1, 2]);
    assert.ok(list.every((p) => p.marker_only));

    // 本地修改：立即生效，明细瓦片追上后去掉；删除立即从地图上去掉
    store.upsert({ ...list.find((p) => p.id === 1), name: '鱼粥铺' });
    assert.equal(store.get('place:1').name, '鱼粥铺');
    store.remove('place:2');
    assert.deepEqual(store.all().map((p) => p.id), [1]);
    // 个人叠加：自己审核中的店各级都显示；屏蔽的住民的店在明细级去掉
    assert.equal(store.setOverlay({ own: [{ id: 9, name: '审核中', longitude: 113.266, latitude: 23.13 }], hidden_ids: [1] }), true);
    assert.deepEqual(store.all().map((p) => p.id), [9]);
    assert.equal(store.resetPersonal(), true);
    assert.deepEqual(store.all().map((p) => p.id).sort((a, b) => a - b), [1, 2]);

    // 回到城市级：本地修改不叠加到匿名点上（聚合数不显示店名）
    store.upsert({ id: 77, name: '新店', longitude: 113.266, latitude: 23.13 });
    store.setView({ bounds: gzBounds, zoom: 11.6 });
    assert.ok(store.all().every((p) => p.aggregate));
    assert.equal(store.all().length, 2);

    // 明细拿不到（超额）：街区级用城市级聚合里落在这块里的匿名点顶上
    const limitedServer = fakeServer({ leafStatus: 429 });
    const limitedSource = new MarkerTileSource({ backendUrl: 'https://example.test', fetchImpl: limitedServer.fetchImpl });
    const limitedStore = new MarkerTileStore(limitedSource, { switchWaitMs: 200 });
    limitedStore.subscribe(() => {});
    await limitedSource.start();
    limitedStore.setView({ bounds: gzBounds, zoom: 14 });
    await sleep(60);
    assert.equal(limitedStore.band.kind, 'leaf');
    const fallback = limitedStore.all();
    assert.equal(fallback.length, 2);
    assert.ok(fallback.every((p) => p.aggregate), '拿不到店名时用匿名点，不空白');
    store.dispose();
    limitedStore.dispose();
}

console.log('Marker tiles passed: tile math, band selection, anonymous aggregate points with filters, leaf rows, header-free public requests and leaf tickets, local storage, 429 stop, prefetch limits, atomic band switch, leaf fallback, overlay and local patches.');
