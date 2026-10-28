import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { registerOverlay } from '../../src/components/overlay/overlayStack.js';
import { setMotionPreferences } from '../../src/motion/policy.js';

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
    const frames = [];
    const transport = { async postMessage(message) {
        if (message.op === 'open') return { protocolVersion: 1, sessionId: 'browser-native', leaseMs: 800 };
        if (message.op === 'close') { nativeMarkers = []; return { closed: true }; }
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        frames.push(structuredClone(message));
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
    try {
        controller.update({ places });
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
        await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'page hidden');
        controller.setNativeGlassVisible(true);
        await until(() => nativeMarkers.length === 1, 'page restored');
        check(true, 'page visibility restores PNG before native reacquisition');

        // Pointer-transparent foreground glyphs and a notice away from the map center still cover glass.
        for (const className of ['fm-notice', 'fm-user-location', 'fm-search-results', 'fm-exhibition-stack', 'declared-map-controls']) {
            const bounds = nativeMarkers[0];
            const foreground = document.createElement('div'); foreground.className = className;
            if (className === 'declared-map-controls') foreground.setAttribute('data-native-cluster-occluder', '');
            foreground.style.cssText = `position:absolute;left:${bounds.x + 4}px;top:${bounds.y + 4}px;width:30px;height:8px;z-index:3000;pointer-events:none`;
            document.body.append(foreground);
            await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), `${className} overlap`);
            foreground.remove();
            await until(() => nativeMarkers.length === 1, `${className} removed`);
            check(true, `${className} preserves foreground stacking`);
        }

        const overlay = registerOverlay({ kind: 'cluster-test', onClose() {} });
        await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'web overlay fallback');
        overlay.unregister();
        await until(() => nativeMarkers.length === 1, 'overlay removed');
        check(true, 'web overlay fallback has no duplicate visual');

        const cover = document.createElement('div');
        cover.style.cssText = 'position:absolute;inset:0;background:white;z-index:1000';
        container.parentElement.style.position = 'relative'; container.parentElement.append(cover);
        await until(() => nativeMarkers.length === 0, 'list-like cover');
        cover.remove();
        await until(() => nativeMarkers.length === 1, 'list-like cover removed');
        check(true, 'non-overlay DOM cover suppresses native glass');

        setMotionPreferences({ nativeGlass: false });
        await until(() => nativeMarkers.length === 0 && !container.querySelector('[data-native-glass]'), 'glass preference off');
        setMotionPreferences({ nativeGlass: true });
        await until(() => nativeMarkers.length === 1, 'glass preference on');
        check(true, 'motion preference switches material safely');

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
