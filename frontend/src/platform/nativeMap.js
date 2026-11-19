// iOS 原生底图（MapKit）的网页端会话。协议见 ios/App/App/NativeMapPlugin.swift。
//
// 底图、标记、聚合点与名称都由原生画：拖动缩放时 MapKit 在同一帧里移动它们，网页不逐帧参与。
// 聚合仍由网页的聚合引擎计算：缩放结束、数据变化时下发一份节点快照与转场计划，原生按计划播放合并 / 拆分动画。
// 网页只在这些时候下发（相机、节点、样式、覆盖物、触摸区域），原生把相机变化与点按作为事件回传。
// 只在 iOS App 里、插件可用时启用；握手失败时 MapView 回到高德网页地图。
import { getPlatform, isPluginAvailable } from './env.js';
import { parseColorToRgb } from '../theme/theme.js';

export const NATIVE_MAP_PROTOCOL = 1;
export const NATIVE_MAP_EVENTS = Object.freeze(['camera', 'tap', 'markerTap', 'clusterTap']);
export const NATIVE_MAP_GLYPHS = Object.freeze(['place', 'avoid', 'unexplored', 'add']);
export const NATIVE_MAP_OVERLAY_KINDS = Object.freeze(['location', 'pin', 'badge']);
const PLUGIN_NAME = 'NativeMap';
const CALL_TIMEOUT_MS = 2500;
const NODE_LIMIT = 5000;
const KEY_LIMIT = 160;
const OVERLAY_LIMIT = 200;
const PATH_POINT_LIMIT = 20000;
const HOLE_LIMIT = 400;
const TEXT_LIMIT = 80;
const MAX_LAT = 85.05112878;

let pluginPromise = null;

function loadPlugin() {
    if (!pluginPromise) {
        // 插件代理对任意属性（包括 then）都返回方法，包一层普通对象再返回（见 nativeMapChrome.js）
        pluginPromise = import('@capacitor/core').then(({ registerPlugin }) => ({ plugin: registerPlugin(PLUGIN_NAME) }));
        pluginPromise.catch(() => { pluginPromise = null; });
    }
    return pluginPromise;
}

export function canUseNativeMap() {
    return getPlatform() === 'ios' && isPluginAvailable(PLUGIN_NAME);
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}

function randomId() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return `map-${crypto.randomUUID()}`;
    } catch (e) { /* ignore */ }
    return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ---- 清洗（与 Swift 的白名单、上限一致） ----

const finite = (value) => (typeof value === 'number' ? Number.isFinite(value) : false);

export function isNativeCoordinate(lng, lat) {
    return finite(lng) && finite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= MAX_LAT;
}

function text(value, limit = TEXT_LIMIT) {
    return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** CSS 颜色（#RGB、#RRGGBB、rgb()、rgba()）转为原生能读的 #RRGGBB / #RRGGBBAA；读不出时 undefined */
export function nativeColor(value) {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const rgb = parseColorToRgb(value);
    if (!rgb) return undefined;
    const hex = (part) => Math.round(part).toString(16).padStart(2, '0');
    let alpha = 1;
    const rgba = value.trim().toLowerCase().match(/^rgba\(([^)]+)\)$/);
    if (rgba) {
        const a = Number(rgba[1].split(',')[3]);
        if (Number.isFinite(a)) alpha = Math.min(1, Math.max(0, a));
    } else if (/^#[0-9a-f]{8}$/i.test(value.trim())) {
        alpha = parseInt(value.trim().slice(7, 9), 16) / 255;
    }
    return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}${alpha < 1 ? hex(alpha * 255) : ''}`;
}

/**
 * 一份节点快照按列编码（原生解析数组比解析对象数组快得多）。
 * @param {Array<{ id: string, cluster: boolean, lng: number, lat: number, count?: number, name?: string, glyph?: string }>} nodes
 */
export function encodeNativeNodes(nodes) {
    const ids = [], clusters = [], coords = [], counts = [], names = [], glyphs = [];
    const seen = new Set();
    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (ids.length >= NODE_LIMIT) break;
        const id = text(node?.id, KEY_LIMIT);
        if (!id || seen.has(id) || !isNativeCoordinate(node.lng, node.lat)) continue;
        seen.add(id);
        const cluster = node.cluster === true;
        ids.push(id);
        clusters.push(cluster);
        coords.push(node.lng, node.lat);
        counts.push(cluster ? Math.max(2, Math.round(Number(node.count) || 2)) : 1);
        names.push(cluster ? '' : text(node.name));
        glyphs.push(!cluster && NATIVE_MAP_GLYPHS.includes(node.glyph) ? node.glyph : 'place');
    }
    return { ids, clusters, coords, counts, names, glyphs };
}

/**
 * 转场计划（cluster/transitions.js 的 planTransition）编码成扁平数组：成对的 [新, 旧, …]。
 * 只保留两份快照里确实存在的 key（原生只认识它画过和这次要画的节点）。
 */
export function encodeNativePlan(plan, { nextKeys, prevKeys }) {
    const has = (set, key) => typeof key === 'string' && key.length > 0 && key.length <= KEY_LIMIT && set.has(key);
    const pairs = (map, left, right) => {
        const out = [];
        for (const [a, b] of map || []) if (has(left, a) && has(right, b)) out.push(a, b);
        return out;
    };
    const list = (values, set) => [...(values || [])].filter((key) => has(set, key));
    return {
        reuse: pairs(plan?.reuse, nextKeys, prevKeys),
        reanchor: list(plan?.reanchor, nextKeys).filter((key) => has(prevKeys, plan?.reuse?.get(key))),
        splitFrom: pairs(plan?.splitFrom, nextKeys, prevKeys),
        mergeInto: pairs(plan?.mergeInto, prevKeys, nextKeys),
        splitSources: list(plan?.splitSources, prevKeys),
        mergeTargets: list(plan?.mergeTargets, nextKeys)
    };
}

/** 校准搜索的参数清洗（与 Swift parseProbe 相同的上限） */
export function sanitizeProbes(probes) {
    const out = [];
    for (const probe of Array.isArray(probes) ? probes : []) {
        if (out.length >= 12) break;
        const id = text(probe?.id, 64);
        const names = (Array.isArray(probe?.names) ? probe.names : []).map((name) => text(name, 60)).filter(Boolean).slice(0, 4);
        if (!id || !names.length || !isNativeCoordinate(probe.lng, probe.lat)) continue;
        out.push({ id, names, lng: probe.lng, lat: probe.lat, radius: finite(probe.radius) ? Math.min(20000, Math.max(200, probe.radius)) : 3000 });
    }
    return out;
}

export function sanitizeOverlayMarker(marker) {
    if (!marker || typeof marker !== 'object') return null;
    const id = text(marker.id, 64);
    if (!id || !NATIVE_MAP_OVERLAY_KINDS.includes(marker.kind) || !isNativeCoordinate(marker.lng, marker.lat)) return null;
    const out = { id, kind: marker.kind, lng: marker.lng, lat: marker.lat };
    if (marker.text) out.text = text(String(marker.text), 4);
    for (const key of ['fill', 'textColor', 'border']) {
        const color = nativeColor(marker[key]);
        if (color) out[key] = color;
    }
    if (finite(marker.size)) out.size = Math.min(64, Math.max(12, marker.size));
    if (finite(marker.zIndex)) out.zIndex = Math.min(5000, Math.max(0, Math.round(marker.zIndex)));
    if (marker.label) out.label = text(String(marker.label));
    return out;
}

export function sanitizeOverlayLine(line) {
    if (!line || typeof line !== 'object') return null;
    const id = text(line.id, 64);
    if (!id || !Array.isArray(line.path)) return null;
    const coords = [];
    for (const point of line.path) {
        if (coords.length / 2 >= PATH_POINT_LIMIT) break;
        const lng = Array.isArray(point) ? point[0] : point?.lng;
        const lat = Array.isArray(point) ? point[1] : point?.lat;
        if (isNativeCoordinate(lng, lat)) coords.push(lng, lat);
    }
    if (coords.length < 4) return null;
    const color = nativeColor(line.color);
    return {
        id,
        coords,
        // 读不出颜色时不下发，原生用默认主色
        ...(color ? { color } : {}),
        width: finite(line.width) ? Math.min(20, Math.max(1, line.width)) : 5,
        opacity: finite(line.opacity) ? Math.min(1, Math.max(0.1, line.opacity)) : 1,
        dashed: !!line.dashed,
        zIndex: finite(line.zIndex) ? Math.min(5000, Math.max(0, Math.round(line.zIndex))) : 100
    };
}

/** 网页视口矩形 → [x, y, w, h]（取整到 0.5pt，空矩形丢弃） */
export function encodeRect(rect) {
    if (!rect) return null;
    const x = rect.left ?? rect.x, y = rect.top ?? rect.y, width = rect.width, height = rect.height;
    if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) return null;
    const round = (value) => Math.round(value * 2) / 2;
    return [round(x), round(y), round(width), round(height)];
}

export function sanitizeHoles(holes) {
    const out = [];
    for (const hole of Array.isArray(holes) ? holes : []) {
        if (out.length >= HOLE_LIMIT) break;
        const rect = Array.isArray(hole) ? encodeRect({ x: hole[0], y: hole[1], width: hole[2], height: hole[3] }) : encodeRect(hole);
        if (rect) out.push(rect);
    }
    return out;
}

// ---- 会话 ----

export class NativeMapSession {
    /**
     * @param {{ onEvent: (name: string, data: object) => void, plugin?: object }} options  plugin 仅供测试注入
     */
    constructor({ onEvent, plugin = null }) {
        this.onEvent = onEvent;
        this.injectedPlugin = plugin;
        this.plugin = null;
        this.sessionId = null;
        this.listeners = [];
        this.stopped = false;
        this.chain = Promise.resolve();
    }

    /** 握手并显示底图；失败时抛错（调用方回到高德网页地图）。返回原生的首个相机。 */
    async start({ lng, lat, zoom, dark = false, muted = false }) {
        const plugin = this.injectedPlugin || (await withTimeout(loadPlugin(), CALL_TIMEOUT_MS)).plugin;
        this.plugin = plugin;
        const caps = await withTimeout(plugin.capabilities(), CALL_TIMEOUT_MS);
        if (!caps || caps.protocolVersion !== NATIVE_MAP_PROTOCOL || caps.available === false) {
            throw new Error(`native map unavailable (protocol ${caps?.protocolVersion})`);
        }
        if (this.stopped) throw new Error('stopped');
        const sessionId = randomId();
        this.sessionId = sessionId;
        for (const name of NATIVE_MAP_EVENTS) {
            const handle = await plugin.addListener(name, (data) => {
                if (this.stopped || !data || data.sessionId !== this.sessionId) return;
                this.onEvent && this.onEvent(name, data);
            });
            this.listeners.push(handle);
        }
        const result = await withTimeout(plugin.attach({ sessionId, lng, lat, zoom, dark: !!dark, muted: !!muted }), CALL_TIMEOUT_MS);
        if (!result || !result.ready) throw new Error('attach');
        if (this.stopped) throw new Error('stopped');
        return result.camera || null;
    }

    /** 按发出顺序串行调用（相机与标记的先后不能乱）；会话结束后的调用直接丢弃 */
    call(method, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
        const run = async () => {
            if (this.stopped || !this.sessionId || !this.plugin) return null;
            return withTimeout(this.plugin[method]({ sessionId: this.sessionId, ...args }), timeoutMs);
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => null);
        return next;
    }

    async stop() {
        if (this.stopped) return;
        this.stopped = true;
        const sessionId = this.sessionId;
        const plugin = this.plugin;
        const listeners = this.listeners;
        this.listeners = [];
        await Promise.all(listeners.map((handle) => Promise.resolve(handle?.remove?.()).catch(() => null)));
        if (plugin && sessionId) {
            try { await withTimeout(plugin.dispose({ sessionId }), CALL_TIMEOUT_MS); } catch (e) { /* 原生在 WebView 重载时也会收起 */ }
        }
        this.sessionId = null;
    }
}
