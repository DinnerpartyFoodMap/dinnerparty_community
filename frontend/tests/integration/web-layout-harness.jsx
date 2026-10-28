import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapView from '../../src/map/MapView';
import AuthPanel from '../../src/app/components/AuthPanel';
import MapListMode from '../../src/map/MapListMode';
import TasteRadar from '../../src/profile/TasteRadar';
import AuthPage from '../../src/auth/AuthPage';
import AddForm from '../../src/places/components/AddPlaceForm';
import { worldPixel, unprojectWorldPixel } from '../../src/map/viewport';
import { MotionProvider } from '../../src/motion/MotionProvider';
import { OverlayHost, useOverlayContentRef } from '../../src/components/overlay/OverlayHost';
import { ConfirmProvider } from '../../src/components/feedback/Confirm';
import TipsProvider from '../../src/components/feedback/Tips';
import '../../src/styles/tokens.css';

// Match the existing location harness's AMap boundary; all inspected components are real.
class LngLat {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
}
class Marker {
    constructor(options) { this.options = options; this.position = options.position; }
    on(event, handler) { this.options.content?.addEventListener(event, handler); }
    setPosition(position) { this.position = position; }
    setzIndex() {}
    setMap(map) { this.map?.remove(this); if (map) map.add(this); }
    getMap() { return this.map; }
}
class TestMap {
    constructor(el, options) {
        this.el = el; this.center = options.center; this.zoom = options.zoom; this.handlers = {}; this.markers = new Set();
        this.deferredCamera = new URLSearchParams(location.search).has('deferredCamera');
        this.cameraMoves = []; this.autoPans = [];
        window.__WEB_LAYOUT_MAP = this;
        Object.assign(el.style, { background: '#e2eee5' });
    }
    on(event, fn) { (this.handlers[event] ||= new Set()).add(fn); }
    off(event, fn) { this.handlers[event]?.delete(fn); }
    emit(event, payload) { this.handlers[event]?.forEach(fn => fn(payload)); }
    getContainer() { return this.el; }
    getCenter() { return new LngLat(...this.center); }
    getZoom() { return this.zoom; }
    getZooms() { return [2, 20]; }
    getBounds() { const [lng, lat] = this.center; return { getSouthWest: () => new LngLat(lng - 0.03, lat - 0.03), getNorthEast: () => new LngLat(lng + 0.03, lat + 0.03) }; }
    setCenter(center) { this.center = center; this.positionMarkers(); this.emit('moveend'); }
    setZoom(zoom) { this.zoom = zoom; this.positionMarkers(); this.emit('zoomend'); }
    setZoomAndCenter(zoom, center, immediately = false) {
        this.cameraMoves.push({ zoom, center });
        const apply = () => { this.zoom = zoom; this.setCenter(center); this.emit('zoomend'); };
        if (!this.deferredCamera || immediately) { this.pendingCamera = null; apply(); return; }
        // AMap moves asynchronously by default. Keep the old projection until that move completes.
        const pending = {};
        this.pendingCamera = pending;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.pendingCamera !== pending) return;
            this.pendingCamera = null;
            apply();
        }));
    }
    setMapStyle() { queueMicrotask(() => this.emit('styleChanged')); }
    add(items) {
        for (const marker of [].concat(items)) {
            marker.map = this; this.markers.add(marker);
            const el = marker.options?.content;
            if (el instanceof HTMLElement) { Object.assign(el.style, { position: 'absolute', left: '50%', top: '55%' }); this.el.appendChild(el); }
        }
        this.positionMarkers();
    }
    remove(items) { for (const marker of [].concat(items)) { marker.options?.content?.remove(); marker.map = null; this.markers.delete(marker); } }
    lngLatToContainer(coordinate) {
        if (!this.deferredCamera) return { x: this.el.clientWidth / 2, y: this.el.clientHeight / 2 };
        const point = Array.isArray(coordinate) ? coordinate : [coordinate.lng, coordinate.lat];
        const p = worldPixel(...point, this.zoom), c = worldPixel(...this.center, this.zoom);
        return { x: this.el.clientWidth / 2 + p.x - c.x, y: this.el.clientHeight / 2 + p.y - c.y };
    }
    positionMarkers() {
        if (!this.deferredCamera) return;
        for (const marker of this.markers) {
            const el = marker.options?.content;
            if (!(el instanceof HTMLElement)) continue;
            const p = this.lngLatToContainer(marker.position);
            Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px` });
        }
    }
    panBy(dx, dy) {
        if (!this.deferredCamera) return;
        this.autoPans.push({ dx, dy, duringCameraMove: !!this.pendingCamera });
        const c = worldPixel(...this.center, this.zoom);
        const next = unprojectWorldPixel(c.x - dx, c.y - dy, this.zoom);
        this.setCenter([next.lng, next.lat]);
    }
    resize() {}
    destroy() {}
}
window.AMap = { Map: TestMap, Marker, LngLat, Pixel: class {}, plugin: (_name, callback) => callback() };

const user = { id: 'web-layout-user', username: '布局测试住民', is_banned: false };
function MapHarness() {
    const contentRef = useOverlayContentRef();
    const [alongRouteRequestId, setAlongRouteRequestId] = useState(0);
    const [desktopHeaderMenu, setDesktopHeaderMenu] = useState(null);
    return <main ref={contentRef} style={{ position: 'fixed', inset: 0 }}>
        <MapView backendUrl={location.origin} token="synthetic-web-layout" isAuthenticated mapPageActive
            initialCenter={{ lng: 120, lat: 30 }} alongRouteRequestId={alongRouteRequestId} desktopHeaderMenu={desktopHeaderMenu}
            onRequireAuth={() => { throw new Error('Unexpected auth request'); }} />
        <AuthPanel user={user} isAuth pathname="/" backendUrl={location.origin}
            onMenuOpenChange={setDesktopHeaderMenu}
            onOpenAlongRoute={() => setAlongRouteRequestId(id => id + 1)} />
        <output id="route-request-id" style={{ position: 'fixed', left: -10000 }}>{alongRouteRequestId}</output>
    </main>;
}
function ListHarness() {
    window.__WEB_LAYOUT_PICK_CENTERS ||= [];
    return <MapListMode backendUrl={location.origin} token="synthetic-web-layout"
        getMapCenter={() => ({ lng: 120, lat: 30 })}
        onPickCenter={(center, resolve) => { window.__WEB_LAYOUT_PICK_CENTERS.push(center); resolve({ lng: 121.5, lat: 31.5 }); }} />;
}
function RadarHarness() {
    return <main style={{ padding: 32, width: 360, background: 'var(--color-bg-surface)' }}><TasteRadar axes={[
        { key: 'homestyle', value: 1, basis: 'evidence' },
        { key: 'noodles', value: 0.75, basis: 'embedding' },
        { key: 'hotpotBbq', value: null, basis: null },
        { key: 'dessert', value: 0.5, basis: 'self' },
        { key: 'drinks', value: 0.25, basis: 'evidence' },
        { key: 'foreign', value: 0.9, basis: 'evidence' }
    ]} /></main>;
}
// 登录页的输入框（边框、聚焦与错误状态）与网页添加地点表单（评价必选），不经过地图
function AuthHarness() {
    return <main style={{ width: 390, background: 'var(--color-bg-surface)' }}><AuthPage backendUrl={location.origin} onClose={() => {}} /></main>;
}
function AddFormHarness() {
    window.__WEB_LAYOUT_SUBMITS ||= [];
    return <main style={{ width: 390, padding: 16, boxSizing: 'border-box', background: 'var(--color-bg-surface)' }}>
        <AddForm backendUrl={location.origin} token="synthetic-web-layout" userId="web-layout-user" defaultPos={[120, 30]} defaultName="测试面馆"
            onCancel={() => {}} onSubmit={(payload) => window.__WEB_LAYOUT_SUBMITS.push(payload)} />
    </main>;
}
const mode = new URLSearchParams(location.search).get('mode');
const HARNESS = { list: ListHarness, radar: RadarHarness, auth: AuthHarness, add: AddFormHarness };
const Harness = HARNESS[mode] || MapHarness;
createRoot(document.getElementById('root')).render(
    <MotionProvider><OverlayHost><TipsProvider><ConfirmProvider>
        <Harness />
    </ConfirmProvider></TipsProvider></OverlayHost></MotionProvider>
);
