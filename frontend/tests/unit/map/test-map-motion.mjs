// 地图聚合与转场纯逻辑：npm run test:map（无需浏览器或 AMap）
import assert from 'node:assert/strict';
import {
    ClusterEngine, normalizePlaces, dataSignature, placeKey, radiusForCssPixels, hashString
} from "../../../src/map/cluster/engine.js";
import {
    buildSnapshot, computeLogicalZoom, expandBounds, boundsContains
} from "../../../src/map/cluster/snapshot.js";
import { planTransition, verifySnapshotMembers } from "../../../src/map/cluster/transitions.js";
import { PlaceRangeCache, RequestGate } from "../../../src/map/cluster/placeCache.js";
import { clusterScale, glyphSize, formatCount, hitSize } from "../../../src/map/cluster/glyph.js";
import { worldPixel, unprojectWorldPixel, centerForScreenTarget } from "../../../src/map/viewport.js";
import { tileBounds, isOverseasTile, buildCartoTileUrl } from "../../../src/map/overseasTileLayer.js";

// ---- 可复现的随机夹具 ----
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
        return s / 4294967296;
    };
}
function fixture(count, seed = 1, center = [113.39, 23.02], spread = 0.08) {
    const rand = rng(seed);
    const list = [];
    for (let i = 0; i < count; i++) {
        // 中心更密的分布，接近真实城市
        const r = spread * Math.pow(rand(), 1.6);
        const a = rand() * Math.PI * 2;
        list.push({ id: i + 1, name: `店${i + 1}`, category: i % 7 === 0 ? '避雷' : '推荐', longitude: center[0] + Math.cos(a) * r, latitude: center[1] + Math.sin(a) * r * 0.9 });
    }
    return list;
}
const WORLD = { minLng: -179.9, minLat: -85, maxLng: 179.9, maxLat: 85 };
const viewAround = (center, span) => ({ minLng: center[0] - span, maxLng: center[0] + span, minLat: center[1] - span * 0.7, maxLat: center[1] + span * 0.7 });
function snap(engine, zoom, view = WORLD, queryMode = 'nearby') {
    return buildSnapshot(engine, { viewBounds: view, logicalZoom: zoom, queryMode, bufferRatio: 0 });
}
function shuffle(list, seed) {
    const rand = rng(seed);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// ---- 尺寸曲线与数量格式 ----
assert.equal(glyphSize({ kind: 'cluster', count: 2 }).width, 36);
assert.ok(Math.abs(glyphSize({ kind: 'cluster', count: 10 }).width - 44) < 1, `10 → ${glyphSize({ kind: 'cluster', count: 10 }).width}`);
assert.ok(Math.abs(glyphSize({ kind: 'cluster', count: 50 }).width - 51) < 1);
assert.ok(Math.abs(glyphSize({ kind: 'cluster', count: 200 }).width - 55.8) < 0.2);
assert.equal(clusterScale(100000), 1.55);
assert.equal(clusterScale(1), 1);
assert.deepEqual(glyphSize({ kind: 'place', count: 1 }), { width: 36, height: 43, scale: 1 });
assert.ok(hitSize(glyphSize({ kind: 'place' })).width >= 44 && hitSize(glyphSize({ kind: 'place' })).height >= 44);
assert.equal(formatCount(999), '999');
assert.equal(formatCount(1234), '1.2k');
assert.equal(formatCount(1000), '1k');
assert.equal(formatCount(12345), '12k');

// ---- 半径换算：radius × 256 / extent = CSS 像素 ----
assert.equal(radiusForCssPixels(64, 512), 128);
assert.equal(radiusForCssPixels(64, 256), 64);

// ---- key 命名空间与规范化 ----
assert.equal(placeKey({ id: 12, longitude: 1, latitude: 2 }), 'place:12');
assert.equal(placeKey({ id: 'amap_B0FF', isMarked: false, longitude: 1, latitude: 2 }), 'poi:amap:B0FF');
assert.notEqual(placeKey({ id: 12 }), placeKey({ id: 'amap_12', isMarked: false }));
const normalized = normalizePlaces([
    { id: 2, longitude: 113.1, latitude: 23.1 },
    { id: 1, longitude: '113.2', latitude: '23.2' },
    { id: 2, longitude: 0, latitude: 0 },          // 重复 key：保留先出现者
    { id: 3, longitude: 'x', latitude: 23 },       // 无效坐标
    { id: 4, longitude: 113, latitude: 89 }        // 超出墨卡托范围
]);
assert.deepEqual(normalized.map((n) => n.key), ['place:1', 'place:2']);
assert.equal(normalized[1].lng, 113.1);

// ---- 输入重排不影响聚类结果 ----
const base = fixture(600, 7);
const engineA = new ClusterEngine(normalizePlaces(base), { generation: 1 });
const engineB = new ClusterEngine(normalizePlaces(shuffle(base, 99)), { generation: 2 });
assert.equal(engineA.signature, engineB.signature);
for (const z of [3, 10, 13, 16, 20]) {
    const a = snap(engineA, z).visibleNodes.map((n) => n.memberSignature).sort();
    const b = snap(engineB, z).visibleNodes.map((n) => n.memberSignature).sort();
    assert.deepEqual(a, b, `zoom ${z} 重排后结果不同`);
}

// ---- 每个地点恰属一个节点，计数守恒（0/1/多点、所有层级） ----
for (const count of [0, 1, 2, 600]) {
    const engine = new ClusterEngine(normalizePlaces(fixture(count, 3)), { generation: 10 + count });
    for (let z = 0; z <= 20; z++) {
        const s = snap(engine, z);
        assert.deepEqual(verifySnapshotMembers(s), [], `count=${count} zoom=${z}`);
        assert.equal(s.visibleNodes.reduce((sum, n) => sum + n.count, 0), count);
    }
}

// ---- 同坐标：最高层级仍保留聚合，展开层级超过上限（交给成员列表） ----
const stacked = [1, 2, 3, 4, 5].map((id) => ({ id, longitude: 113.3, latitude: 23.1 }));
const stackEngine = new ClusterEngine(normalizePlaces(stacked), { generation: 50, maxZoom: 20 });
const top = snap(stackEngine, 20).visibleNodes;
assert.equal(top.length, 1);
assert.equal(top[0].kind, 'cluster');
assert.equal(top[0].count, 5);
assert.ok(stackEngine.expansionZoom(top[0]) > 20);
// 查询层级被限制，不会越过聚类上限吐出重合单点
assert.equal(snap(stackEngine, 25).visibleNodes.length, 1);

// ---- 聚合按真实父子关系：放大拆分 / 缩小合并 ----
const engine = new ClusterEngine(normalizePlaces(fixture(800, 11)), { generation: 100 });
function checkZoomPair(zFrom, zTo) {
    const prev = snap(engine, zFrom);
    const next = snap(engine, zTo);
    const plan = planTransition(prev, next);
    assert.equal(plan.kind, zTo > zFrom ? 'zoom-in' : 'zoom-out');
    const members = (s, key) => new Set(engine.memberKeys(s.nodeByKey.get(key)));
    for (const [childKey, parentKey] of plan.splitFrom) {
        const parentMembers = members(prev, parentKey);
        for (const m of members(next, childKey)) assert.ok(parentMembers.has(m), `${childKey} 不是 ${parentKey} 的后代`);
    }
    for (const [childKey, parentKey] of plan.mergeInto) {
        const parentMembers = members(next, parentKey);
        for (const m of members(prev, childKey)) assert.ok(parentMembers.has(m), `${childKey} 不属于 ${parentKey}`);
    }
    for (const [nextKey, prevKey] of plan.reuse) {
        assert.deepEqual([...members(next, nextKey)].sort(), [...members(prev, prevKey)].sort());
    }
    // 全量视野下，每个目标节点都有来源（复用、拆分或合并），没有凭空出现的节点
    assert.equal(plan.enter.length, 0, `${zFrom}→${zTo} 出现无来源节点 ${plan.enter.slice(0, 3)}`);
    assert.equal(plan.exit.length, 0, `${zFrom}→${zTo} 出现无去向节点`);
    return plan;
}
let sawSplit = false;
let sawMerge = false;
for (const [a, b] of [[12, 13], [13, 12], [11, 14], [15, 12], [16, 17], [10, 11]]) {
    const plan = checkZoomPair(a, b);
    if (plan.splitFrom.size) sawSplit = true;
    if (plan.mergeInto.size) sawMerge = true;
}
assert.ok(sawSplit && sawMerge, '夹具没有覆盖拆分与合并');

// ---- 平移：同层级只复用 key，相同节点不重建 ----
{
    const center = [113.39, 23.02];
    const prev = snap(engine, 14, viewAround(center, 0.02));
    const next = snap(engine, 14, viewAround([center[0] + 0.005, center[1]], 0.02));
    const plan = planTransition(prev, next);
    assert.equal(plan.kind, 'pan');
    for (const node of next.visibleNodes) {
        if (prev.nodeByKey.has(node.key)) assert.equal(plan.reuse.get(node.key), node.key);
    }
}

// ---- 数据代更换：视野外新增地点时，视野内节点全部沿用图形 ----
{
    const view = viewAround([113.39, 23.02], 0.03);
    const extended = [...fixture(800, 11), { id: 99999, name: '远方', longitude: 120.1, latitude: 30.2 }];
    const engine2 = new ClusterEngine(normalizePlaces(extended), { generation: 101 });
    for (const z of [11, 13, 15]) {
        const prev = snap(engine, z, view);
        const next = snap(engine2, z, view);
        const plan = planTransition(prev, next);
        assert.equal(plan.kind, 'data');
        assert.equal(plan.reuse.size, next.visibleNodes.length, `zoom ${z}: 只应复用`);
        assert.equal(plan.enter.length + plan.exit.length + plan.splitFrom.size + plan.mergeInto.size, 0);
    }
}

// ---- 数据代更换：某个聚合多了一个成员 → 一一对应沿用图形（只更新数量），不冒充缩放拆分 ----
{
    const pair = [{ id: 1, longitude: 113.3, latitude: 23.1 }, { id: 2, longitude: 113.3001, latitude: 23.1 }];
    const e1 = new ClusterEngine(normalizePlaces(pair), { generation: 201 });
    const e2 = new ClusterEngine(normalizePlaces([...pair, { id: 3, longitude: 113.3002, latitude: 23.1001 }]), { generation: 202 });
    const prev = snap(e1, 14);
    const next = snap(e2, 14);
    assert.equal(prev.visibleNodes[0].count, 2);
    assert.equal(next.visibleNodes[0].count, 3);
    const plan = planTransition(prev, next);
    assert.equal(plan.reuse.get(next.visibleNodes[0].key), prev.visibleNodes[0].key);
    assert.equal(plan.splitFrom.size + plan.mergeInto.size, 0);
}

// ---- 查询模式切换（附近 → 搜索）：只沿用两边都有的单点，其余短渐变 ----
{
    const view = viewAround([113.39, 23.02], 0.05);
    const prev = snap(engine, 17, view, 'nearby');
    const searchEngine = new ClusterEngine(normalizePlaces(fixture(800, 11).slice(0, 5)), { generation: 300 });
    const next = snap(searchEngine, 17, view, 'search');
    const plan = planTransition(prev, next);
    assert.equal(plan.kind, 'mode');
    assert.equal(plan.splitFrom.size + plan.mergeInto.size, 0);
}

// ---- 成员签名与顺序无关 ----
assert.equal((hashString('a') ^ hashString('b')) >>> 0, (hashString('b') ^ hashString('a')) >>> 0);

// ---- 逻辑缩放与滞回 ----
assert.equal(computeLogicalZoom(12.3, undefined), 12);
assert.equal(computeLogicalZoom(12.6, undefined), 13);
assert.equal(computeLogicalZoom(12.6, 12), 12);       // 未越过 0.5 + 滞回
assert.equal(computeLogicalZoom(12.7, 12), 13);
assert.equal(computeLogicalZoom(11.4, 12), 12);
assert.equal(computeLogicalZoom(11.3, 12), 11);
assert.equal(computeLogicalZoom(15.2, 12), 15);       // 跨多级直接到位
assert.equal(computeLogicalZoom(25, 12, { maxZoom: 20 }), 20);
assert.equal(computeLogicalZoom(NaN, 9), 9);

// ---- 范围工具 ----
const v = { minLng: 0, maxLng: 1, minLat: 0, maxLat: 1 };
assert.deepEqual(expandBounds(v, 1), { minLng: -1, maxLng: 2, minLat: -1, maxLat: 2 });
assert.ok(boundsContains(expandBounds(v, 0.5), v));

// ---- 范围缓存：覆盖判断、范围内删除、过期、淘汰 ----
{
    let now = 1000;
    const cache = new PlaceRangeCache({ ttlMs: 100, maxPlaces: 50, maxRegions: 3, now: () => now });
    const view = { minLng: 113, maxLng: 113.1, minLat: 23, maxLat: 23.1 };
    assert.equal(cache.coverage(view).covered, false);
    const region = expandBounds(view, 1);
    assert.ok(cache.apply(region, [{ id: 1, longitude: 113.05, latitude: 23.05 }, { id: 2, longitude: 113.06, latitude: 23.06 }]));
    let status = cache.coverage(view);
    assert.ok(status.covered && status.fresh && !status.nearEdge);
    // 视野接近覆盖边缘：需要后台请求
    assert.equal(cache.coverage({ minLng: 113.18, maxLng: 113.195, minLat: 23, maxLat: 23.1 }).nearEdge, true);
    // 同一范围的新响应里缺少地点 2 → 已删除
    assert.ok(cache.apply(region, [{ id: 1, longitude: 113.05, latitude: 23.05 }]));
    assert.deepEqual(cache.all().map((p) => p.id), [1]);
    // 相同内容的响应不算变化
    assert.equal(cache.apply(region, [{ id: 1, longitude: 113.05, latitude: 23.05 }]), false);
    now += 500;
    assert.equal(cache.coverage(view).fresh, false);
    // 点数上限：淘汰最久未使用的区域
    for (let r = 0; r < 4; r++) {
        const lng = 100 + r;
        const list = Array.from({ length: 30 }, (_, i) => ({ id: 1000 + r * 100 + i, longitude: lng + 0.01, latitude: 30 + i * 0.001 }));
        cache.apply({ minLng: lng, maxLng: lng + 0.5, minLat: 29.9, maxLat: 30.5 }, list);
        now += 1;
    }
    assert.ok(cache.places.size <= 50, `缓存地点 ${cache.places.size}`);
    assert.ok(cache.regions.length <= 3);
}

// ---- 请求闸门：旧响应即使晚到也不能覆盖新状态 ----
{
    const gate = new RequestGate();
    const first = gate.begin();
    const second = gate.begin();
    assert.equal(first.signal.aborted, true);
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
    gate.invalidate(); // 进入搜索模式
    assert.equal(gate.isCurrent(second), false);
    assert.equal(second.signal.aborted, true);
}

// ---- Web Mercator 像素换算与安全区居中 ----
{
    const p = worldPixel(113.39, 23.02, 15);
    const back = unprojectWorldPixel(p.x, p.y, 15);
    assert.ok(Math.abs(back.lng - 113.39) < 1e-9 && Math.abs(back.lat - 23.02) < 1e-9);
    // 目标点在容器中心上方 100px：地图中心应在目标点南侧 100px
    const [lng, lat] = centerForScreenTarget({ lng: 113.39, lat: 23.02, zoom: 15, targetX: 200, targetY: 300, width: 400, height: 800 });
    const c = worldPixel(lng, lat, 15);
    assert.ok(Math.abs(c.x - p.x) < 1e-6 && Math.abs(c.y - (p.y + 100)) < 1e-6);
}

// ---- 性能夹具（记录而非断言严格预算） ----
for (const count of [100, 1000, 10000]) {
    const list = fixture(count, 5, [113.39, 23.02], 0.6);
    let t = performance.now();
    const e = new ClusterEngine(normalizePlaces(list), { generation: 1000 + count });
    const build = performance.now() - t;
    const view = viewAround([113.39, 23.02], 0.08);
    t = performance.now();
    const s1 = snap(e, 12, view);
    const s2 = snap(e, 13, view);
    const snapMs = (performance.now() - t) / 2;
    t = performance.now();
    planTransition(s1, s2);
    const planMs = performance.now() - t;
    console.log(`  ${String(count).padStart(5)} 地点：索引 ${build.toFixed(1)}ms · 快照 ${snapMs.toFixed(2)}ms · 差分 ${planMs.toFixed(2)}ms · 可见节点 ${s2.visibleNodes.length}`);
    assert.ok(build < 2000);
}

// ---- 海外底图：只有完全不碰高德境内格子的瓦片才走 CARTO ----
{
    const tileOf = (lng, lat, z) => {
        const n = 2 ** z;
        const rad = (lat * Math.PI) / 180;
        return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n), z];
    };
    const akihabara = tileOf(139.7714, 35.6984, 16);
    const b = tileBounds(...akihabara);
    assert.ok(b.west <= 139.7714 && b.east > 139.7714 && b.south <= 35.6984 && b.north > 35.6984);
    assert.ok(Math.abs(tileBounds(0, 0, 0).north - 85.0511) < 1e-3);
    assert.equal(isOverseasTile(...akihabara), true);
    assert.equal(isOverseasTile(...tileOf(113.3245, 23.1065, 16)), false); // 广州
    assert.equal(isOverseasTile(...tileOf(114.1694, 22.3193, 16)), false); // 香港
    // 海参崴所在的格子算境内；跨在它与境外格子之间的瓦片也交给高德
    assert.equal(isOverseasTile(...tileOf(131.95, 43.5, 10)), false);
    assert.equal(isOverseasTile(...tileOf(132.5, 43.5, 12)), true);
    assert.equal(
        buildCartoTileUrl({ x: 1, y: 2, z: 3, dark: false, retina: true, apiKey: 'k+1' }),
        'https://basemaps.cartocdn.com/rastertiles/voyager/3/1/2@2x.png?key=k%2B1'
    );
    assert.equal(
        buildCartoTileUrl({ x: 1, y: 2, z: 3, dark: true, retina: false, apiKey: 'k' }),
        'https://basemaps.cartocdn.com/dark_all/3/1/2.png?key=k'
    );
}

void dataSignature;
console.log('map motion tests passed');
