// iOS 原生底图（MapKit）在网页里的替身：实现 MapView、MapUI、顺路吃、日记用到的那部分高德 AMap.Map 接口，
// 让这些代码不必区分底图是网页高德还是原生 MapKit。
//
// - 相机：原生的相机事件更新本地缓存；getCenter / getZoom / getBounds 读缓存，设置相机时先乐观更新缓存再发给原生。
//   缩放级别、投影与高德相同（Web Mercator、256 像素瓦片，viewport.js 的 worldPixel），所以 lngLatToContainer 在 JS 里算。
// - 事件：movestart / dragstart（手势）/ mapmove / moveend / zoomend / click / complete，与高德同名。
// - 覆盖物：NativeMarkerOverlay / NativePolylineOverlay 代替 AMap.Marker / AMap.Polyline（同样的 setMap、setOptions、
//   CLASS_NAME），add / remove 后合并成一次 setOverlays 下发。
// - 触摸：NativeMapTouch 用网页自己的命中判断（elementFromPoint）找出地图画布上方的网页元素，其余位置的触摸交给原生。
// - 坐标原样传给 MapKit（大陆 GCJ-02、境外 WGS-84，与高德一致）；港澳台与边境格子待真机实测，转换入口是 toNative / fromNative。
import { NativeMapSession, encodeNativePlaces, sanitizeOverlayMarker, sanitizeOverlayLine, encodeRect, sanitizeHoles, isNativeCoordinate } from '../platform/nativeMap.js';
import { worldPixel, unprojectWorldPixel, getMapSafeInsets } from './viewport.js';
import { subscribeOverlays, getOverlayEntries } from '../components/overlay/overlayStack.js';
import { onAppStateChange } from '../platform/lifecycle.js';

export const NATIVE_MAP_ZOOMS = Object.freeze([3, 20]);

let overlaySeq = 0;

/** 坐标交给 MapKit 前的转换（目前原样：MapKit 在大陆同样按 GCJ-02 显示） */
const toNative = (lng, lat) => [lng, lat];
const fromNative = (lng, lat) => [lng, lat];

export function isNativeMap(map) {
    return !!map && map.isNativeMap === true;
}

/**
 * 个性化地图的高德样式在 MapKit 里的近似：幻影黑、极夜蓝 → 深色；雅士灰 → 深色柔和；月光银 → 浅色柔和；
 * 标准 → 浅色；“夜间（随昼夜变化）”与未知样式跟界面的深浅色。MapKit 没有更多配色。
 */
export function nativeMapAppearance(style, pageDark = false) {
    const name = String(style || '').replace(/^amap:\/\/styles\//, '');
    switch (name) {
        case 'dark':
        case 'darkblue':
        case 'blue':
        case 'wine':
            return { dark: true, muted: false };
        case 'grey':
            return { dark: true, muted: true };
        case 'light':
        case 'whitesmoke':
        case 'fresh':
        case 'macaron':
        case 'graffiti':
            return { dark: false, muted: true };
        case 'normal':
        case 'default':
            return { dark: false, muted: false };
        default:
            return { dark: !!pageDark, muted: false };
    }
}

function lngLat(lng, lat) {
    return { lng, lat, getLng: () => lng, getLat: () => lat, toArray: () => [lng, lat] };
}

/** 高德接受的各种坐标写法：[lng, lat]、{ lng, lat }、AMap.LngLat */
export function readPoint(value) {
    if (!value) return null;
    const lng = Array.isArray(value) ? value[0] : (typeof value.getLng === 'function' ? value.getLng() : (value.lng ?? value.longitude));
    const lat = Array.isArray(value) ? value[1] : (typeof value.getLat === 'function' ? value.getLat() : (value.lat ?? value.latitude));
    const x = Number(lng), y = Number(lat);
    return isNativeCoordinate(x, y) ? [x, y] : null;
}

/** 高德的 avoid / padding 写法 [上, 右, 下, 左]（或单个数字） */
function readPadding(value) {
    if (Array.isArray(value) && value.length === 4) {
        const [top, right, bottom, left] = value.map((part) => Math.max(0, Number(part) || 0));
        return { top, right, bottom, left };
    }
    const all = Math.max(0, Number(value) || 0);
    return { top: all, right: all, bottom: all, left: all };
}

function boundsOf(points) {
    let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90, count = 0;
    for (const point of points) {
        if (!point) continue;
        const [lng, lat] = point;
        count += 1;
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    return count ? { minLng, minLat, maxLng, maxLat } : null;
}

// ---- 覆盖物 ----

class NativeOverlay {
    constructor() {
        this.id = `ov-${++overlaySeq}`;
        this.map = null;
        this.handlers = new Map();
    }

    setMap(map) {
        if (map === this.map) return;
        if (this.map) this.map.remove(this);
        if (map) map.add(this);
    }

    getMap() {
        return this.map;
    }

    on(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type).add(fn);
    }

    off(type, fn) {
        this.handlers.get(type)?.delete(fn);
    }

    _changed() {
        this.map?._scheduleOverlaySync();
    }
}

/**
 * 原生的点状覆盖物。kind：location（我的位置）/ pin（添加地点的图钉）/ badge（圆形徽记，路线起终点、日记站点序号）。
 * 颜色传 CSS 颜色（会转成 #RRGGBB），fill 缺省为定位蓝。
 */
export class NativeMarkerOverlay extends NativeOverlay {
    constructor({ position, kind = 'badge', text = '', fill, textColor, border, size = 28, zIndex = 100, label = '' }) {
        super();
        this.CLASS_NAME = 'AMap.Marker';
        this.options = { kind, text, fill, textColor, border, size, zIndex, label };
        this.position = readPoint(position);
    }

    setPosition(position) {
        this.position = readPoint(position);
        this._changed();
    }

    getPosition() {
        return this.position ? lngLat(this.position[0], this.position[1]) : null;
    }

    setOptions(patch) {
        this.options = { ...this.options, ...patch };
        if (patch && 'position' in patch) this.position = readPoint(patch.position);
        this._changed();
    }

    // 高德 Marker 的其余写法在原生里没有意义
    setTop() { }
    setzIndex(zIndex) { this.setOptions({ zIndex }); }

    _toNative() {
        if (!this.position) return null;
        const [lng, lat] = toNative(this.position[0], this.position[1]);
        return sanitizeOverlayMarker({ id: this.id, lng, lat, ...this.options });
    }

    _points() {
        return this.position ? [this.position] : [];
    }
}

/** 原生折线（路线、日记站点之间的虚线）。参数沿用 AMap.Polyline：path、strokeColor、strokeWeight、strokeOpacity、strokeStyle、zIndex */
export class NativePolylineOverlay extends NativeOverlay {
    constructor({ path = [], strokeColor, strokeWeight = 5, strokeOpacity = 1, strokeStyle = 'solid', zIndex = 100 } = {}) {
        super();
        this.CLASS_NAME = 'AMap.Polyline';
        this.options = { strokeColor, strokeWeight, strokeOpacity, strokeStyle, zIndex };
        this.path = (Array.isArray(path) ? path : []).map(readPoint).filter(Boolean);
    }

    setOptions(patch) {
        if (patch && Array.isArray(patch.path)) this.path = patch.path.map(readPoint).filter(Boolean);
        this.options = { ...this.options, ...patch };
        this._changed();
    }

    getPath() {
        return this.path.map(([lng, lat]) => lngLat(lng, lat));
    }

    _toNative() {
        return sanitizeOverlayLine({
            id: this.id,
            path: this.path.map(([lng, lat]) => toNative(lng, lat)),
            color: this.options.strokeColor,
            width: Number(this.options.strokeWeight),
            opacity: Number(this.options.strokeOpacity),
            dashed: this.options.strokeStyle === 'dashed',
            zIndex: Number(this.options.zIndex)
        });
    }

    _points() {
        return this.path;
    }
}

// ---- 触摸分配 ----

const TOUCH_STEP = 12;
const TOUCH_DEBOUNCE_MS = 60;
const TOUCH_MAX_WAIT_MS = 250;
const TOUCH_REFRESH_MS = 2000;

/**
 * 按网格在地图画布上调用 elementFromPoint：命中画布自身或它的祖先（页面外壳）的位置交给原生地图，
 * 命中任何别的网页元素（按钮、公告、面板、遮罩）时，把那个元素的矩形作为“网页区域”。
 * 与网页自己的点击判定一致，新增的网页控件不需要登记。
 */
export function sampleTouchHoles({ canvas, rect, step = TOUCH_STEP, elementFromPoint }) {
    const holes = [];
    const seen = new Set();
    for (let y = rect.top + step / 2; y < rect.top + rect.height; y += step) {
        for (let x = rect.left + step / 2; x < rect.left + rect.width; x += step) {
            const el = elementFromPoint(x, y);
            if (!el || seen.has(el)) continue;
            seen.add(el);
            if (el === canvas || canvas.contains(el) || el.contains(canvas)) continue;
            const box = el.getBoundingClientRect();
            const left = Math.max(rect.left, box.left), top = Math.max(rect.top, box.top);
            const right = Math.min(rect.left + rect.width, box.right), bottom = Math.min(rect.top + rect.height, box.bottom);
            if (right > left && bottom > top) holes.push({ left, top, right, bottom });
        }
    }
    // 被别的网页区域完全包住的矩形不用再发
    return holes
        .filter((a, index) => !holes.some((b, other) => other !== index && b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom
            && (b.left < a.left || b.top < a.top || b.right > a.right || b.bottom > a.bottom || other < index)))
        .map((r) => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }));
}

class NativeMapTouch {
    constructor(view) {
        this.view = view;
        this.active = false;
        this.lastSent = '';
        this.lastInsets = '';
        this.timer = 0;
        this.firstPending = 0;
        this.interval = 0;
        this.schedule = this.schedule.bind(this);
        this.observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(this.schedule) : null;
        this.stopOverlays = subscribeOverlays((list) => {
            // 模态浮层打开：立刻把触摸全交给网页，不等采样
            if (list.some((entry) => entry.modal && entry.status !== 'closing')) this._send(false);
            this.schedule();
        });
        this.stopLifecycle = onAppStateChange(({ active }) => { if (active) this.schedule(); });
        window.addEventListener('resize', this.schedule);
        document.addEventListener('transitionend', this.schedule, true);
        document.addEventListener('animationend', this.schedule, true);
    }

    setActive(active) {
        this.active = !!active;
        if (this.active) {
            this.observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert', 'aria-hidden'] });
            if (!this.interval) this.interval = window.setInterval(this.schedule, TOUCH_REFRESH_MS);
            this.schedule();
        } else {
            this.observer?.disconnect();
            window.clearInterval(this.interval);
            this.interval = 0;
            this._send(false);
        }
    }

    schedule() {
        if (!this.active) return;
        const now = Date.now();
        if (!this.firstPending) this.firstPending = now;
        window.clearTimeout(this.timer);
        const wait = Math.max(0, Math.min(TOUCH_DEBOUNCE_MS, TOUCH_MAX_WAIT_MS - (now - this.firstPending)));
        this.timer = window.setTimeout(() => {
            this.firstPending = 0;
            this.measure();
        }, wait);
    }

    measure() {
        if (!this.active) return;
        const canvas = this.view.container;
        if (!canvas || !canvas.isConnected) return this._send(false);
        const box = canvas.getBoundingClientRect();
        if (!box.width || !box.height) return this._send(false);
        const rect = { left: Math.max(0, box.left), top: Math.max(0, box.top), width: Math.min(window.innerWidth, box.right) - Math.max(0, box.left), height: Math.min(window.innerHeight, box.bottom) - Math.max(0, box.top) };
        if (rect.width <= 0 || rect.height <= 0) return this._send(false);
        const holes = sampleTouchHoles({ canvas, rect, elementFromPoint: (x, y) => document.elementFromPoint(x, y) });
        this._send(true, rect, holes);
        // 工具栏、状态栏挡住的边距：苹果地图标志与“法律信息”放在边距之内
        const insets = getMapSafeInsets(canvas);
        const key = `${Math.round(insets.top)}|${Math.round(insets.bottom)}`;
        if (key !== this.lastInsets) {
            this.lastInsets = key;
            this.view._call('setInsets', { top: insets.top, bottom: insets.bottom, left: 0, right: 0 });
        }
    }

    _send(active, rect = null, holes = []) {
        const payload = active ? { active: true, rect: encodeRect(rect), holes: sanitizeHoles(holes) } : { active: false, rect: null, holes: [] };
        const key = JSON.stringify(payload);
        if (key === this.lastSent) return;
        this.lastSent = key;
        this.view._call('setTouch', payload);
    }

    destroy() {
        this.active = false;
        window.clearTimeout(this.timer);
        window.clearInterval(this.interval);
        this.observer?.disconnect();
        this.stopOverlays();
        this.stopLifecycle();
        window.removeEventListener('resize', this.schedule);
        document.removeEventListener('transitionend', this.schedule, true);
        document.removeEventListener('animationend', this.schedule, true);
    }
}

// ---- 底图 ----

export class NativeMapView {
    /**
     * @param {HTMLElement} container  网页里的地图画布（iOS 上铺满屏幕，与原生底图同一坐标）
     * @param {{ center: [number, number], zoom: number, dark?: boolean, muted?: boolean, session?: NativeMapSession }} options
     * ready：握手结果；失败时调用方销毁本对象、回到高德网页地图。
     */
    constructor(container, { center, zoom, dark = false, muted = false, session = null }) {
        this.isNativeMap = true;
        this.container = container;
        this.handlers = new Map();
        this.overlays = new Set();
        this.overlaySyncScheduled = false;
        this.destroyed = false;
        this.attached = false;
        this.visible = true;
        this.appearance = { dark: !!dark, muted: !!muted };
        const [lng, lat] = readPoint(center) || [113.394405, 23.016485];
        this.camera = { lng, lat, zoom: this._clampZoom(zoom), width: 0, height: 0 };
        this.moveStartZoom = this.camera.zoom;
        this.session = session || new NativeMapSession({ onEvent: (name, data) => this._handleEvent(name, data) });
        if (session) session.onEvent = (name, data) => this._handleEvent(name, data);
        this.touch = null;
        this.ready = this._start();
    }

    async _start() {
        const [lng, lat] = toNative(this.camera.lng, this.camera.lat);
        const camera = await this.session.start({ lng, lat, zoom: this.camera.zoom, ...this.appearance });
        if (this.destroyed) throw new Error('destroyed');
        this.attached = true;
        if (camera) this._applyCamera(camera);
        // 页面底色去掉，原生底图从透明的 WebView 下面透出来（overlay.css）
        document.documentElement.setAttribute('data-native-map', '');
        this.touch = new NativeMapTouch(this);
        this.touch.setActive(this.visible);
        this._scheduleOverlaySync();
        this._emit('complete', {});
    }

    _call(method, args) {
        if (this.destroyed) return Promise.resolve(null);
        return this.ready.then(() => this.session.call(method, args)).catch(() => null);
    }

    // ---- 事件 ----

    on(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type).add(fn);
    }

    off(type, fn) {
        this.handlers.get(type)?.delete(fn);
    }

    _emit(type, event) {
        for (const fn of Array.from(this.handlers.get(type) || [])) {
            try { fn({ type, target: this, ...event }); } catch (e) { console.warn('地图事件处理失败', type, e); }
        }
    }

    _applyCamera(data) {
        const [lng, lat] = fromNative(Number(data.lng), Number(data.lat));
        if (Number.isFinite(lng) && Number.isFinite(lat)) { this.camera.lng = lng; this.camera.lat = lat; }
        if (Number.isFinite(Number(data.zoom))) this.camera.zoom = Number(data.zoom);
        if (Number(data.width) > 0) this.camera.width = Number(data.width);
        if (Number(data.height) > 0) this.camera.height = Number(data.height);
    }

    _handleEvent(name, data) {
        if (this.destroyed) return;
        if (name === 'camera') {
            this._applyCamera(data);
            if (data.phase === 'start') {
                this.moveStartZoom = this.camera.zoom;
                this._emit('movestart', {});
                if (data.gesture) this._emit('dragstart', {});
            } else if (data.phase === 'change') {
                this._emit('mapmove', {});
            } else if (data.phase === 'end') {
                this._emit('moveend', {});
                if (data.zoomChanged || Math.abs(this.camera.zoom - this.moveStartZoom) > 0.001) this._emit('zoomend', {});
            }
        } else if (name === 'tap') {
            const [lng, lat] = fromNative(Number(data.lng), Number(data.lat));
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            this._emit('click', { lnglat: lngLat(lng, lat) });
        } else if (name === 'markerTap' || name === 'clusterMembers') {
            this._emit(name, data);
        }
    }

    // ---- 相机（读） ----

    _clampZoom(zoom) {
        const value = Number(zoom);
        return Math.min(NATIVE_MAP_ZOOMS[1], Math.max(NATIVE_MAP_ZOOMS[0], Number.isFinite(value) ? value : 16));
    }

    _size() {
        const width = this.camera.width || this.container?.clientWidth || window.innerWidth;
        const height = this.camera.height || this.container?.clientHeight || window.innerHeight;
        return { width, height };
    }

    getCenter() {
        return lngLat(this.camera.lng, this.camera.lat);
    }

    getZoom() {
        return this.camera.zoom;
    }

    getZooms() {
        return NATIVE_MAP_ZOOMS.slice();
    }

    getSize() {
        const { width, height } = this._size();
        return { width, height, getWidth: () => width, getHeight: () => height };
    }

    getContainer() {
        return this.container;
    }

    /** 原生底图左上角（屏幕原点）到网页画布左上角的偏移 */
    _containerOffset() {
        const box = this.container?.getBoundingClientRect?.();
        return box ? { x: box.left, y: box.top } : { x: 0, y: 0 };
    }

    lngLatToContainer(value) {
        const point = readPoint(value);
        if (!point) return null;
        const { width, height } = this._size();
        const center = worldPixel(this.camera.lng, this.camera.lat, this.camera.zoom);
        const target = worldPixel(point[0], point[1], this.camera.zoom);
        const offset = this._containerOffset();
        const x = target.x - center.x + width / 2 - offset.x;
        const y = target.y - center.y + height / 2 - offset.y;
        return { x, y, getX: () => x, getY: () => y };
    }

    lnglatToContainer(value) {
        return this.lngLatToContainer(value);
    }

    containerToLngLat(pixel) {
        const px = Array.isArray(pixel) ? pixel[0] : (typeof pixel?.getX === 'function' ? pixel.getX() : pixel?.x);
        const py = Array.isArray(pixel) ? pixel[1] : (typeof pixel?.getY === 'function' ? pixel.getY() : pixel?.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        const { width, height } = this._size();
        const offset = this._containerOffset();
        const center = worldPixel(this.camera.lng, this.camera.lat, this.camera.zoom);
        const point = unprojectWorldPixel(center.x + px + offset.x - width / 2, center.y + py + offset.y - height / 2, this.camera.zoom);
        return lngLat(point.lng, point.lat);
    }

    getBounds() {
        const { width, height } = this._size();
        const center = worldPixel(this.camera.lng, this.camera.lat, this.camera.zoom);
        const sw = unprojectWorldPixel(center.x - width / 2, center.y + height / 2, this.camera.zoom);
        const ne = unprojectWorldPixel(center.x + width / 2, center.y - height / 2, this.camera.zoom);
        const southWest = lngLat(Math.max(-180, sw.lng), sw.lat);
        const northEast = lngLat(Math.min(180, ne.lng), ne.lat);
        return { southWest, northEast, getSouthWest: () => southWest, getNorthEast: () => northEast };
    }

    // ---- 相机（写）：先更新缓存（之后的读取立刻是目标值），再按顺序发给原生 ----

    _setCamera(lng, lat, zoom, animated) {
        this.camera.lng = lng;
        this.camera.lat = lat;
        this.camera.zoom = this._clampZoom(zoom);
        const [x, y] = toNative(lng, lat);
        this._call('setCamera', { lng: x, lat: y, zoom: this.camera.zoom, animated: !!animated });
    }

    setZoomAndCenter(zoom, center, immediately = false) {
        const point = readPoint(center);
        if (!point) return;
        this._setCamera(point[0], point[1], zoom, !immediately);
    }

    setCenter(center, immediately = false) {
        const point = readPoint(center);
        if (point) this._setCamera(point[0], point[1], this.camera.zoom, !immediately);
    }

    setZoom(zoom, immediately = false) {
        this._setCamera(this.camera.lng, this.camera.lat, zoom, !immediately);
    }

    panTo(center) {
        this.setCenter(center, false);
    }

    panBy(dx, dy) {
        const x = Number(dx) || 0, y = Number(dy) || 0;
        const center = worldPixel(this.camera.lng, this.camera.lat, this.camera.zoom);
        const next = unprojectWorldPixel(center.x - x, center.y - y, this.camera.zoom);
        this.camera.lng = next.lng;
        this.camera.lat = next.lat;
        this._call('panBy', { dx: x, dy: y, animated: true });
    }

    /** 高德 setBounds(bounds, immediately, avoid)：bounds 可以是 AMap.Bounds 或 { minLng, minLat, maxLng, maxLat } */
    setBounds(bounds, immediately = false, avoid = 0, maxZoom = NATIVE_MAP_ZOOMS[1]) {
        let box = null;
        if (bounds && typeof bounds.getSouthWest === 'function') {
            const sw = readPoint(bounds.getSouthWest()), ne = readPoint(bounds.getNorthEast());
            box = sw && ne ? boundsOf([sw, ne]) : null;
        } else if (bounds && Number.isFinite(Number(bounds.minLng))) {
            box = boundsOf([[Number(bounds.minLng), Number(bounds.minLat)], [Number(bounds.maxLng), Number(bounds.maxLat)]]);
        } else if (Array.isArray(bounds)) {
            box = boundsOf(bounds.map(readPoint));
        }
        if (!box) return;
        const padding = readPadding(avoid);
        this._fit(box, padding, maxZoom, !immediately);
    }

    /** 高德 setFitView(overlays, immediately, avoid, maxZoom)：overlays 为空时取地图上全部覆盖物 */
    setFitView(overlays, immediately = false, avoid = 0, maxZoom = NATIVE_MAP_ZOOMS[1]) {
        const list = Array.isArray(overlays) && overlays.length ? overlays : Array.from(this.overlays);
        const box = boundsOf(list.flatMap((overlay) => (typeof overlay?._points === 'function' ? overlay._points() : [])));
        if (!box) return;
        this._fit(box, readPadding(avoid), Number(maxZoom) || NATIVE_MAP_ZOOMS[1], !immediately);
    }

    _fit(box, padding, maxZoom, animated) {
        // 乐观更新：中心先取范围中心，原生回传的相机会覆盖它
        this.camera.lng = (box.minLng + box.maxLng) / 2;
        this.camera.lat = (box.minLat + box.maxLat) / 2;
        const [minLng, minLat] = toNative(box.minLng, box.minLat);
        const [maxLng, maxLat] = toNative(box.maxLng, box.maxLat);
        this._call('fitBounds', { minLng, minLat, maxLng, maxLat, ...padding, maxZoom: this._clampZoom(maxZoom), animated })
            .then((result) => { if (result?.camera) this._applyCamera(result.camera); });
    }

    // ---- 外观 ----

    /** 高德样式 → MapKit（nativeMapAppearance）。与高德相同，地图的深浅跟所选样式走，不跟界面 */
    setMapStyle(style) {
        const value = typeof style === 'string' ? style : style?.style;
        const pageDark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark';
        this.setAppearance(nativeMapAppearance(value, pageDark));
        return true;
    }

    setStyle(style) { return this.setMapStyle(style); }

    setOptions(options) {
        if (options && (options.mapStyle || options.style)) this.setMapStyle(options.mapStyle || options.style);
    }

    setAppearance({ dark, muted }) {
        const next = { dark: !!dark, muted: !!muted };
        if (next.dark === this.appearance.dark && next.muted === this.appearance.muted) return;
        this.appearance = next;
        this._call('setAppearance', next);
    }

    // ---- 覆盖物 ----

    add(items) {
        for (const overlay of Array.isArray(items) ? items : [items]) {
            if (!(overlay instanceof NativeOverlay) || overlay.map === this) continue;
            overlay.map?.remove(overlay);
            overlay.map = this;
            this.overlays.add(overlay);
        }
        this._scheduleOverlaySync();
    }

    remove(items) {
        for (const overlay of Array.isArray(items) ? items : [items]) {
            if (!(overlay instanceof NativeOverlay) || overlay.map !== this) continue;
            overlay.map = null;
            this.overlays.delete(overlay);
        }
        this._scheduleOverlaySync();
    }

    _scheduleOverlaySync() {
        if (this.overlaySyncScheduled || this.destroyed) return;
        this.overlaySyncScheduled = true;
        Promise.resolve().then(() => {
            this.overlaySyncScheduled = false;
            if (this.destroyed || !this.attached) return;
            const markers = [], lines = [];
            for (const overlay of this.overlays) {
                const encoded = overlay._toNative();
                if (!encoded) continue;
                (overlay instanceof NativePolylineOverlay ? lines : markers).push(encoded);
            }
            this._call('setOverlays', { markers, lines });
        });
    }

    // ---- 标记（NativeMarkerLayer 调用） ----

    setPlaces(entries, selectedId = null) {
        return this._call('setPlaces', { ...encodeNativePlaces(entries.map((entry) => {
            const [lng, lat] = toNative(entry.lng, entry.lat);
            return { ...entry, lng, lat };
        })), selected: selectedId || undefined });
    }

    setSelectedPlace(id) {
        return this._call('setSelected', { id: id || undefined });
    }

    setMarkerStyle(style) {
        return this._call('setStyle', { style });
    }

    // ---- 页面 ----

    /** 地图页被其他页面盖住时，触摸全部留给网页 */
    setVisible(visible) {
        this.visible = !!visible;
        this.touch?.setActive(this.visible);
    }

    // 高德地图的其余接口在原生里不需要
    resize() { this.touch?.schedule(); }
    addControl() { }
    removeControl() { }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.touch?.destroy();
        this.touch = null;
        this.handlers.clear();
        for (const overlay of this.overlays) overlay.map = null;
        this.overlays.clear();
        document.documentElement.removeAttribute('data-native-map');
        this.session.stop();
    }
}
