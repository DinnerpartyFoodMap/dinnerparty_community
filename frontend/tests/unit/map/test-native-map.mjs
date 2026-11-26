// iOS 原生底图（MapKit）网页侧：协议清洗、会话、AMap.Map 替身（相机、投影、事件、覆盖物）、坐标校准、触摸命中采样、
// 原生标记层（网页聚合引擎 + 转场计划 → 原生），以及与 Swift 源码的白名单 / 版本 / 动画时长对照。Swift 不在这里编译，真机检查见 native/doc/README.md。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- 最小 DOM：只提供被测模块用到的部分 ----
const rootAttributes = new Map();
globalThis.window = {
    innerWidth: 390,
    innerHeight: 844,
    addEventListener() { },
    removeEventListener() { },
    dispatchEvent() { },
    setTimeout, clearTimeout, setInterval, clearInterval
};
globalThis.document = {
    visibilityState: 'visible',
    documentElement: {
        dataset: {},
        setAttribute: (key, value) => rootAttributes.set(key, value),
        removeAttribute: (key) => rootAttributes.delete(key),
        getAttribute: (key) => (rootAttributes.has(key) ? rootAttributes.get(key) : null)
    },
    body: {},
    addEventListener() { },
    removeEventListener() { },
    querySelectorAll: () => [],
    elementFromPoint: () => null
};

const {
    NATIVE_MAP_PROTOCOL, NATIVE_MAP_GLYPHS, NATIVE_MAP_OVERLAY_KINDS, NativeMapSession,
    nativeColor, encodeNativeNodes, encodeNativePlan, sanitizeProbes, sanitizeOverlayMarker, sanitizeOverlayLine, sanitizeHoles, encodeRect
} = await import('../../../src/platform/nativeMap.js');
const {
    NativeMapView, NativeMarkerOverlay, NativePolylineOverlay, isNativeMap, nativeMapAppearance, sampleTouchHoles, liveTouchHoles, readPoint
} = await import('../../../src/map/nativeMapView.js');
const { NativeMarkerLayer, buildNativeMarkerStyle, nativeNode, NATIVE_BUFFER_RATIO } = await import('../../../src/map/nativeMarkerLayer.js');
const { createComputeRuntime } = await import('../../../src/map/cluster/computeRuntime.js');
const { lngOf, tileOf } = await import('../../../src/map/markerTiles.js');
const { computeLogicalZoom } = await import('../../../src/map/cluster/snapshot.js');
const {
    frameRegion, FRAME_PROBES, decideProbe, decideFrames, toNativeCoordinate, fromNativeCoordinate, distanceMeters,
    readCachedFrames, saveCachedFrames, nativeProbeRequests, FRAMES_CACHE_MS
} = await import('../../../src/map/nativeMapFrames.js');
const { wgs84ToGcj02Raw, gcj02ToWgs84Raw, wgs84ToGcj02 } = await import('../../../src/platform/coordTransform.js');
const { worldPixel } = await import('../../../src/map/viewport.js');
const { MARKER_TIMING } = await import('../../../src/map/MarkerLayerController.js');

const tick = (n = 1) => new Promise((resolve) => setTimeout(resolve, n));

class FakeMapPlugin {
    constructor(options = {}) {
        this.options = options;
        this.calls = [];
        this.listeners = {};
        this.session = null;
    }
    async capabilities() { return { protocolVersion: this.options.protocol ?? NATIVE_MAP_PROTOCOL, available: this.options.available ?? true }; }
    async addListener(name, fn) {
        (this.listeners[name] ||= []).push(fn);
        return { remove: async () => { this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn); } };
    }
    async attach(args) {
        this.calls.push(['attach', args]);
        this.session = args.sessionId;
        return { ready: true, camera: { phase: 'end', lng: args.lng, lat: args.lat, zoom: args.zoom, width: 390, height: 844 } };
    }
    emit(name, data) { (this.listeners[name] || []).forEach((fn) => fn(data)); }
    last(method) { return this.calls.filter(([name]) => name === method).at(-1)?.[1]; }
    count(method) { return this.calls.filter(([name]) => name === method).length; }
}
FakeMapPlugin.prototype.setCamera = async function (args) {
    this.calls.push(['setCamera', args]);
    if (args.sessionId !== this.session) throw new Error('STALE_SESSION');
    this.onSetCamera?.(args);
    return this.cameraReply ? { camera: this.cameraReply } : {};
};
for (const method of ['panBy', 'setStyle', 'setNodes', 'setSelected', 'setOverlays', 'setAppearance', 'setInsets', 'setTouch', 'dispose']) {
    FakeMapPlugin.prototype[method] = async function (args) {
        this.calls.push([method, args]);
        if (method !== 'dispose' && args.sessionId !== this.session) throw new Error('STALE_SESSION');
        return {};
    };
}
FakeMapPlugin.prototype.search = async function (args) {
    this.calls.push(['search', args]);
    if (args.sessionId !== this.session) throw new Error('STALE_SESSION');
    return { results: this.options.searchResults ? this.options.searchResults(args.probes) : [] };
};
FakeMapPlugin.prototype.fitBounds = async function (args) {
    this.calls.push(['fitBounds', args]);
    return { camera: { phase: 'end', lng: (args.minLng + args.maxLng) / 2, lat: (args.minLat + args.maxLat) / 2, zoom: Math.min(args.maxZoom, 15), width: 390, height: 844 } };
};

// ---- 清洗 ----
{
    assert.equal(nativeColor('#E2789F'), '#e2789f');
    assert.equal(nativeColor('#abc'), '#aabbcc');
    assert.equal(nativeColor('rgb(26, 115, 232)'), '#1a73e8');
    assert.equal(nativeColor('rgba(0, 0, 0, 0.5)'), '#00000080');
    assert.equal(nativeColor('#11223344'), '#11223344');
    assert.equal(nativeColor('var(--theme-primary)'), undefined, '没解析的 CSS 变量不下发');
    assert.equal(nativeColor(''), undefined);

    const encoded = encodeNativeNodes([
        { id: 'place:1', cluster: false, lng: 113.3, lat: 23.1, name: '店', glyph: 'avoid' },
        { id: 'place:2', lng: 200, lat: 23.1, name: '超出范围' },
        { id: '', lng: 113, lat: 23 },
        { id: 'cluster:1:5', cluster: true, lng: 113.35, lat: 23.15, count: 1, name: '聚合没有名称', glyph: 'avoid' },
        { id: 'place:1', lng: 113.3, lat: 23.1 },
        { id: 'place:3', lng: 113.4, lat: 23.2, name: 'x'.repeat(200), glyph: 'evil' }
    ]);
    assert.deepEqual(encoded.ids, ['place:1', 'cluster:1:5', 'place:3'], '无效坐标、空 id、重复 id 丢弃');
    assert.deepEqual(encoded.clusters, [false, true, false]);
    assert.deepEqual(encoded.coords, [113.3, 23.1, 113.35, 23.15, 113.4, 23.2]);
    assert.deepEqual(encoded.counts, [1, 2, 1], '聚合至少 2 个');
    assert.deepEqual(encoded.glyphs, ['avoid', 'place', 'place'], '未知图标种类与聚合按普通地点');
    assert.deepEqual([encoded.names[1], encoded.names[2].length], ['', 80], '聚合不带名称，名称截断');

    const plan = {
        reuse: new Map([['a', 'a'], ['b', 'gone-prev']]),
        reanchor: new Set(['a', 'b', 'c']),
        splitFrom: new Map([['c', 'p'], ['x', 'p']]),
        mergeInto: new Map([['p', 'c'], ['q', 'missing']]),
        splitSources: new Set(['p', 'unknown']),
        mergeTargets: new Set(['c', 'zz'])
    };
    assert.deepEqual(encodeNativePlan(plan, { nextKeys: new Set(['a', 'b', 'c']), prevKeys: new Set(['a', 'p']) }), {
        reuse: ['a', 'a'], reanchor: ['a'], splitFrom: ['c', 'p'], mergeInto: ['p', 'c'], splitSources: ['p'], mergeTargets: ['c']
    }, '计划只保留两份快照里都存在的 key');
    assert.deepEqual(sanitizeProbes([{ id: 'p', names: ['天安门', '', 'x'.repeat(99), 3], lng: 116.4, lat: 39.9, radius: 1 }, { id: 'bad', names: [], lng: 1, lat: 1 }]),
        [{ id: 'p', names: ['天安门', 'x'.repeat(60)], lng: 116.4, lat: 39.9, radius: 200 }]);

    assert.equal(sanitizeOverlayMarker({ id: 'a', kind: 'evil', lng: 1, lat: 1 }), null);
    assert.deepEqual(sanitizeOverlayMarker({ id: 'a', kind: 'badge', lng: 1, lat: 2, text: '12345', fill: 'rgb(255,0,0)', size: 999, zIndex: -5, onclick: 'x' }),
        { id: 'a', kind: 'badge', lng: 1, lat: 2, text: '1234', fill: '#ff0000', size: 64, zIndex: 0 });
    assert.equal(sanitizeOverlayLine({ id: 'l', path: [[1, 1]] }), null, '少于两个点的折线丢弃');
    const line = sanitizeOverlayLine({ id: 'l', path: [[1, 1], { lng: 2, lat: 2 }, [999, 1]], color: '#123456', width: 50, dashed: 1 });
    assert.deepEqual(line, { id: 'l', coords: [1, 1, 2, 2], color: '#123456', width: 20, opacity: 1, dashed: true, zIndex: 100 });
    assert.equal('color' in sanitizeOverlayLine({ id: 'l', path: [[1, 1], [2, 2]], color: 'var(--x)' }), false, '读不出的颜色交给原生默认值');
    assert.deepEqual(encodeRect({ left: 1.26, top: 2, width: 10, height: 0 }), null);
    assert.deepEqual(sanitizeHoles([{ x: 1.26, y: 2.74, width: 10, height: 20 }, [0, 0, -1, 3], [5, 5, 5, 5]]), [[1.5, 2.5, 10, 20], [5, 5, 5, 5]]);
}

// ---- 会话：版本、事件过滤、调用顺序、结束 ----
{
    await assert.rejects(new NativeMapSession({ plugin: new FakeMapPlugin({ protocol: 99 }) }).start({ lng: 1, lat: 1, zoom: 3 }));
    await assert.rejects(new NativeMapSession({ plugin: new FakeMapPlugin({ available: false }) }).start({ lng: 1, lat: 1, zoom: 3 }));

    const plugin = new FakeMapPlugin();
    const events = [];
    const session = new NativeMapSession({ plugin, onEvent: (name, data) => events.push([name, data.id]) });
    const camera = await session.start({ lng: 113, lat: 23, zoom: 15, dark: true });
    assert.equal(camera.zoom, 15);
    assert.equal(plugin.last('attach').dark, true);
    plugin.emit('markerTap', { sessionId: 'other', id: 'x' });
    plugin.emit('markerTap', { sessionId: plugin.session, id: 'place:1' });
    assert.deepEqual(events, [['markerTap', 'place:1']], '其他会话的事件被忽略');
    await Promise.all([session.call('setSelected', { id: 'a' }), session.call('setSelected', { id: 'b' })]);
    assert.deepEqual(plugin.calls.filter(([name]) => name === 'setSelected').map(([, args]) => args.id), ['a', 'b'], '按发出顺序调用');
    await session.stop();
    assert.equal(plugin.count('dispose'), 1);
    assert.equal(await session.call('setSelected', { id: 'c' }), null, '结束后的调用丢弃');
    plugin.emit('markerTap', { sessionId: plugin.session, id: 'late' });
    assert.equal(events.length, 1);
}

// ---- 高德样式 → MapKit ----
{
    assert.deepEqual(nativeMapAppearance('amap://styles/dark'), { dark: true, muted: false });
    assert.deepEqual(nativeMapAppearance('amap://styles/darkblue'), { dark: true, muted: false });
    assert.deepEqual(nativeMapAppearance('amap://styles/grey'), { dark: true, muted: true });
    assert.deepEqual(nativeMapAppearance('amap://styles/light'), { dark: false, muted: true });
    assert.deepEqual(nativeMapAppearance('amap://styles/normal', true), { dark: false, muted: false }, '与高德相同：地图深浅跟样式走');
    assert.deepEqual(nativeMapAppearance('amap://styles/night', true), { dark: true, muted: false }, '随昼夜变化的样式跟界面');
    assert.deepEqual(nativeMapAppearance(undefined, false), { dark: false, muted: false });
}

// ---- AMap.Map 替身 ----
const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }),
    contains: (el) => el === canvas,
    isConnected: true,
    clientWidth: 390,
    clientHeight: 844
};
{
    const plugin = new FakeMapPlugin();
    const session = new NativeMapSession({ plugin });
    const map = new NativeMapView(canvas, { center: [113.3, 23.1], zoom: 15, dark: false, muted: true, session });
    const seen = [];
    for (const type of ['complete', 'movestart', 'dragstart', 'mapmove', 'moveend', 'zoomend', 'click']) map.on(type, (event) => seen.push([type, event]));
    assert.equal(isNativeMap(map), true);
    assert.equal(isNativeMap({}), false);
    assert.equal(map.getZoom(), 15, '握手前也能读到初始相机');
    await map.ready;
    assert.equal(rootAttributes.has('data-native-map'), true, '接管后页面底色透明');
    assert.deepEqual(plugin.last('attach').muted, true);
    assert.equal(seen[0][0], 'complete');

    // 相机：先更新缓存，再按顺序发给原生
    map.setZoomAndCenter(17, [113.31, 23.11]);
    assert.equal(map.getZoom(), 17);
    assert.equal(map.getCenter().getLng(), 113.31);
    map.setZoom(40, true);
    assert.equal(map.getZoom(), 20, '缩放限制在 3–20');
    await tick(5);
    const cameraCalls = plugin.calls.filter(([name]) => name === 'setCamera').map(([, args]) => [args.zoom, args.animated]);
    assert.deepEqual(cameraCalls, [[17, true], [20, false]]);

    // 原生没动（MapKit 在这里到不了 20 级）：没有相机事件，用 setCamera 回执里的实际相机纠正乐观缓存
    plugin.cameraReply = { phase: 'end', lng: 113.31, lat: 23.11, zoom: 19.2, width: 390, height: 844 };
    map.setZoom(20, false);
    assert.equal(map.getZoom(), 20, '发出时先乐观更新');
    await tick(5);
    assert.equal(map.getZoom(), 19.2, '原生没动：回执纠正缓存');
    // 原生动了：start / end 事件带来实际相机，回执不覆盖
    plugin.cameraReply = { phase: 'end', lng: 113.31, lat: 23.11, zoom: 18, width: 390, height: 844 };
    plugin.onSetCamera = () => {
        plugin.emit('camera', { sessionId: plugin.session, phase: 'start', lng: 113.31, lat: 23.11, zoom: 19.2 });
        plugin.emit('camera', { sessionId: plugin.session, phase: 'end', lng: 113.31, lat: 23.11, zoom: 19.6, zoomChanged: true });
    };
    map.setZoom(19.6, false);
    await tick(5);
    assert.equal(map.getZoom(), 19.6, '相机事件优先于回执');
    plugin.onSetCamera = null;
    plugin.cameraReply = null;
    map.setZoom(20, true);
    await tick(5);
    assert.deepEqual(map.getZooms(), [3, 20]);

    // 投影：中心在画布正中，往返一致，与 viewport.js 同一套 Web Mercator
    const center = map.lngLatToContainer(map.getCenter());
    assert.ok(Math.abs(center.x - 195) < 1e-6 && Math.abs(center.y - 422) < 1e-6);
    const east = map.lngLatToContainer([113.32, 23.11]);
    const expectedDx = worldPixel(113.32, 23.11, 20).x - worldPixel(113.31, 23.11, 20).x;
    assert.ok(Math.abs(east.x - 195 - expectedDx) < 1e-6);
    const back = map.containerToLngLat([east.x, east.y]);
    assert.ok(Math.abs(back.lng - 113.32) < 1e-9 && Math.abs(back.lat - 23.11) < 1e-9);
    const bounds = map.getBounds();
    assert.ok(bounds.getSouthWest().getLng() < 113.31 && bounds.getNorthEast().getLat() > 23.11);
    assert.equal(map.getSize().getWidth(), 390);

    // 原生事件 → 高德同名事件
    seen.length = 0;
    plugin.emit('camera', { sessionId: plugin.session, phase: 'start', lng: 113.31, lat: 23.11, zoom: 20, gesture: true });
    plugin.emit('camera', { sessionId: plugin.session, phase: 'change', lng: 113.315, lat: 23.11, zoom: 19.5 });
    plugin.emit('camera', { sessionId: plugin.session, phase: 'end', lng: 113.32, lat: 23.12, zoom: 19, zoomChanged: true, width: 390, height: 844 });
    assert.deepEqual(seen.map(([type]) => type), ['movestart', 'dragstart', 'mapmove', 'moveend', 'zoomend']);
    assert.equal(map.getZoom(), 19);
    seen.length = 0;
    plugin.emit('camera', { sessionId: plugin.session, phase: 'start', lng: 113.32, lat: 23.12, zoom: 19, gesture: false });
    plugin.emit('camera', { sessionId: plugin.session, phase: 'end', lng: 113.33, lat: 23.12, zoom: 19 });
    assert.deepEqual(seen.map(([type]) => type), ['movestart', 'moveend'], '只平移不发 zoomend，程序移动不发 dragstart');
    plugin.emit('tap', { sessionId: plugin.session, lng: 113.4, lat: 23.2 });
    const click = seen.find(([type]) => type === 'click')[1];
    assert.equal(click.lnglat.getLng(), 113.4);
    assert.equal(click.target, map);

    // 覆盖物：合并成一次下发；setOptions 重发；移除后清空
    const pin = new NativeMarkerOverlay({ position: [113.3, 23.1], kind: 'pin', fill: 'rgb(226,120,159)', zIndex: 3100 });
    const line = new NativePolylineOverlay({ path: [[113.3, 23.1], [113.4, 23.2]], strokeColor: '#000000', strokeWeight: 7, strokeStyle: 'dashed' });
    assert.equal(line.CLASS_NAME, 'AMap.Polyline');
    pin.setMap(map);
    map.add(line);
    await tick(5);
    let overlays = plugin.last('setOverlays');
    assert.deepEqual(overlays.markers.map((m) => [m.kind, m.fill, m.zIndex]), [['pin', '#e2789f', 3100]]);
    assert.deepEqual(overlays.lines.map((l) => [l.width, l.dashed, l.coords.length]), [[7, true, 4]]);
    line.setOptions({ strokeColor: '#ffffff' });
    await tick(5);
    assert.equal(plugin.last('setOverlays').lines[0].color, '#ffffff');
    assert.equal(pin.getPosition().getLat(), 23.1);
    map.remove([pin, line]);
    await tick(5);
    overlays = plugin.last('setOverlays');
    assert.deepEqual([overlays.markers.length, overlays.lines.length], [0, 0]);
    assert.equal(pin.getMap(), null);

    // 视野：setFitView / setBounds 带 [上, 右, 下, 左] 边距与最大缩放
    const a = new NativeMarkerOverlay({ position: [113.3, 23.1] });
    const b = new NativeMarkerOverlay({ position: [113.5, 23.3] });
    map.setFitView([a, b], false, [80, 80, 120, 70], 16);
    await tick(5);
    const fit = plugin.last('fitBounds');
    assert.deepEqual([fit.minLng, fit.minLat, fit.maxLng, fit.maxLat, fit.top, fit.right, fit.bottom, fit.left, fit.maxZoom, fit.animated],
        [113.3, 23.1, 113.5, 23.3, 80, 80, 120, 70, 16, true]);
    assert.equal(map.getZoom(), 15, '原生回传的相机覆盖乐观值');
    map.setBounds({ minLng: 1, minLat: 2, maxLng: 3, maxLat: 4 }, true, [10, 20, 30, 40]);
    await tick(5);
    assert.deepEqual([plugin.last('fitBounds').minLng, plugin.last('fitBounds').left, plugin.last('fitBounds').animated], [1, 40, false]);

    // 样式
    map.setMapStyle('amap://styles/grey');
    await tick(5);
    assert.deepEqual([plugin.last('setAppearance').dark, plugin.last('setAppearance').muted], [true, true]);
    const appearanceCalls = plugin.count('setAppearance');
    map.setMapStyle({ style: 'amap://styles/grey' });
    await tick(5);
    assert.equal(plugin.count('setAppearance'), appearanceCalls, '外观不变时不重发');

    assert.equal(plugin.count('search'), 1, '握手后自动校准一次');
    assert.equal(plugin.last('search').probes.length, FRAME_PROBES.length);

    map.destroy();
    await tick(5);
    assert.equal(rootAttributes.has('data-native-map'), false);
    assert.equal(plugin.count('dispose'), 1);
    map.setZoom(5);
    await tick(5);
    assert.equal(plugin.count('setCamera'), 5, '销毁后的调用不发');
    assert.deepEqual(readPoint({ getLng: () => 1, getLat: () => 2 }), [1, 2]);
    assert.equal(readPoint([1, 99]), null);
}

// ---- 坐标：反算、地区、地标判断、换算、缓存 ----
{
    for (const [lng, lat] of [[116.397, 39.909], [114.158, 22.285], [121.56, 25.03], [87.6, 43.8]]) {
        const gcj = wgs84ToGcj02Raw(lng, lat);
        const back = gcj02ToWgs84Raw(gcj.lng, gcj.lat);
        assert.ok(distanceMeters([back.lng, back.lat], [lng, lat]) < 0.01, '反算误差小于 1 厘米');
    }
    assert.deepEqual(wgs84ToGcj02(139.7, 35.68), { lng: 139.7, lat: 35.68 }, '高德境外不偏移');

    const regions = {
        mainland: [[116.397, 39.909], [114.055, 22.535], [114.068, 22.524], [113.92, 22.485], [114.118, 22.537], [113.53, 22.13], [113.55, 22.225], [118.35, 24.44], [119.79, 25.50], [131.9, 43.1]],
        hk: [[114.158, 22.285], [114.172, 22.297], [113.97, 22.39], [114.065, 22.512], [114.11, 22.528]],
        mo: [[113.543, 22.193], [113.56, 22.157]],
        tw: [[121.56, 25.03], [119.57, 23.57], [120.30, 22.62]],
        abroad: [[139.7, 35.68], [-122.4, 37.8]]
    };
    for (const [region, points] of Object.entries(regions)) {
        for (const [lng, lat] of points) assert.equal(frameRegion(lng, lat), region, `${lng},${lat} 属于 ${region}`);
    }

    for (const probe of FRAME_PROBES) {
        assert.ok(distanceMeters(probe.wgs, probe.gcj) > 400, `${probe.id} 两套坐标相距足够远`);
        assert.equal(decideProbe(probe, [[probe.gcj[0] + 0.0004, probe.gcj[1]]]), 'gcj');
        assert.equal(decideProbe(probe, [[999, 0], [probe.wgs[0], probe.wgs[1] + 0.0003]]), 'wgs', '取离地标最近的结果');
        assert.equal(decideProbe(probe, [[(probe.wgs[0] + probe.gcj[0]) / 2, (probe.wgs[1] + probe.gcj[1]) / 2]]), null, '落在中间不下结论');
        assert.equal(decideProbe(probe, [[probe.wgs[0] + 0.1, probe.wgs[1]]]), null, '搜到别处不下结论');
        assert.equal(decideProbe(probe, []), null);
    }
    const flat = (point) => [point[0], point[1]];
    const results = (pick) => FRAME_PROBES.map((probe) => ({ id: probe.id, points: pick(probe) }));
    assert.deepEqual(decideFrames(results((p) => flat(p.gcj))), { mainland: 'gcj', hk: 'gcj', mo: 'gcj', tw: 'gcj' }, '手机在大陆：高德版');
    assert.deepEqual(decideFrames(results((p) => flat(p.region === 'mainland' ? p.gcj : p.wgs))), { mainland: 'gcj', hk: 'wgs', mo: 'wgs', tw: 'wgs' }, '手机在香港：全球版');
    assert.deepEqual(decideFrames(results((p) => (p.id === 'hk-ifc' ? flat(p.gcj) : p.region === 'hk' ? flat(p.wgs) : []))), {}, '同一地区两个地标矛盾时不下结论');
    assert.deepEqual(decideFrames(results((p) => (p.id === 'tw-101' ? flat(p.wgs) : []))), { tw: 'wgs' }, '只有一个地标有结论也采用');
    assert.equal(nativeProbeRequests()[0].radius, 3000);

    const hk = [114.158, 22.285];
    assert.deepEqual(toNativeCoordinate(hk[0], hk[1], {}), hk, '没有结论不换算');
    assert.deepEqual(toNativeCoordinate(hk[0], hk[1], { hk: 'gcj' }), hk);
    const hkNative = toNativeCoordinate(hk[0], hk[1], { hk: 'wgs' });
    assert.ok(distanceMeters(hkNative, hk) > 400, '香港用 WGS-84 时转成 WGS-84');
    assert.ok(distanceMeters(fromNativeCoordinate(hkNative[0], hkNative[1], { hk: 'wgs' }), hk) < 0.01, '读回时换回店铺坐标');
    assert.deepEqual(toNativeCoordinate(116.397, 39.909, { hk: 'wgs' }), [116.397, 39.909], '其他地区不受影响');
    assert.deepEqual(toNativeCoordinate(139.7, 35.68, { mainland: 'wgs' }), [139.7, 35.68], '境外两边都是 WGS-84');

    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    saveCachedFrames({ hk: 'wgs', mainland: 'gcj' }, 1000, storage);
    assert.deepEqual(readCachedFrames(2000, storage), { mainland: 'gcj', hk: 'wgs' });
    assert.equal(readCachedFrames(1000 + FRAMES_CACHE_MS + 1, storage), null, '过期的缓存不用');
    store.set('foodmap.nativeMapFrames', '{"frames":{"hk":"evil"},"at":1000}');
    assert.deepEqual(readCachedFrames(2000, storage), {}, '只认 gcj / wgs');
    assert.equal(readCachedFrames(0, { getItem() { throw new Error('denied'); } }), null);
}

// ---- 校准接入底图：结果变化时换算相机、点按与覆盖物 ----
{
    // 手机在香港：大陆 GCJ-02，港澳台 WGS-84
    const plugin = new FakeMapPlugin({ searchResults: (probes) => probes.map((p) => {
        const probe = FRAME_PROBES.find((item) => item.id === p.id);
        const point = probe.region === 'mainland' ? probe.gcj : probe.wgs;
        return { id: p.id, points: [point[0], point[1]] };
    }) });
    const map = new NativeMapView(canvas, { center: [114.158, 22.285], zoom: 16, session: new NativeMapSession({ plugin }) });
    const changes = [];
    map.on('framechange', (event) => changes.push(event.frames));
    await map.ready;
    assert.deepEqual(plugin.last('attach').lng, 114.158, '握手时还没校准，原样');
    await map.calibrate();
    await tick(5);
    assert.deepEqual(changes, [{ mainland: 'gcj', hk: 'wgs', mo: 'wgs', tw: 'wgs' }]);
    map.setZoomAndCenter(17, [114.158, 22.285]);
    await tick(5);
    const sent = plugin.last('setCamera');
    assert.ok(distanceMeters([sent.lng, sent.lat], [114.158, 22.285]) > 400, '香港的相机按 WGS-84 发');
    const seen = [];
    map.on('click', (event) => seen.push([event.lnglat.getLng(), event.lnglat.getLat()]));
    plugin.emit('tap', { sessionId: plugin.session, lng: sent.lng, lat: sent.lat });
    assert.ok(distanceMeters(seen[0], [114.158, 22.285]) < 0.01, '点按换回店铺坐标');
    const pin = new NativeMarkerOverlay({ position: [114.158, 22.285], kind: 'pin' });
    pin.setMap(map);
    await tick(5);
    const marker = plugin.last('setOverlays').markers[0];
    assert.ok(distanceMeters([marker.lng, marker.lat], [114.158, 22.285]) > 400, '覆盖物同样换算');
    map.setNodes([{ id: 'place:1', cluster: false, lng: 116.397, lat: 39.909, name: '大陆', glyph: 'place' }], null);
    await tick(5);
    assert.deepEqual(plugin.last('setNodes').coords, [116.397, 39.909], '大陆仍是 GCJ-02，不换算');
    await map.calibrate();
    await tick(5);
    assert.equal(changes.length, 1, '结果不变不重发');
    map.destroy();
}

// ---- 握手失败：ready 拒绝，调用方回到高德 ----
{
    const map = new NativeMapView(canvas, { center: [113, 23], zoom: 10, session: new NativeMapSession({ plugin: new FakeMapPlugin({ protocol: 2 }) }) });
    await assert.rejects(map.ready);
    assert.equal(rootAttributes.has('data-native-map'), false);
    map.destroy();
}

// ---- 触摸：地图画布及其祖先交给原生，其余网页元素按自身矩形留给网页 ----
{
    const shell = { contains: (el) => el === shell || el === canvasEl, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }) };
    const canvasEl = { contains: (el) => el === canvasEl };
    const button = { contains: (el) => el === button, getBoundingClientRect: () => ({ left: 70, top: 10, right: 94, bottom: 34 }) };
    const icon = { contains: (el) => el === icon, getBoundingClientRect: () => ({ left: 76, top: 16, right: 88, bottom: 28 }) };
    const notice = { contains: () => false, getBoundingClientRect: () => ({ left: -20, top: 80, right: 200, bottom: 120 }) };
    const hit = (x, y) => {
        if (x >= 76 && x < 88 && y >= 16 && y < 28) return icon;
        if (x >= 70 && x < 94 && y >= 10 && y < 34) return button;
        if (y >= 80) return notice;
        if (x < 10) return shell;
        return canvasEl;
    };
    const holes = sampleTouchHoles({ canvas: canvasEl, rect: { left: 0, top: 0, width: 100, height: 100 }, step: 4, elementFromPoint: hit });
    assert.deepEqual(holes, [
        { x: 70, y: 10, width: 24, height: 24 },
        { x: 0, y: 80, width: 100, height: 20 }
    ], '图标被按钮包住不重复发，越界的公告裁到画布内，页面外壳与画布本身不算网页区域');

    // 会走动的元素（底栏小伙伴）不进网格采样，由 liveTouchHoles 按实时位置单独给出
    const companion = { contains: (el) => el === companion, closest: () => companion,
        getBoundingClientRect: () => ({ left: 20, top: 40, right: 60, bottom: 90 }) };
    const withCompanion = (x, y) => (x >= 20 && x < 60 && y >= 40 && y < 80 ? companion : hit(x, y));
    const grid = sampleTouchHoles({ canvas: canvasEl, rect: { left: 0, top: 0, width: 100, height: 100 }, step: 4, elementFromPoint: withCompanion });
    assert.ok(!grid.some((hole) => hole.x === 20 && hole.y === 40), '走动的元素不进网格采样');
    assert.deepEqual(liveTouchHoles({ rect: { left: 0, top: 0, width: 100, height: 85 }, elements: [companion] }),
        [{ x: 20, y: 40, width: 40, height: 45 }], '走动元素的矩形裁到画布内');
}

// ---- 原生标记层：网页聚合引擎出快照与转场计划，交给原生 ----
{
    class FakeMap {
        constructor() {
            this.handlers = new Map();
            this.calls = [];
            this.zoom = 18;
            this.center = [113.3, 23.1];
        }
        on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
        off(type, fn) { this.handlers.get(type)?.delete(fn); }
        emit(type, event = {}) { return Promise.all([...this.handlers.get(type) || []].map((fn) => fn(event))); }
        getZoom() { return this.zoom; }
        getZooms() { return [3, 20]; }
        getBounds() {
            const span = 0.02 * Math.pow(2, 18 - this.zoom);
            const sw = { lng: this.center[0] - span, lat: this.center[1] - span };
            const ne = { lng: this.center[0] + span, lat: this.center[1] + span };
            return { getSouthWest: () => sw, getNorthEast: () => ne };
        }
        setNodes(nodes, plan, options) { this.calls.push(['nodes', nodes, plan, options]); return this.onSetNodes?.(); }
        setSelectedPlace(id) { this.calls.push(['selected', id]); }
        setMarkerStyle(style) { this.calls.push(['style', style]); }
        last(kind) { return this.calls.filter(([k]) => k === kind).at(-1); }
        count(kind) { return this.calls.filter(([k]) => k === kind).length; }
    }
    const until = async (predicate) => {
        const end = Date.now() + 2000;
        while (!predicate()) {
            assert.ok(Date.now() < end, 'native marker update settled');
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const settle = (layer) => until(() => !layer.pendingView);
    {
        const asyncMap = new FakeMap();
        const runtime = createComputeRuntime();
        const operations = [];
        const asyncLayer = new NativeMarkerLayer(asyncMap, { workerOptions: {
            createWorker: () => ({
                postMessage(message) {
                    operations.push(message.op);
                    queueMicrotask(async () => {
                        const result = await runtime.handle(message);
                        this.onmessage?.({ data: { requestId: message.requestId, result } });
                    });
                },
                terminate() {}
            })
        } });
        const place = (id) => ({ id, name: String(id), longitude: 113.3, latitude: 23.1 });
        let acknowledge;
        asyncMap.onSetNodes = () => new Promise((resolve) => { acknowledge = resolve; });
        asyncLayer.update({ places: [place(901)] });
        assert.equal(asyncMap.count('nodes'), 0, 'native update yields before committing a new cluster snapshot');
        await until(() => !!acknowledge);
        asyncLayer.update({ places: [place(902)] });
        asyncLayer.update({ places: [place(903)] });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(asyncMap.count('nodes'), 1, 'only one native snapshot is in flight');
        asyncMap.onSetNodes = null;
        acknowledge({ count: 1 });
        await until(() => asyncMap.count('nodes') === 2);
        const [, nodes, , options] = asyncMap.last('nodes');
        assert.deepEqual(nodes.map((node) => node.id), ['place:903'], 'only the latest waiting snapshot reaches MapKit');
        assert.deepEqual([...options.prevKeys], ['place:901'], 'transition starts from the snapshot acknowledged by MapKit');
        assert.deepEqual(operations.slice(0, 3), ['compute', 'commitAck', 'compute']);
        await settle(asyncLayer);

        let delivery = 0;
        asyncMap.onSetNodes = () => ++delivery === 1 ? null : { count: 1 };
        asyncLayer.update({ places: [place(904)] });
        await settle(asyncLayer);
        assert.equal(delivery, 2, 'a failed native delivery gets one resync attempt');
        const [, retriedNodes, , resync] = asyncMap.last('nodes');
        assert.deepEqual(retriedNodes.map((node) => node.id), ['place:904']);
        assert.equal(resync.animate, false, 'resync does not assume the failed call left the native layer untouched');
        assert.equal(resync.prevKeys.size, 0);
        asyncLayer.destroy();
    }

    const map = new FakeMap();
    const clicked = [];
    const clusters = [];
    const layer = new NativeMarkerLayer(map, {
        onPlaceClick: (place) => clicked.push(place.id),
        onClusterClick: async (node) => clusters.push([node.key, (await layer.getClusterMembers(node.key, node.dataRevision)).length])
    });
    assert.equal(map.count('style'), 1, '创建时下发一次样式');
    // 两组相距约 50 米的店：放大时各自分开，缩小后合并
    const places = [
        { id: 1, name: '甲', longitude: 113.3000, latitude: 23.1000 },
        { id: 2, name: '乙', longitude: 113.3005, latitude: 23.1000 },
        { id: 3, name: '避雷', longitude: 113.3010, latitude: 23.1000, rating_count: 3, rating_average: 1.2 },
        { id: 'amap_B0', isMarked: false, name: '未收录', longitude: 113.3015, latitude: 23.1000 },
        { id: 4, name: '没坐标', longitude: 'x', latitude: 23 },
        null
    ];
    layer.update({ places });
    await settle(layer);
    let [, nodes, plan, options] = map.last('nodes');
    assert.deepEqual(nodes.map((n) => [n.id, n.cluster, n.glyph, n.name]), [
        ['place:1', false, 'place', '甲'], ['place:2', false, 'place', '乙'], ['place:3', false, 'avoid', '避雷'], ['poi:amap:B0', false, 'add', '未收录']
    ], '18 级时四家店各自显示');
    assert.equal(options.animate, false, '首份快照不播放转场');
    assert.equal(plan.kind, 'initial');

    layer.update({ places: places.map((p) => ({ ...p, favorite: true })) });
    await settle(layer);
    assert.equal(map.count('nodes'), 1, '与标记无关的字段变化不重发');

    // 缩小到 14 级：四家店合并成一个聚合，计划是 mergeInto → 同一个父聚合
    map.zoom = 14;
    map.emit('movestart');
    layer.update({ places: places.slice(0, 3) });
    await settle(layer);
    assert.equal(map.count('nodes'), 1, '相机移动中不换节点');
    map.emit('moveend');
    await settle(layer);
    [, nodes, plan, options] = map.last('nodes');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].cluster, true);
    assert.equal(nodes[0].count, 3, '移动中的数据变化在相机静止后一起提交');
    assert.equal(options.animate, true);
    assert.ok(options.prevKeys.has('place:1'), '计划对照上一份发给原生的节点');
    assert.ok(plan.mergeTargets.has(nodes[0].id) || plan.kind === 'data', '缩小时子节点并进父聚合');

    // 平移一点点：节点没变不重发
    const sentBefore = map.count('nodes');
    map.center = [113.3001, 23.1001];
    map.emit('movestart');
    map.emit('moveend');
    await settle(layer);
    assert.equal(map.count('nodes'), sentBefore, '平移后节点不变不重发');

    // 放大回 18 级：聚合拆开，子节点从父聚合出发
    const parentKey = nodes[0].id;
    map.zoom = 18;
    map.center = [113.3, 23.1];
    map.emit('movestart');
    map.emit('moveend');
    await settle(layer);
    [, nodes, plan, options] = map.last('nodes');
    assert.equal(nodes.length, 3);
    assert.equal(plan.kind, 'zoom-in');
    assert.ok(plan.splitSources.has(parentKey), '被拆开的父聚合');
    assert.deepEqual(nodes.map((n) => plan.splitFrom.get(n.id)), [parentKey, parentKey, parentKey], '子节点从父聚合位置飞出');

    // 移动中（捏合、松手后的减速、点聚合后的放大动画）：聚合层级一变就换节点，不等 moveend
    map.zoom = 14;
    map.emit('movestart');
    let sent = map.count('nodes');
    map.zoom = 17.9;
    map.emit('mapmove');
    await settle(layer);
    map.zoom = 17.4;
    map.emit('mapmove');
    await settle(layer);
    assert.equal(map.count('nodes'), sent, '还没越过滞回边界（18 ± 0.65）：不换');
    map.zoom = 16.3;
    map.emit('mapmove');
    await settle(layer);
    assert.equal(map.count('nodes'), sent + 1, '缩小到另一个聚合层级：移动中立即换节点');
    assert.equal(map.last('nodes')[1].length, 1, '四家店合并');
    assert.equal(map.last('nodes')[3].animate, true, '移动中换节点也播放合并 / 拆分');
    sent = map.count('nodes');
    map.zoom = 16.1;
    map.emit('mapmove');
    await settle(layer);
    assert.equal(map.count('nodes'), sent, '同一聚合层级内移动不换');
    layer.update({ places: places.slice(0, 2) });
    await settle(layer);
    map.emit('mapmove');
    await settle(layer);
    assert.equal(map.count('nodes'), sent, '移动中数据变化仍等相机静止');
    map.center = [113.6, 23.1];
    map.emit('mapmove');
    await settle(layer);
    assert.equal(map.count('nodes'), sent + 1, '平移出缓冲区：移动中补节点');
    map.zoom = 18;
    map.center = [113.3, 23.1];
    map.emit('moveend');
    await settle(layer);
    [, nodes] = map.last('nodes');
    assert.equal(nodes.length, 2, '静止后数据变化一起提交');
    layer.update({ places: places.slice(0, 3) });
    await settle(layer);

    // 点按：单点交给 onPlaceClick，聚合交给 onClusterClick（与网页同一个展开逻辑）
    map.emit('markerTap', { id: 'place:2' });
    map.emit('markerTap', { id: 'place:404' });
    assert.deepEqual(clicked, [2]);
    map.zoom = 14;
    map.emit('movestart');
    map.emit('moveend');
    await settle(layer);
    const cluster = map.last('nodes')[1][0];
    await map.emit('clusterTap', { id: cluster.id });
    await map.emit('clusterTap', { id: 'place:1' });
    assert.deepEqual(clusters, [[cluster.id, 3]]);

    // 校准结果变化：同一份节点重发，不播放转场
    map.emit('framechange', { frames: { hk: 'wgs' } });
    map.emit('moveend');
    await settle(layer);
    assert.equal(map.last('nodes')[3].animate, false);

    layer.setSelectedKey('place:1');
    layer.setSelectedKey('place:1');
    assert.equal(map.count('selected'), 1);
    assert.deepEqual(layer.getDataBounds(), { minLng: 113.3, minLat: 23.1, maxLng: 113.301, maxLat: 23.1 });
    assert.equal(NATIVE_BUFFER_RATIO, 1);
    layer.destroy();
    assert.equal([...map.handlers.values()].reduce((n, set) => n + set.size, 0), 0, '销毁后不再监听');
    assert.deepEqual(nativeNode({ key: 'place:9', kind: 'place', coordinate: [1, 2], count: 1, place: { id: 9 } }),
        { id: 'place:9', cluster: false, lng: 1, lat: 2, count: 1, name: '', glyph: 'place' });

    // 跨瓦片级别时保留旧聚合，直到明细到达才发送一次拆分转场。
    const tileMap = new FakeMap();
    const tileLayer = new NativeMarkerLayer(tileMap);
    const aggregateBand = { kind: 'aggregate', tile: 8, cell: 14, minZoom: 11, maxZoom: 12 };
    const leafBand = { kind: 'leaf', tile: 12, minZoom: 13 };
    const leafPlaces = [
        { id: 101, name: '甲', longitude: 113.300, latitude: 23.1 },
        { id: 102, name: '乙', longitude: 113.318, latitude: 23.1 },
        { id: 103, name: '丙', longitude: 113.264, latitude: 23.075 }
    ];
    const aggregatePlaces = leafPlaces.map(({ id, longitude, latitude }) => {
        const [x, y] = tileOf(longitude, latitude, aggregateBand.cell);
        return { longitude: id === 103 ? lngOf(x + 0.875, 14) : longitude, latitude,
            aggregate: true, aggregateCell: [aggregateBand.cell, x, y], aggregateKey: `agg:14/${x}/${y}#0` };
    });
    tileMap.zoom = 12;
    tileLayer.update({ places: aggregatePlaces, queryMode: 'nearby', markerBand: aggregateBand });
    await settle(tileLayer);
    const [, aggregateNodes] = tileMap.last('nodes');
    const aggregate = aggregateNodes.find((node) => node.cluster);
    assert.equal(aggregate.count, 2, '12 级时两个匿名点合为一处聚合');

    tileMap.emit('movestart');
    tileMap.zoom = 13;
    tileMap.emit('mapmove');
    await settle(tileLayer);
    assert.equal(tileMap.count('nodes'), 1, '缩放中不提前拆开旧瓦片的匿名点');
    tileMap.emit('moveend');
    await settle(tileLayer);
    assert.equal(tileMap.count('nodes'), 1, '没有明细时，相机停下也保留原聚合');

    tileLayer.update({ places: leafPlaces, queryMode: 'nearby', markerBand: leafBand });
    await settle(tileLayer);
    assert.equal(tileMap.count('nodes'), 2, '明细到达时只发送一份转场');
    const [, leafNodes, leafPlan, leafOptions] = tileMap.last('nodes');
    assert.deepEqual(leafNodes.map((node) => node.id), ['place:101', 'place:102', 'place:103']);
    assert.deepEqual([...leafOptions.prevKeys], aggregateNodes.map((node) => node.id), '从此前显示的匿名节点过渡');
    assert.deepEqual([...leafPlan.splitFrom], [['place:101', aggregate.id], ['place:102', aggregate.id]]);
    const standaloneAnchor = aggregateNodes.find((node) => !node.cluster);
    const detail = leafNodes.find((node) => node.id === 'place:103');
    assert.deepEqual([detail.lng, detail.lat], [standaloneAnchor.lng, standaloneAnchor.lat], '拆分时独立标记继续使用屏幕上已有的地理锚点');
    assert.equal(leafOptions.animate, true);
    tileLayer.update({ places: leafPlaces, queryMode: 'nearby', markerBand: leafBand });
    await settle(tileLayer);
    assert.equal(tileMap.count('nodes'), 2, '静止时重复提交明细不会重新定位');
    tileMap.emit('movestart');
    tileMap.zoom = 12;
    tileMap.emit('moveend');
    await settle(tileLayer);
    tileLayer.update({ places: aggregatePlaces, queryMode: 'nearby', markerBand: aggregateBand });
    await settle(tileLayer);
    const [, zoomedOutNodes, mergePlan] = tileMap.last('nodes');
    const mergedStandalone = zoomedOutNodes.find((node) => !node.cluster);
    assert.deepEqual([mergedStandalone.lng, mergedStandalone.lat], [detail.lng, detail.lat], '合并时独立标记仍固定');
    assert.deepEqual([...mergePlan.mergeInto.keys()], ['place:101', 'place:102']);

    tileMap.zoom = 13;
    tileMap.emit('moveend');
    await settle(tileLayer);
    tileLayer.update({ places: leafPlaces, queryMode: 'nearby', markerBand: leafBand });
    await settle(tileLayer);
    tileMap.emit('movestart');
    tileMap.zoom = 13.075;
    tileMap.emit('mapmove');
    await settle(tileLayer);
    const intermediate = tileMap.last('nodes')[1].find((node) => node.id === 'place:103');
    assert.ok(intermediate.lng > Math.min(detail.lng, leafPlaces[2].longitude)
        && intermediate.lng < Math.max(detail.lng, leafPlaces[2].longitude), '继续放大的中间帧逐步接近明细位置');
    const refinementFrames = tileMap.count('nodes');
    tileMap.zoom = 13.02;
    tileMap.emit('mapmove');
    await settle(tileLayer);
    assert.equal(tileMap.count('nodes'), refinementFrames, '手势短暂缩回时标记不沿修正轨迹倒退');
    tileMap.zoom = 13.3;
    tileMap.emit('mapmove');
    await settle(tileLayer);
    const [, refinedNodes, refinePlan] = tileMap.last('nodes');
    const refined = refinedNodes.find((node) => node.id === 'place:103');
    assert.ok(Math.abs(refined.lng - 113.264) < 1e-7, '继续放大时采用真实明细位置');
    assert.ok(refinePlan.reanchor.has('place:103'), '补齐明细位置时不额外播放滑动动画');
    tileMap.emit('moveend');
    await settle(tileLayer);
    tileMap.zoom = 12;
    tileMap.emit('moveend');
    await settle(tileLayer);
    tileLayer.update({ places: aggregatePlaces, queryMode: 'nearby', markerBand: aggregateBand });
    await settle(tileLayer);
    const coarseWithExactAnchor = tileMap.last('nodes')[1].find((node) => !node.cluster);
    assert.deepEqual([coarseWithExactAnchor.lng, coarseWithExactAnchor.lat], [refined.lng, refined.lat], '已知精确位置的点缩小时保持在原处');
    tileLayer.destroy();

    // 街区级先显示缺块的匿名点，明细瓦片在同级到达时，名称和点击对象原地更新。
    const fallbackMap = new FakeMap();
    const fallbackClicks = [];
    const fallbackLayer = new NativeMarkerLayer(fallbackMap, { onPlaceClick: (place) => fallbackClicks.push(place.id) });
    fallbackMap.zoom = 13;
    fallbackLayer.update({ places: [leafPlaces[0], aggregatePlaces[2]], markerBand: leafBand });
    await settle(fallbackLayer);
    const fallback = fallbackMap.last('nodes')[1].find((node) => node.id === aggregatePlaces[2].aggregateKey);
    fallbackLayer.update({ places: [leafPlaces[0], leafPlaces[2]], markerBand: leafBand });
    await settle(fallbackLayer);
    const [, recoveredNodes, recoveryPlan] = fallbackMap.last('nodes');
    const recovered = recoveredNodes.find((node) => node.id === 'place:103');
    assert.equal(recoveryPlan.reuse.get(recovered.id), fallback.id, '明细补到时沿用同格匿名标记');
    assert.equal(recovered.name, '丙');
    assert.deepEqual([recovered.lng, recovered.lat], [fallback.lng, fallback.lat], '补到名称时保留匿名点已显示的位置');
    fallbackMap.emit('markerTap', { id: recovered.id });
    assert.deepEqual(fallbackClicks, [103]);
    fallbackLayer.setSelectedKey(recovered.id);
    await settle(fallbackLayer);
    const selected = fallbackMap.last('nodes')[1].find((node) => node.id === recovered.id);
    assert.ok(Math.abs(selected.lng - leafPlaces[2].longitude) < 1e-7
        && Math.abs(selected.lat - leafPlaces[2].latitude) < 1e-7, '选中时采用明细坐标');
    fallbackLayer.destroy();

    const selectionMap = new FakeMap();
    const selectionLayer = new NativeMarkerLayer(selectionMap);
    selectionMap.zoom = 13;
    selectionLayer.update({ places: [leafPlaces[0], aggregatePlaces[2]], markerBand: leafBand });
    await settle(selectionLayer);
    selectionLayer.update({ places: [leafPlaces[0], leafPlaces[2]], markerBand: leafBand });
    selectionLayer.setSelectedKey('place:103');
    await settle(selectionLayer);
    const newlySelected = selectionMap.last('nodes')[1].find((node) => node.id === 'place:103');
    assert.ok(Math.abs(newlySelected.lng - leafPlaces[2].longitude) < 1e-7,
        'selection arriving during compute uses the selected place’s precise position');
    selectionLayer.destroy();

    // 上一次停在 13 级，回捏到 12 级时才收到明细，仍保留画面上的匿名聚合。
    const reverseMap = new FakeMap();
    let settledZoom = 12;
    const clickedMembers = [];
    const reverseLayer = new NativeMarkerLayer(reverseMap, {
        getMarkerViewZoom: (zoom) => computeLogicalZoom(zoom, settledZoom),
        onClusterClick: async (node) => clickedMembers.push(...(await reverseLayer.getClusterMembers(node.key, node.dataRevision)).map((place) => place.aggregateKey))
    });
    reverseMap.zoom = 12;
    reverseLayer.update({ places: aggregatePlaces, queryMode: 'nearby', markerBand: aggregateBand });
    await settle(reverseLayer);
    const reverseAggregate = reverseMap.last('nodes')[1].find((node) => node.cluster);
    reverseMap.emit('movestart');
    reverseMap.zoom = 13;
    reverseMap.emit('mapmove');
    await settle(reverseLayer);
    reverseMap.emit('moveend');
    await settle(reverseLayer);
    settledZoom = 13;

    reverseMap.emit('movestart');
    reverseMap.zoom = 13.35;
    reverseLayer.update({ places: leafPlaces, queryMode: 'nearby', markerBand: leafBand });
    reverseMap.emit('mapmove');
    reverseMap.zoom = 12;
    reverseMap.emit('mapmove');
    await settle(reverseLayer);
    assert.equal(reverseMap.count('nodes'), 1, '回到 12 级时不显示迟到的明细');
    await reverseMap.emit('clusterTap', { id: reverseAggregate.id });
    assert.deepEqual(clickedMembers, aggregatePlaces.slice(0, 2).map((place) => place.aggregateKey), '点按仍使用画面上的聚合成员');

    reverseMap.zoom = 12.48;
    reverseMap.emit('moveend');
    await settle(reverseLayer);
    assert.equal(reverseMap.count('nodes'), 2, '停在 12.48 时按上次停在 13 级的滞回规则显示明细');
    assert.equal(reverseMap.last('nodes')[3].animate, true);
    reverseLayer.destroy();
}

// ---- 标记样式：与 marker-motion.css 同一套取值 ----
{
    const vars = {
        '--theme-primary': '#E2789F', '--color-bg-surface': '#FFFFFF', '--color-text-primary': '#2B2533',
        '--color-on-emphasis': '#2B2533', '--color-danger': '#D9534F', '--color-danger-text': '#B64642', '--color-bg-overlay': '#F2EEF5'
    };
    const imageSource = (src) => (String(src).endsWith('.svg') ? undefined : `capacitor://localhost${src}`);
    const defaults = {
        place: { src: '/assets/yes.png', fallback: '/assets/yes.png' },
        avoid: { src: '/assets/no.png', fallback: '/assets/no.png' },
        unexplored: { src: '/assets/unverified.png', fallback: '/assets/unverified.png' },
        add: { src: '/assets/add.png', fallback: '/assets/add.png' },
        cluster: { src: '/assets/union.png', fallback: '/assets/union.png', isDefault: true }
    };
    const style = buildNativeMarkerStyle({ readVar: (name) => vars[name] || '', sources: defaults, imageSource });
    assert.equal(style.glyphs.place, 'capacitor://localhost/assets/yes.png');
    assert.equal(style.labelBorder, '#e2789f', '名称描边是主题色');
    assert.equal(style.avoidText, '#b64642');
    assert.equal(style.clusterCrop.length, 4, '默认聚合图裁去留白');
    assert.deepEqual([style.countX, style.countY], [0.5, 0.35]);
    assert.ok(style.clusterLabel.includes('%d'));

    const skinned = buildNativeMarkerStyle({
        readVar: (name) => ({ ...vars, '--skin-marker-label-border': 'rgb(0, 128, 0)', '--skin-marker-count-x': '60%' })[name] || '',
        sources: { ...defaults, place: { src: '/skin/place.svg', fallback: '/assets/yes.png' }, cluster: { src: '/skin/cluster.png', fallback: '/assets/union.png', isDefault: false } },
        imageSource
    });
    assert.equal(skinned.glyphs.place, 'capacitor://localhost/assets/yes.png', 'SVG 皮肤图退回默认图');
    assert.equal(skinned.clusterImage, 'capacitor://localhost/skin/cluster.png');
    assert.equal(skinned.clusterCrop, undefined, '皮肤聚合图用整张画布');
    assert.deepEqual([skinned.countX, skinned.countY], [0.6, 0.3]);
    assert.equal(skinned.labelBorder, '#008000');
}

// ---- 与 Swift 源码对照 ----
{
    const read = (name) => readFileSync(new URL(`../../../ios/App/App/${name}`, import.meta.url), 'utf8');
    const plugin = read('NativeMapPlugin.swift');
    const set = (name) => [...plugin.split(`static let ${name}: Set<String> = [`)[1].split(']')[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.equal(Number(plugin.match(/static let protocolVersion = (\d+)/)[1]), NATIVE_MAP_PROTOCOL);
    assert.deepEqual(set('glyphKinds'), [...NATIVE_MAP_GLYPHS].sort());
    assert.deepEqual(set('overlayKinds'), [...NATIVE_MAP_OVERLAY_KINDS].sort());
    for (const method of ['attach', 'setCamera', 'fitBounds', 'panBy', 'setStyle', 'setNodes', 'search', 'setSelected', 'setOverlays', 'setAppearance', 'setInsets', 'setTouch', 'dispose']) {
        assert.match(plugin, new RegExp(`CAPPluginMethod\\(name: "${method}"`), `Swift 插件缺少 ${method}`);
    }
    const bridge = read('FoodMapBridgeViewController.swift');
    assert.match(bridge, /registerPluginInstance\(map\)/, '根控制器注册原生底图插件');
    assert.match(bridge, /FoodMapWebView\(frame: frame, configuration: configuration\)/, 'WebView 用带触摸分配的子类');
    assert.match(bridge, /insertSubview\(mapController\.mapView, at: 0\)/, '底图在 WebView 下面');
    assert.match(bridge, /view\.addGestureRecognizer\(gesture\)/, '侧滑返回挂在容器上，地图区域也能识别');
    const controller = read('NativeMapController.swift');
    // 与 cluster/glyph.js 的聚合缩放与数字格式一致
    assert.match(controller, /min\(0\.55, 0\.09 \* log2/);
    assert.match(controller, /growth \* \(0\.3 \/ 0\.55\)/);
    assert.match(controller, /text\.count <= 2 \? 20 : text\.count == 3 \? 16 : 13/);
    // 原生转场与网页 MARKER_TIMING 同一组时长（秒 = 毫秒 / 1000）
    for (const [key, ms] of Object.entries({ merge: MARKER_TIMING.merge, mergeTargetDelay: MARKER_TIMING.mergeTargetDelay, mergeTarget: MARKER_TIMING.mergeTarget,
        split: MARKER_TIMING.split, splitSource: MARKER_TIMING.splitSource, fadeIn: MARKER_TIMING.fadeIn, fadeOut: MARKER_TIMING.fadeOut,
        reposition: MARKER_TIMING.reposition, reducedFade: MARKER_TIMING.reducedFade })) {
        const match = controller.match(new RegExp(`static let ${key}: CFTimeInterval = ([0-9.]+)`));
        assert.ok(match, `Swift 缺少时长 ${key}`);
        assert.equal(Math.round(Number(match[1]) * 1000), ms, `${key} 与网页一致`);
    }
    assert.doesNotMatch(controller, /clusteringIdentifier = (?!nil)/, '不用 MapKit 自带的聚合');
    const setNodes = controller.slice(controller.indexOf('func setNodes('), controller.indexOf('private func finishTransitions()'));
    assert.doesNotMatch(setNodes, /finishTransitions\(\)/, '提交快照时不打断未改变标记上的动画');
    assert.doesNotMatch(setNodes, /inputs\.count <= Self\.animatedNodeLimit/, '缓冲区节点不能关闭眼前的转场');
    assert.match(setNodes, /isOnScreen\(view\), takeAnimationSlot\(\)/, '屏内退出标记分享动画预算');
    assert.match(setNodes, /visibleToAnimation\(input\.coordinate\), takeAnimationSlot\(\)/, '屏内新标记分享动画预算');
    // MapKit 会改动 setVisibleMapRect 的请求（放进自己的可见区域）：iOS 点聚合只放大一点点、补放大落在同一处就打开成员列表。
    // 设置相机前按同步试探学到的比例与偏移修正请求；试探不回传相机事件；事件与平移的中心取可见矩形的中点
    const setCamera = controller.slice(controller.indexOf('func setCamera('), controller.indexOf('private func calibrateCameraFit()'));
    assert.match(setCamera, /calibrateCameraFit\(\)[\s\S]*cameraFit\?\.request\(for: target[\s\S]*setVisibleMapRect\(request, animated: animated\)/);
    const calibrate = controller.slice(controller.indexOf('private func calibrateCameraFit()'), controller.indexOf('func panBy('));
    assert.match(calibrate, /guard cameraFit\?\.key != key, !moving/, '动画、手势进行中不试探');
    assert.match(calibrate, /calibratingCamera = true[\s\S]*setVisibleMapRect\(probe, animated: false\)[\s\S]*NativeMapCameraFit\.measure/);
    assert.match(calibrate, /layoutMargins[\s\S]*safeAreaInsets/, '边距、安全区变化后重新试探');
    for (const delegate of ['regionWillChangeAnimated', 'mapViewDidChangeVisibleRegion(', 'regionDidChangeAnimated']) {
        const body = controller.slice(controller.indexOf(delegate), controller.indexOf(delegate) + 200);
        assert.match(body, /!calibratingCamera/, `${delegate} 在试探期间不回传`);
    }
    assert.match(controller, /let center = visibleCenter\.coordinate/, '相机事件的中心与网页投影一致');
    assert.match(controller, /struct NativeMapCameraFit[\s\S]*scale >= 0\.5, scale <= 4[\s\S]*func request\(for target: MKMapRect/);
    const pbxproj = readFileSync(new URL('../../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
    for (const file of ['FoodMapWebView.swift', 'NativeMapController.swift', 'NativeMapPlugin.swift']) {
        assert.ok(pbxproj.includes(`/* ${file} in Sources */,`), `${file} 要加入 Xcode 工程的 Sources`);
    }
}

console.log('native map tests passed (JS + Swift source contracts; Swift not compiled)');
