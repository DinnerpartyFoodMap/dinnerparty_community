import { registerPlugin } from '@capacitor/core';
import { NATIVE_CHROME_PROTOCOL } from '../../src/platform/nativeMapChrome.js';

// The actual Capacitor session and React map run here; only the native boundary
// and map SDK are doubles. Swift rendering still needs an Xcode/device check.
if (new URLSearchParams(location.search).has('native')) {
    const listeners = {};
    const plugin = {
        state: {},
        async capabilities() { return { protocolVersion: NATIVE_CHROME_PROTOCOL, supportsGlass: true }; },
        async attach(args) { this.state = { ...args }; return { ready: true }; },
        async addListener(name, callback) { (listeners[name] ||= new Set()).add(callback); return { remove: () => listeners[name].delete(callback) }; },
        emit(name, data) { listeners[name]?.forEach(fn => fn({ sessionId: this.state.sessionId, ownerId: this.state.ownerId, ...data })); },
        async setState(state) {
            this.state = { ...this.state, ...state };
            setTimeout(() => this.emit('layout', { bottomOccupied: 90, occupiedRects: [], slots: [{ id: 'toolbar', x: 12, y: 754, width: 366, height: 76 }], showing: true }), 0);
            return { appliedRevision: state.revision };
        },
        async resume() { this.visible = true; return { visible: true }; },
        async suspend() { this.visible = false; return { hidden: true }; },
        async ackAction() { return {}; },
        async heartbeat() { return { alive: true }; },
        async dispose() { return { disposed: true }; },
        input(text) { this.emit('search', { type: 'input', text }); },
        submit(text) { this.emit('search', { type: 'submit', text }); },
        open() { this.emit('action', { actionId: 'search', eventId: 'open-search', revision: this.state.revision }); }
    };
    window.__native = plugin;
    registerPlugin('NativeMapChrome', { ios: () => plugin });
}

await import('./place-location-harness.jsx');
window.__sdkSearchCalls = 0;
window.AMap.PlaceSearch = class {
    searchNearBy(_q, _center, _radius, callback) { window.__sdkSearchCalls++; callback('complete', { info: 'OK', poiList: { pois: [] } }); }
    search(_q, callback) { window.__sdkSearchCalls++; callback('complete', { info: 'OK', poiList: { pois: [] } }); }
};
