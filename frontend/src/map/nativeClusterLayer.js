// 原生只镜像当前动画图形；聚合父子关系、点击、读屏与手势继续由 MarkerLayerController 管理。
import { NativeClusterSession, NATIVE_CLUSTER_CHANNEL } from '../platform/nativeClusterMarkers.js';
import { getPlatform } from '../platform/env.js';
import { getMotionPolicy, subscribeMotionPolicy } from '../motion/policy.js';
import { getOverlayEntries, subscribeOverlays } from '../components/overlay/overlayStack.js';
import { isAppActive, onAppStateChange } from '../platform/lifecycle.js';
import { skinSlot } from '../skins/skinStore.js';

let visualSeq = 0;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
const rect = r => ({ x: r.left, y: r.top, width: r.width, height: r.height });

export function captureClusterFrame({ container, entries = [], ghosts = [], viewport, visible = true, getStyle = getComputedStyle, occluders = [], dark = false, countColor = false }) {
    const view = { width: viewport.width, height: viewport.height, offsetLeft: viewport.offsetLeft || 0, offsetTop: viewport.offsetTop || 0 };
    const frame = { viewport: view, clip: { x: 0, y: 0, width: 0, height: 0 }, markers: [], parts: [], dark };
    if (!visible || !container) return frame;
    const box = container.getBoundingClientRect();
    const left = Math.max(box.left, view.offsetLeft), top = Math.max(box.top, view.offsetTop);
    const right = Math.min(box.left + box.width, view.offsetLeft + view.width), bottom = Math.min(box.top + box.height, view.offsetTop + view.height);
    const clip = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    frame.clip = rect(clip);
    if (!clip.width || !clip.height) return frame;
    for (const entry of new Set([...entries, ...ghosts])) {
        const { glyph, travel, count } = entry.parts;
        if (!entry.attached || entry.node.kind !== 'cluster' || !count || !glyph.hasAttribute('data-default-cluster')) continue;
        const bounds = glyph.getBoundingClientRect();
        if (!(bounds.width > 0 && bounds.height > 0) || !overlaps(bounds, clip) || occluders.some(r => overlaps(bounds, r))) continue;
        const glyphStyle = getStyle(glyph), travelStyle = getStyle(travel), countStyle = getStyle(count);
        const opacity = clamp(Number(glyphStyle.opacity) * Number(travelStyle.opacity), 0, 1);
        if (!(opacity > 0.001)) continue;
        const width = parseFloat(glyph.style.width), height = parseFloat(glyph.style.height);
        if (!(width > 0 && height > 0)) continue;
        const fontSize = parseFloat(countStyle.fontSize) * bounds.width / width;
        if (!Number.isFinite(fontSize)) continue;
        entry.nativeGlassId ||= `cluster-visual-${++visualSeq}`;
        const marker = {
            id: entry.nativeGlassId, ...rect(bounds), opacity,
            text: count.textContent, fontSize,
            countX: clamp(parseFloat(countStyle.left) / width, 0, 1),
            countY: clamp(parseFloat(countStyle.top) / height, 0, 1),
            zIndex: entry.ghost ? 100 : (entry.parts.root?.hasAttribute('data-selected') ? 400 : 120)
        };
        if (countColor) {
            const rgba = countStyle.color?.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
            if (rgba) marker.color = [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255, rgba[4] === undefined ? 1 : Number(rgba[4])];
        }
        frame.markers.push(marker);
        frame.parts.push({ id: entry.nativeGlassId, glyph });
    }
    return frame;
}

export class NativeClusterLayer {
    constructor(controller) {
        this.controller = controller;
        this.visible = controller.options.nativeGlassVisible !== false;
        this.hidden = new Set();
        this.dirty = true;
        this.raf = 0;
        this.timer = 0;
        this.destroyed = false;
        this.session = null;
        const handler = typeof window !== 'undefined' && getPlatform() === 'ios' ? window.webkit?.messageHandlers?.[NATIVE_CLUSTER_CHANNEL] : null;
        if (!handler?.postMessage) return;
        this.session = new NativeClusterSession({ transport: handler, onFrame: frame => this._own(frame) });
        this.unsubscribers = [subscribeMotionPolicy(() => {
            if (!getMotionPolicy().clusterMotion) controller._finishAll();
            this.invalidate();
        }), subscribeOverlays(() => this.invalidate()), onAppStateChange(() => this.invalidate())];
        this.onGeometry = () => this.invalidate();
        for (const name of ['mapmove', 'zoomchange', 'dragging', 'rotatechange']) controller.map.on(name, this.onGeometry);
        window.addEventListener('resize', this.onGeometry);
        window.addEventListener('scroll', this.onGeometry, true);
        window.visualViewport?.addEventListener('resize', this.onGeometry);
        window.visualViewport?.addEventListener('scroll', this.onGeometry);
        // 列表模式、页面显示/隐藏和非模态面板也会遮住地图；它们不一定触发地图事件。
        this.observer = new MutationObserver(() => this.invalidate());
        this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-theme'] });
        this.invalidate();
    }

    setVisible(visible) {
        if (this.visible === !!visible) return;
        this.visible = !!visible;
        this.invalidate();
    }

    invalidate() {
        if (this.destroyed || !this.session) return;
        this.dirty = true;
        clearTimeout(this.timer);
        if (!this.raf) this.raf = requestAnimationFrame(() => this._tick());
    }

    _own(frame) {
        const next = new Set((frame?.parts || []).map(part => part.glyph));
        for (const glyph of this.hidden) if (!next.has(glyph)) glyph.removeAttribute('data-native-glass');
        for (const glyph of next) glyph.setAttribute('data-native-glass', '');
        this.hidden = next;
    }

    _tick() {
        this.raf = 0;
        if (this.destroyed) return;
        const controller = this.controller;
        const policy = getMotionPolicy();
        let visible = this.visible && isAppActive() && policy.pageVisible && policy.nativeGlass
            && !policy.reducedTransparency && !policy.degradeLevel && getOverlayEntries().length === 0;
        const moving = controller.cameraMoving || controller.txns.size > 0;
        if (this.dirty || moving || !this.frame) {
            this.dirty = false;
            const viewport = window.visualViewport || { width: window.innerWidth, height: window.innerHeight };
            if (visible && controller.touchTarget) {
                const box = controller.touchTarget.getBoundingClientRect();
                const x = clamp(box.left + box.width / 2, 0, window.innerWidth - 1);
                const y = clamp(box.top + box.height / 2, 0, window.innerHeight - 1);
                const top = document.elementFromPoint(x, y);
                if (top && !controller.touchTarget.contains(top)) visible = false;
            }
            const ghosts = Array.from(controller.txns).flatMap(txn => txn.done ? [] : txn.ghosts);
            // 原生宿主在整个 WebView 上方，需让原有高层级的公告、定位点、选中点与新增点保留遮挡优先级。
            const occluders = Array.from(document.querySelectorAll('[data-map-occluder], [data-native-cluster-occluder], .fm-notice, .fm-search-results, .fm-exhibition-stack, .fm-user-location, .fm-adding-pin, .fm-marker[data-selected] .fm-marker__glyph, .fm-marker[data-selected] .fm-marker__label'), el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
            this.frame = captureClusterFrame({ container: controller.touchTarget, entries: controller.entries.values(), ghosts, viewport, visible, occluders, dark: document.documentElement.dataset.theme === 'dark', countColor: !!skinSlot('markers.clusterCountColor') });
        }
        this.session.submit(this.frame);
        if (visible && moving) this.raf = requestAnimationFrame(() => this._tick());
        else if (visible) this.timer = setTimeout(() => {
            // 静止时复用几何，只为原生显示租期保活。
            this.raf = requestAnimationFrame(() => this._tick());
        }, 200);
    }

    destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.raf);
        clearTimeout(this.timer);
        this.observer?.disconnect();
        for (const unsubscribe of this.unsubscribers || []) unsubscribe();
        if (this.onGeometry) {
            for (const name of ['mapmove', 'zoomchange', 'dragging', 'rotatechange']) this.controller.map.off(name, this.onGeometry);
            window.removeEventListener('resize', this.onGeometry);
            window.removeEventListener('scroll', this.onGeometry, true);
            window.visualViewport?.removeEventListener('resize', this.onGeometry);
            window.visualViewport?.removeEventListener('scroll', this.onGeometry);
        }
        return this.session?.stop();
    }
}
