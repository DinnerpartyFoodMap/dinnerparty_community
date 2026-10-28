import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { registerOverlay } from '../../src/components/overlay/overlayStack.js';
import { getMotionPolicy, setMotionPreferences, reportSustainedJank } from '../../src/motion/policy.js';
import { NATIVE_CLUSTER_PROTOCOL } from '../../src/platform/nativeClusterMarkers.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapListMode from '../../src/map/MapListMode.jsx';

// Real controller, DOM, Supercluster and Web Animations; replace only AMap and the native WebKit boundary.
export async function runNativeClusterBrowserTests() {
    const checks = [];
    const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
    const until = async (predicate, label) => {
        const end = performance.now() + 6000;
        while (!predicate()) {
            if (performance.now() > end) {
                const current = window.__foodMapMarkers;
                throw new Error(`Timeout: ${label}: ${JSON.stringify({ entries: Array.from(current?.entries.values() || [], e => [e.node.kind, e.node.count]), transactions: current?.txns.size, native: nativeMarkers.length, frames: frames.length })}`);
            }
            await new Promise(resolve => setTimeout(resolve, 12));
        }
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false };
    let nativeMarkers = [], inFlight = 0, maxInFlight = 0, rejectNext = false;
    let gateNextFrame, gateFrameText;
    const frames = [];
    const transport = { async postMessage(message) {
        if (message.op === 'open') return { protocolVersion: NATIVE_CLUSTER_PROTOCOL, sessionId: 'browser-native', leaseMs: 800 };
        if (message.op === 'close') { nativeMarkers = []; return { closed: true }; }
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        frames.push(structuredClone(message));
        if (gateNextFrame && (!gateFrameText || message.markers.some(marker => marker.text === gateFrameText))) {
            const gate = gateNextFrame; gateNextFrame = null; gateFrameText = null; await gate;
        }
        await new Promise(resolve => setTimeout(resolve, 8));
        inFlight--;
        if (rejectNext) { rejectNext = false; return { appliedRevision: -1 }; }
        nativeMarkers = message.markers;
        return { appliedRevision: message.revision };
    } };
    window.webkit = { messageHandlers: { foodMapClusters: transport } };

    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:390px;height:600px;overflow:hidden;background:#dce4e8';
    document.body.append(container);
    const handlers = new Map(), attached = new Set();
    let zoom = 12;
    const scale = () => 256 * 2 ** zoom / 360;
    const project = point => ({ x: 195 + (point[0] - 120) * scale(), y: 300 - (point[1] - 30) * scale() });
    const map = {
        getContainer: () => container,
        getZoom: () => zoom,
        getZooms: () => [2, 20],
        getBounds: () => ({ getSouthWest: () => ({ lng: 120 - 195 / scale(), lat: 30 - 300 / scale() }), getNorthEast: () => ({ lng: 120 + 195 / scale(), lat: 30 + 300 / scale() }) }),
        lngLatToContainer: project,
        on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
        off: (name, fn) => handlers.get(name)?.delete(fn),
        add: markers => markers.forEach(marker => { attached.add(marker); container.append(marker.wrapper); marker.render(); }),
        remove: markers => markers.forEach(marker => { attached.delete(marker); marker.wrapper.remove(); })
    };
    const emit = name => { for (const fn of handlers.get(name) || []) fn(); };
    class Marker {
        constructor(options) {
            this.coordinate = options.position;
            this.wrapper = document.createElement('div');
            this.wrapper.style.position = 'absolute';
            this.wrapper.append(options.content);
            this.events = {};
        }
        on(name, fn) { this.events[name] = fn; }
        setzIndex(z) { this.wrapper.style.zIndex = z; }
        setPosition(point) { this.coordinate = point; this.render(); }
        setMap(value) { if (!value) this.wrapper.remove(); }
        render() { const point = project(this.coordinate); this.wrapper.style.left = `${point.x}px`; this.wrapper.style.top = `${point.y}px`; }
    }
    window.AMap = { Marker, Pixel: class { constructor(x, y) { this.x = x; this.y = y; } } };
    const places = [-1, 1].flatMap((side, group) => Array.from({ length: 6 }, (_, index) => ({
        id: group * 10 + index + 1, name: `Place ${group}-${index}`, longitude: 120 + side * 0.0003 + index * 0.0000005, latitude: 30 + index * 0.0000005
    })));
    const controller = new MarkerLayerController(map);
    const setZoom = value => {
        emit('zoomstart'); zoom = value; for (const marker of attached) marker.render(); emit('zoomchange'); emit('zoomend');
    };
    const area = marker => marker.visibleRects.reduce((sum, piece) => sum + piece.width * piece.height, 0);
    const avoids = (marker, cover) => marker.visibleRects.every(piece => {
        const left = marker.x + piece.x, top = marker.y + piece.y;
        return left >= cover.x + cover.width || left + piece.width <= cover.x || top >= cover.y + cover.height || top + piece.height <= cover.y;
    });
    try {
        controller.update({ places });
        await until(() => frames.length > 0, 'default material decision');
        check(!getMotionPolicy().clusterGlass && nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'cluster glass is off by default');
        let releaseInitial;
        gateNextFrame = new Promise(resolve => { releaseInitial = resolve; }); gateFrameText = '12';
        setMotionPreferences({ clusterGlass: true });
        await until(() => frames.some(message => message.markers.some(marker => marker.text === '12')), 'first native glass frame pending');
        check(!container.querySelector('[data-native-glass]'), 'first material acquisition keeps PNG visible until native acknowledgement');
        releaseInitial();
        await until(() => nativeMarkers.length === 1 && container.querySelector('[data-native-glass]'), 'initial native frame');
        check(nativeMarkers[0].text === '12', 'initial full cluster uses native ownership');
        const first = frames.length;
        setZoom(18);
        await until(() => controller.entries.size === 2 && controller.txns.size === 0 && nativeMarkers.length === 2, 'split settles');
        check(frames.slice(first).some(f => f.markers.some(m => m.zIndex === 100 && m.opacity < 1)), 'split source ghost and fading opacity mirrored');
        check(frames.slice(first).some(f => f.markers.filter(m => m.zIndex === 120).length === 2), 'both child clusters mirrored');
        check(nativeMarkers.every(m => m.text === '6'), 'split preserves member counts');
        const mergeStart = frames.length;
        setZoom(12);
        await until(() => controller.entries.size === 1 && controller.txns.size === 0 && nativeMarkers.length === 1, 'merge settles');
        check(frames.slice(mergeStart).some(f => f.markers.filter(m => m.zIndex === 100).length === 2), 'both merge travelers mirrored');
        setZoom(18);
        await until(() => controller.txns.size > 0, 'transition running');
        setZoom(12);
        await until(() => controller.entries.size === 1 && controller.txns.size === 0 && nativeMarkers.length === 1 && nativeMarkers[0].text === '12', 'interrupted transition settles');
        check(controller.entries.size === 1 && nativeMarkers[0].text === '12', 'gesture interruption clears ghosts');

        controller.setNativeGlassVisible(false);
        await until(() => nativeMarkers.length === 0, 'page hidden');
        check(!!container.querySelector('[data-native-glass]'), 'leaving a page retains committed material ownership');
        let releaseReturn;
        gateNextFrame = new Promise(resolve => { releaseReturn = resolve; });
        const returning = frames.length;
        controller.setNativeGlassVisible(true);
        await until(() => frames.length > returning, 'return frame pending');
        check(!!container.querySelector('[data-native-glass]'), 'a delayed return frame never reveals the PNG');
        releaseReturn();
        await until(() => nativeMarkers.length === 1, 'page restored');
        check(true, 'page return keeps the chosen material continuously');

        container.style.width = '200px';
        await until(() => nativeMarkers.length === 1 && nativeMarkers[0].visibleRects.some(piece => piece.x + piece.width < nativeMarkers[0].width), 'edge clipping');
        check(!!container.querySelector('[data-native-glass]') && area(nativeMarkers[0]) > 0, 'partially visible edge markers keep clipped glass');
        container.style.width = '390px';
        await until(() => area(nativeMarkers[0]) === nativeMarkers[0].width * nativeMarkers[0].height, 'edge restored');

        // Pointer-transparent foreground glyphs and a notice away from the map center still cover glass.
        for (const className of ['fm-notice', 'fm-user-location', 'fm-search-results', 'fm-exhibition-stack', 'declared-map-controls']) {
            const bounds = nativeMarkers[0];
            const foreground = document.createElement('div'); foreground.className = className;
            if (className === 'declared-map-controls') foreground.setAttribute('data-native-cluster-occluder', '');
            foreground.style.cssText = `position:absolute;left:${bounds.x + 4}px;top:${bounds.y + 4}px;width:30px;height:8px;z-index:3000;pointer-events:none`;
            document.body.append(foreground);
            const cover = { x: bounds.x + 4, y: bounds.y + 4, width: 30, height: 8 };
            await until(() => nativeMarkers.length === 1 && area(nativeMarkers[0]) < nativeMarkers[0].width * nativeMarkers[0].height, `${className} overlap`);
            check(!!container.querySelector('[data-native-glass]') && area(nativeMarkers[0]) > 0 && avoids(nativeMarkers[0], cover), `${className} clips only covered glass and keeps the PNG hidden`);
            foreground.remove();
            await until(() => nativeMarkers.length === 1 && area(nativeMarkers[0]) === nativeMarkers[0].width * nativeMarkers[0].height, `${className} removed`);
            check(true, `${className} preserves foreground stacking`);
        }

        const intersecting = [document.createElement('div'), document.createElement('div')];
        const covers = [{ x: nativeMarkers[0].x + 4, y: nativeMarkers[0].y + 4, width: 30, height: 8 }, { x: nativeMarkers[0].x + 10, y: nativeMarkers[0].y + 6, width: 15, height: 12 }];
        intersecting.forEach((el, index) => { const r = covers[index]; el.setAttribute('data-native-cluster-occluder', ''); el.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;pointer-events:none`; document.body.append(el); });
        await until(() => covers.every(cover => avoids(nativeMarkers[0], cover)), 'multiple intersecting occluders');
        check(!!container.querySelector('[data-native-glass]') && area(nativeMarkers[0]) > 0, 'intersecting foreground controls retain visible glass fragments');
        intersecting.forEach(el => el.remove());
        await until(() => area(nativeMarkers[0]) === nativeMarkers[0].width * nativeMarkers[0].height, 'multiple occluders removed');

        const oldGlyph = Array.from(controller.entries.values())[0].parts.glyph;
        const panelBounds = { x: nativeMarkers[0].x + 4, y: nativeMarkers[0].y + 4, width: 12, height: 24 };
        const panel = document.createElement('div');
        panel.setAttribute('data-native-cluster-occluder', '');
        panel.style.cssText = `position:absolute;left:${panelBounds.x}px;top:${panelBounds.y}px;width:${panelBounds.width}px;height:${panelBounds.height}px;background:white;z-index:3000`;
        document.body.append(panel);
        const panelFrame = frames.length;
        const nonModal = registerOverlay({ kind: 'filter-test', modal: false, onClose() {} });
        await until(() => frames.length > panelFrame && inFlight === 0, 'non-modal filter frame');
        check(nativeMarkers.length === 1 && area(nativeMarkers[0]) > 0 && avoids(nativeMarkers[0], panelBounds) && oldGlyph.hasAttribute('data-native-glass'), 'non-modal filters keep uncovered committed glass visible');
        let releaseFilter;
        gateNextFrame = new Promise(resolve => { releaseFilter = resolve; }); gateFrameText = '8';
        const filtering = frames.length;
        controller.update({ places: places.slice(0, 8).map(place => ({ ...place, id: place.id + 1000 })), queryMode: 'filter-test' });
        await until(() => frames.slice(filtering).some(message => message.markers.some(marker => marker.text === '8')), 'new filtered glyph frame pending');
        const filteredEntry = Array.from(controller.entries.values()).find(entry => entry.node.kind === 'cluster' && entry.node.count === 8);
        check(filteredEntry?.parts.glyph !== oldGlyph && filteredEntry?.parts.glyph.hasAttribute('data-native-glass'), 'new filtered glyphs join the committed glass mode before their delayed frame');
        check(nativeMarkers.some(marker => area(marker) > 0), 'existing native glass remains visible while a filtered frame is pending');
        releaseFilter();
        await until(() => controller.txns.size === 0 && nativeMarkers.length === 1 && nativeMarkers[0].text === '8', 'filtered glass settles');
        check(area(nativeMarkers[0]) > 0 && avoids(nativeMarkers[0], panelBounds), 'filtered results retain glass with the filter surface clipped');
        nonModal.unregister(); panel.remove();
        controller.update({ places });
        await until(() => controller.txns.size === 0 && nativeMarkers.length === 1 && nativeMarkers[0].text === '12', 'filter removed');

        const overlay = registerOverlay({ kind: 'cluster-test', modal: true, onClose() {} });
        await until(() => nativeMarkers.length === 0, 'web overlay hidden');
        check(!!container.querySelector('[data-native-glass]'), 'web overlays suspend glass without changing its material');
        overlay.unregister();
        await until(() => nativeMarkers.length === 1, 'overlay removed');
        check(true, 'web overlay return has no PNG or duplicate visual');

        // Mount the real list surface and exercise its open/close state while an old map frame is in flight.
        const mapBounds = container.getBoundingClientRect();
        const listHost = document.createElement('div');
        listHost.style.cssText = `position:absolute;left:${mapBounds.left}px;top:${mapBounds.top}px;width:${mapBounds.width}px;height:${mapBounds.height}px;pointer-events:none;--color-bg-base:white`;
        document.body.append(listHost);
        const listRoot = createRoot(listHost);
        function ListToggle() {
            const [open, setOpen] = useState(false);
            return React.createElement(React.Fragment, null,
                React.createElement('button', { 'data-test-list-toggle': '', onClick: () => setOpen(value => !value), style: { position: 'fixed', right: 0, bottom: 0, pointerEvents: 'auto' } }, 'List / map'),
                open && React.createElement(MapListMode, { backendUrl: '/__native-cluster-api', getMapCenter: () => null }));
        }
        try {
            listRoot.render(React.createElement(ListToggle));
            await until(() => listHost.querySelector('[data-test-list-toggle]'), 'list toggle mounted');
            let releaseBeforeList;
            gateNextFrame = new Promise(resolve => { releaseBeforeList = resolve; });
            const beforeList = frames.length;
            controller.nativeClusters.invalidate();
            await until(() => frames.length > beforeList, 'old map frame pending before list');
            listHost.querySelector('[data-test-list-toggle]').click();
            await until(() => listHost.querySelector('.fm-map-list'), 'actual list mounted');
            releaseBeforeList();
            await until(() => inFlight === 0 && frames.length > beforeList + 1, 'list frame applied after old map frame');
            check(nativeMarkers.length === 0, 'opening the real list removes all native glass instances after a pending map frame');
            check(!!container.querySelector('[data-native-glass]'), 'the real list retains PNG ownership while native glass is absent');

            let releaseListReturn;
            gateNextFrame = new Promise(resolve => { releaseListReturn = resolve; });
            const beforeReturn = frames.length;
            listHost.querySelector('[data-test-list-toggle]').click();
            await until(() => !listHost.querySelector('.fm-map-list') && frames.length > beforeReturn, 'list return frame pending');
            check(nativeMarkers.length === 0 && !!container.querySelector('[data-native-glass]'), 'a delayed list return keeps glass absent and never flashes the PNG');
            releaseListReturn();
            await until(() => nativeMarkers.length === 1 && inFlight === 0, 'list return glass restored');
            check(nativeMarkers[0].text === '12', 'closing the real list restores the existing cluster and count');

            listHost.querySelector('[data-test-list-toggle]').click();
            await until(() => !!listHost.querySelector('.fm-map-list') && nativeMarkers.length === 0, 'list reopened');
            check(!!container.querySelector('[data-native-glass]'), 'reopening the list leaves no native remnant and preserves material ownership');
        } finally { listRoot.unmount(); listHost.remove(); }
        await until(() => nativeMarkers.length === 1, 'list regression surface removed');

        setMotionPreferences({ nativeGlass: false });
        check(nativeMarkers.length === 1, 'cluster material is independent from the glass-button preference');
        setMotionPreferences({ clusterGlass: false });
        await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'glass preference off');
        setMotionPreferences({ clusterGlass: true });
        await until(() => nativeMarkers.length === 1, 'glass preference on');
        check(true, 'motion preference switches material safely');

        let releaseSwitch;
        gateNextFrame = new Promise(resolve => { releaseSwitch = resolve; });
        const switching = frames.length;
        let revertedDuringSwitch = false;
        const ownershipObserver = new MutationObserver(records => {
            if (getMotionPolicy().clusterGlass && records.some(record => record.oldValue !== null && !record.target.hasAttribute('data-native-glass'))) revertedDuringSwitch = true;
        });
        ownershipObserver.observe(container, { subtree: true, attributes: true, attributeFilter: ['data-native-glass'], attributeOldValue: true });
        setMotionPreferences({ clusterGlass: false });
        await until(() => frames.length > switching, 'off frame pending');
        setMotionPreferences({ clusterGlass: true });
        releaseSwitch();
        await until(() => nativeMarkers.length === 1 && inFlight === 0, 'rapid glass toggle settles');
        ownershipObserver.disconnect();
        check(!revertedDuringSwitch && !!container.querySelector('[data-native-glass]'), 'an old off reply cannot undo the current glass choice');
        reportSustainedJank();
        await until(() => inFlight === 0, 'performance policy frame');
        check(nativeMarkers.length === 1 && !!container.querySelector('[data-native-glass]'), 'temporary performance degradation keeps the chosen cluster material');

        document.documentElement.dataset.theme = 'dark';
        await until(() => nativeMarkers[0]?.color?.[0] === 1, 'dark count color');
        check(nativeMarkers[0].color[3] === 1, 'dark counts use opaque white');
        document.documentElement.dataset.theme = 'light';
        await until(() => nativeMarkers[0]?.color?.[0] === 0, 'light count color');
        check(nativeMarkers[0].color[3] === 1, 'light counts use opaque black');

        rejectNext = true; controller.nativeClusters.invalidate();
        await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'rejected frame fallback');
        check(true, 'native rejection clears glass before PNG fallback');
        check(maxInFlight === 1, 'bridge backpressure bounds every animation frame');
        controller.destroy();
        await until(() => nativeMarkers.length === 0, 'destroy native clear');
        check(attached.size === 0, 'map destruction removes all marker DOM');
        return { passed: true, checks, frames: frames.length, maxInFlight };
    } finally { controller.destroy(); container.remove(); }
}
