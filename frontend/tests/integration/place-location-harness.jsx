import React from 'react';
import { createRoot } from 'react-dom/client';
import MapView from "../../src/map/MapView";
import { MotionProvider } from "../../src/motion/MotionProvider";
import { OverlayHost, useOverlayContentRef } from "../../src/components/overlay/OverlayHost";
import { ConfirmProvider } from "../../src/components/feedback/Confirm";
import TipsProvider from "../../src/components/feedback/Tips";

// Only the external map SDK is replaced; editing, overlays, marker rendering and API calls are real.
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
        window.__TEST_MAPS = [...(window.__TEST_MAPS || []), this];
        Object.assign(el.style, { background: '#e2eee5' });
    }
    on(event, fn) { (this.handlers[event] ||= new Set()).add(fn); }
    off(event, fn) { this.handlers[event]?.delete(fn); }
    emit(event, payload) { this.handlers[event]?.forEach(fn => fn(payload)); }
    getContainer() { return this.el; }
    getCenter() { return new LngLat(...this.center); }
    getZoom() { return this.zoom; }
    getZooms() { return [2, 20]; }
    getBounds() {
        const [lng, lat] = this.center;
        return { getSouthWest: () => new LngLat(lng - 0.03, lat - 0.03), getNorthEast: () => new LngLat(lng + 0.03, lat + 0.03) };
    }
    setCenter(center) { this.center = center; this.emit('moveend'); }
    setZoom(zoom) { this.zoom = zoom; this.emit('zoomend'); }
    setZoomAndCenter(zoom, center) { this.zoom = zoom; this.setCenter(center); }
    setMapStyle() { queueMicrotask(() => this.emit('styleChanged')); }
    add(items) {
        for (const marker of [].concat(items)) {
            marker.map = this;
            this.markers.add(marker);
            const el = marker.options?.content;
            if (el instanceof HTMLElement) {
                Object.assign(el.style, { position: 'absolute', left: '50%', top: '55%' });
                this.el.appendChild(el);
            }
        }
    }
    remove(items) { for (const marker of [].concat(items)) { marker.options?.content?.remove(); marker.map = null; this.markers.delete(marker); } }
    lngLatToContainer() { return { x: this.el.clientWidth / 2, y: this.el.clientHeight / 2 }; }
    panBy() {}
    resize() {}
    destroy() { this.destroyed = true; }
}
window.AMap = { Map: TestMap, Marker, LngLat, Pixel: class {}, plugin: (_name, callback) => callback() };

function Harness() {
    const contentRef = useOverlayContentRef();
    return <main ref={contentRef} style={{ position: 'fixed', inset: 0 }}>
        <MapView backendUrl={location.origin} token={window.__TEST_TOKEN} isAuthenticated mapPageActive
            initialCenter={{ lng: 120, lat: 30 }} onRequireAuth={() => { throw new Error('Unexpected auth request'); }}
            // Opt-in: a test that sets window.__TEST_FEEDBACK = [] records the feedback prefills instead of opening the form
            onOpenFeedback={window.__TEST_FEEDBACK ? (prefill) => window.__TEST_FEEDBACK.push(prefill) : undefined} />
    </main>;
}
createRoot(document.getElementById('root')).render(
    <MotionProvider><OverlayHost><TipsProvider><ConfirmProvider><Harness /></ConfirmProvider></TipsProvider></OverlayHost></MotionProvider>
);
