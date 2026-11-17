// iOS 原生底图（MapKit）网页侧：协议清洗、会话、AMap.Map 替身（相机、投影、事件、覆盖物）、触摸命中采样、原生标记层，
// 以及与 Swift 源码的白名单 / 版本对照。Swift 不在这里编译，真机检查见 native/doc/README.md。
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
    nativeColor, encodeNativePlaces, sanitizeOverlayMarker, sanitizeOverlayLine, sanitizeHoles, encodeRect
} = await import('../../../src/platform/nativeMap.js');
const {
    NativeMapView, NativeMarkerOverlay, NativePolylineOverlay, isNativeMap, nativeMapAppearance, sampleTouchHoles, readPoint
} = await import('../../../src/map/nativeMapView.js');
const { NativeMarkerLayer, buildNativeMarkerStyle, nativeMarkerEntries } = await import('../../../src/map/nativeMarkerLayer.js');
const { worldPixel } = await import('../../../src/map/viewport.js');
const { CLUSTER_DEFAULTS } = await import('../../../src/map/cluster/engine.js');

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
for (const method of ['setCamera', 'panBy', 'setStyle', 'setPlaces', 'setSelected', 'setOverlays', 'setAppearance', 'setInsets', 'setTouch', 'dispose']) {
    FakeMapPlugin.prototype[method] = async function (args) {
        this.calls.push([method, args]);
        if (method !== 'dispose' && args.sessionId !== this.session) throw new Error('STALE_SESSION');
        return {};
    };
}
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

    const encoded = encodeNativePlaces([
        { id: 'place:1', lng: 113.3, lat: 23.1, name: '店', kind: 'avoid' },
        { id: 'place:2', lng: 200, lat: 23.1, name: '超出范围' },
        { id: '', lng: 113, lat: 23 },
        { id: 'place:3', lng: 113.4, lat: 23.2, name: 'x'.repeat(200), kind: 'evil' }
    ]);
    assert.deepEqual(encoded.ids, ['place:1', 'place:3']);
    assert.deepEqual(encoded.coords, [113.3, 23.1, 113.4, 23.2]);
    assert.deepEqual(encoded.kinds, ['avoid', 'place'], '未知图标种类按普通地点');
    assert.equal(encoded.names[1].length, 80, '名称截断');

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

    map.destroy();
    await tick(5);
    assert.equal(rootAttributes.has('data-native-map'), false);
    assert.equal(plugin.count('dispose'), 1);
    map.setZoom(5);
    await tick(5);
    assert.equal(plugin.count('setCamera'), 2, '销毁后的调用不发');
    assert.deepEqual(readPoint({ getLng: () => 1, getLat: () => 2 }), [1, 2]);
    assert.equal(readPoint([1, 99]), null);
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
}

// ---- 原生标记层 ----
{
    const calls = [];
    const handlers = new Map();
    const fakeMap = {
        on: (type, fn) => handlers.set(type, fn),
        off: (type) => handlers.delete(type),
        setPlaces: (entries, selected) => calls.push(['places', entries.map((e) => [e.id, e.kind, e.name]), selected]),
        setSelectedPlace: (id) => calls.push(['selected', id]),
        setMarkerStyle: (style) => calls.push(['style', style])
    };
    const clicked = [];
    const members = [];
    const layer = new NativeMarkerLayer(fakeMap, { onPlaceClick: (place) => clicked.push(place.id), onClusterMembers: (value) => members.push(value) });
    assert.equal(calls.filter(([kind]) => kind === 'style').length, 1, '创建时下发一次样式');
    const places = [
        { id: 1, name: '甲', longitude: 113.3, latitude: 23.1, rating_count: 0 },
        { id: 1, name: '重复', longitude: 113.3, latitude: 23.1 },
        { id: 2, name: '避雷', longitude: 113.4, latitude: 23.2, rating_count: 3, rating_average: 1.2 },
        { id: 'amap_B0', isMarked: false, name: '未收录', longitude: 113.5, latitude: 23.3 },
        { id: 3, name: '没坐标', longitude: 'x', latitude: 23 }
    ];
    layer.update({ places });
    const sent = calls.filter(([kind]) => kind === 'places');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][1], [['place:1', 'place', '甲'], ['place:2', 'avoid', '避雷'], ['poi:amap:B0', 'add', '未收录']]);
    layer.update({ places: places.map((p) => ({ ...p, favorite: true })) });
    assert.equal(calls.filter(([kind]) => kind === 'places').length, 1, '与标记无关的字段变化不重发');
    layer.update({ places: [{ ...places[0], name: '甲改' }] });
    assert.equal(calls.filter(([kind]) => kind === 'places').length, 2);
    layer.setSelectedKey('place:1');
    layer.setSelectedKey('place:1');
    assert.deepEqual(calls.filter(([kind]) => kind === 'selected'), [['selected', 'place:1']]);
    handlers.get('markerTap')({ id: 'place:1' });
    handlers.get('markerTap')({ id: 'place:404' });
    assert.deepEqual(clicked, [1]);
    layer.update({ places });
    handlers.get('clusterMembers')({ ids: ['place:2', 'place:1', 'gone'], lng: 113.3, lat: 23.1 });
    assert.deepEqual(members[0].places.map((p) => p.id), [2, 1]);
    assert.deepEqual(members[0].coordinate, [113.3, 23.1]);
    assert.equal(layer.getEngine(), null);
    assert.deepEqual(layer.getDataBounds(), { minLng: 113.3, minLat: 23.1, maxLng: 113.5, maxLat: 23.3 });
    layer.destroy();
    assert.equal(handlers.size, 0);
    assert.equal(nativeMarkerEntries([{ id: 9, longitude: 1, latitude: 2 }])[0].name, '');
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
    assert.equal(style.collisionSize, CLUSTER_DEFAULTS.radiusPx, '碰撞框取网页的聚合半径');
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
    for (const method of ['attach', 'setCamera', 'fitBounds', 'panBy', 'setStyle', 'setPlaces', 'setSelected', 'setOverlays', 'setAppearance', 'setInsets', 'setTouch', 'dispose']) {
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
    const pbxproj = readFileSync(new URL('../../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
    for (const file of ['FoodMapWebView.swift', 'NativeMapController.swift', 'NativeMapPlugin.swift']) {
        assert.ok(pbxproj.includes(`/* ${file} in Sources */,`), `${file} 要加入 Xcode 工程的 Sources`);
    }
}

console.log('native map tests passed (JS + Swift source contracts; Swift not compiled)');
