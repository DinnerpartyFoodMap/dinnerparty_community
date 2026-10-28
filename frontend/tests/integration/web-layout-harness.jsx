import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapView from '../../src/map/MapView';
import AuthPanel from '../../src/app/components/AuthPanel';
import MapListMode from '../../src/map/MapListMode';
import TasteRadar from '../../src/profile/TasteRadar';
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
    setCenter(center) { this.center = center; this.emit('moveend'); }
    setZoom(zoom) { this.zoom = zoom; this.emit('zoomend'); }
    setZoomAndCenter(zoom, center) { this.zoom = zoom; this.setCenter(center); }
    setMapStyle() { queueMicrotask(() => this.emit('styleChanged')); }
    add(items) {
        for (const marker of [].concat(items)) {
            marker.map = this; this.markers.add(marker);
            const el = marker.options?.content;
            if (el instanceof HTMLElement) { Object.assign(el.style, { position: 'absolute', left: '50%', top: '55%' }); this.el.appendChild(el); }
        }
    }
    remove(items) { for (const marker of [].concat(items)) { marker.options?.content?.remove(); marker.map = null; this.markers.delete(marker); } }
    lngLatToContainer() { return { x: this.el.clientWidth / 2, y: this.el.clientHeight / 2 }; }
    panBy() {}
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
const mode = new URLSearchParams(location.search).get('mode');
createRoot(document.getElementById('root')).render(
    <MotionProvider><OverlayHost><TipsProvider><ConfirmProvider>
        {mode === 'list' ? <ListHarness /> : mode === 'radar' ? <RadarHarness /> : <MapHarness />}
    </ConfirmProvider></TipsProvider></OverlayHost></MotionProvider>
);
