// Native boundary substitutes exercise the real transport and DOM sampler, not SwiftUI rendering.
import assert from 'node:assert/strict';
import { NativeClusterSession, NATIVE_CLUSTER_PROTOCOL } from '../../../src/platform/nativeClusterMarkers.js';
import { captureClusterFrame, NativeClusterLayer } from '../../../src/map/nativeClusterLayer.js';
import { getMotionPolicy, setMotionPreferences } from '../../../src/motion/policy.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const frame = value => ({ viewport: { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 }, clip: { x: 0, y: 0, width: 390, height: 844 }, markers: [{ id: String(value) }], parts: [] });
function boundary(overrides = {}) {
    const calls = [];
    return { calls, async postMessage(message) {
        calls.push(message);
        if (overrides[message.op]) return overrides[message.op](message);
        if (message.op === 'open') return { protocolVersion: NATIVE_CLUSTER_PROTOCOL, sessionId: 'native-session', leaseMs: 10 };
        if (message.op === 'frame') return { appliedRevision: message.revision };
        return { closed: true };
    } };
}

// An unbounded bridge queue would replay obsolete camera positions after the gesture stops.
{
    const gate = deferred(); const seen = [];
    const transport = boundary({ frame: m => m.revision === 1 ? gate.promise : { appliedRevision: m.revision } });
    const session = new NativeClusterSession({ transport, onFrame: f => seen.push(f?.markers[0]?.id), timeoutMs: 100 });
    const drain = session.submit(frame(1)); await tick();
    session.submit(frame(2)); session.submit(frame(3));
    assert.equal(transport.calls.filter(m => m.op === 'frame').length, 1);
    gate.resolve({ appliedRevision: 1 }); await drain;
    assert.deepEqual(transport.calls.filter(m => m.op === 'frame').map(m => m.markers[0].id), ['1', '3']);
    assert.deepEqual(seen, ['1', '3']);
    assert.equal('parts' in transport.calls.find(m => m.op === 'frame'), false, 'DOM references never cross WebKit');
    await session.stop();
}

// A reply arriving after unmount must not take ownership of the PNG again.
{
    const gate = deferred(); const seen = [];
    const transport = boundary({ frame: () => gate.promise });
    const session = new NativeClusterSession({ transport, onFrame: f => seen.push(f), timeoutMs: 100 });
    const drain = session.submit(frame(1)); await tick(); await session.stop();
    gate.resolve({ appliedRevision: 1 }); await drain;
    assert.ok(seen.every(f => f === null));
    assert.equal(transport.calls.filter(m => m.op === 'close').length, 1);
}

// A delayed open is closed even when the map is destroyed during its handshake.
{
    const gate = deferred(); const transport = boundary({ open: () => gate.promise });
    const session = new NativeClusterSession({ transport, timeoutMs: 100 });
    const drain = session.submit(frame(1)); await session.stop();
    gate.resolve({ protocolVersion: NATIVE_CLUSTER_PROTOCOL, sessionId: 'late-session', leaseMs: 10 }); await drain;
    assert.equal(transport.calls.some(m => m.op === 'frame'), false);
    assert.equal(transport.calls.find(m => m.op === 'close')?.sessionId, 'late-session');
}

// An old shell must leave PNGs visible and must not repeatedly handshake every frame.
// A timed-out open still owns cleanup of a later native allocation.
{
    const gate = deferred(); const transport = boundary({ open: () => gate.promise });
    const session = new NativeClusterSession({ transport, timeoutMs: 5 });
    await session.submit(frame(1));
    gate.resolve({ protocolVersion: NATIVE_CLUSTER_PROTOCOL, sessionId: 'timed-out-session', leaseMs: 10 });
    await tick();
    assert.equal(transport.calls.find(m => m.op === 'close')?.sessionId, 'timed-out-session');
    await session.stop();
}

// An old shell must leave PNGs visible and must not repeatedly handshake every frame.
for (const version of [0, 1]) {
    const transport = boundary({ open: () => ({ protocolVersion: version, supportsGlass: false }) }); const seen = [];
    const session = new NativeClusterSession({ transport, onFrame: f => seen.push(f) });
    await session.submit(frame(1)); await session.submit(frame(2));
    assert.equal(transport.calls.length, 1); assert.equal(seen.some(Boolean), false);
    await session.stop();
}

// A rejected native frame must clear native rendering before the web visual returns.
{
    const order = []; const transport = boundary({ frame: () => ({ appliedRevision: -1 }), close: () => { order.push('native-hidden'); return { closed: true }; } });
    const session = new NativeClusterSession({ transport, onFrame: f => { if (!f) order.push('png-visible'); } });
    await session.submit(frame(1));
    assert.deepEqual(order, ['native-hidden', 'png-visible']); await session.stop();
}

// A brief main-thread delay inside the native lease is not a material failure.
{
    const seen = [];
    const transport = boundary({
        open: () => ({ protocolVersion: NATIVE_CLUSTER_PROTOCOL, sessionId: 'busy-session', leaseMs: 800 }),
        frame: async message => { await new Promise(resolve => setTimeout(resolve, 400)); return { appliedRevision: message.revision }; }
    });
    const session = new NativeClusterSession({ transport, onFrame: value => seen.push(value) });
    await session.submit(frame('busy'));
    assert.equal(seen[0]?.markers[0].id, 'busy', 'a valid reply inside the lease keeps glass ownership');
    assert.equal(transport.calls.some(message => message.op === 'close'), false, 'brief native work does not force PNG fallback');
    await session.stop();
}

// If close also fails, wait for the advertised native display lease before restoring PNGs.
{
    const transport = boundary({ frame: () => new Promise(() => {}), close: () => new Promise(() => {}) });
    let restoredAt = 0; const started = Date.now();
    const session = new NativeClusterSession({ transport, timeoutMs: 5, onFrame: f => { if (!f) restoredAt = Date.now(); } });
    await session.submit(frame(1)); assert.ok(restoredAt - started >= 20);
    await session.stop();
}

// Hand-derived animation sample: 1.25x scaling, two nested alpha layers, plus an exiting ghost.
{
    const makeEntry = (left, ghost = false) => {
        const glyph = { style: { width: '36px', height: '52px' }, hasAttribute: name => name === 'data-default-cluster', getBoundingClientRect: () => ({ left, top: 30, width: 45, height: 65 }) };
        const count = { textContent: '12' };
        return { node: { kind: 'cluster' }, attached: true, ghost, parts: { glyph, count, travel: {} } };
    };
    const a = makeEntry(20), ghost = makeEntry(100, true), outside = makeEntry(500);
    const getStyle = el => el === a.parts.count || el === ghost.parts.count || el === outside.parts.count
        ? { fontSize: '20px', left: '18px', top: '18.2px' }
        : { opacity: el === a.parts.travel ? '0.8' : '0.5' };
    const sample = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) }, entries: [a, outside], ghosts: [ghost], viewport: { width: 390, height: 844 }, getStyle });
    assert.equal(sample.markers.length, 2);
    assert.deepEqual(sample.markers[0], { id: a.nativeGlassId, x: 20, y: 30, width: 45, height: 65, opacity: 0.4, text: '12', fontSize: 25, countX: 0.5, countY: 0.35, zIndex: 120, color: [0, 0, 0, 1], visibleRects: [{ x: 0, y: 0, width: 45, height: 65 }] });
    assert.equal(sample.markers[1].opacity, 0.25);
    assert.equal(sample.markers[1].zIndex, 100, 'exit ghosts stay behind live clusters');
    assert.notEqual(sample.markers[0].id, sample.markers[1].id);
    const repeated = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) }, entries: [a], viewport: { width: 390, height: 844 }, getStyle });
    assert.equal(repeated.markers[0].id, a.nativeGlassId);
    const blocked = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) }, entries: [a], viewport: { width: 390, height: 844 }, getStyle, occluders: [{ left: 30, top: 50, width: 100, height: 100 }] });
    assert.equal(blocked.markers.length, 1, 'a partially covered marker keeps its glass material');
    assert.deepEqual(blocked.markers[0].visibleRects, [{ x: 0, y: 0, width: 45, height: 20 }, { x: 0, y: 20, width: 10, height: 45 }], 'only the unobscured glass fragments are shown');
    assert.equal(blocked.parts[0].glyph, a.parts.glyph, 'the covered PNG stays hidden');
    const edge = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 30, top: 40, width: 390, height: 844 }) }, entries: [a], viewport: { width: 390, height: 844 }, getStyle, dark: true });
    assert.deepEqual(edge.markers[0].visibleRects, [{ x: 10, y: 10, width: 35, height: 55 }], 'map edges clip the full glass without changing its shape or count anchor');
    assert.deepEqual(edge.markers[0].color, [1, 1, 1, 1], 'dark map counts have an explicit opaque foreground');
    const multi = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) }, entries: [a], viewport: { width: 390, height: 844 }, getStyle, occluders: [{ left: 20, top: 30, width: 20, height: 65 }, { left: 30, top: 50, width: 35, height: 25 }] });
    assert.deepEqual(multi.markers[0].visibleRects, [{ x: 20, y: 0, width: 25, height: 20 }, { x: 20, y: 45, width: 25, height: 20 }], 'overlapping occluders subtract their union without filling gaps back in');
    const covered = captureClusterFrame({ container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) }, entries: [a], viewport: { width: 390, height: 844 }, getStyle, occluders: [{ left: 0, top: 0, width: 390, height: 844 }] });
    assert.deepEqual(covered.markers, [], 'a fully covered marker is removed from the native glass render tree');
    assert.equal(covered.parts.length, 1, 'a fully covered marker does not reveal a PNG underneath');
    const hidden = captureClusterFrame({ visible: false, entries: [a], viewport: { width: 390, height: 844 }, getStyle });
    assert.equal(hidden.markers.length, 0);
}

// A temporarily hidden map keeps ownership until the returning native frame is ready.
{
    const attributes = new Set();
    const glyph = { setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name) };
    const layer = { hidden: new Set() };
    NativeClusterLayer.prototype._own.call(layer, { parts: [{ glyph }] });
    NativeClusterLayer.prototype._own.call(layer, { parts: [], retainOwnership: true });
    assert.ok(attributes.has('data-native-glass'), 'leaving the page does not reintroduce the PNG');
    NativeClusterLayer.prototype._own.call(layer, { parts: [], retainOwnership: true });
    assert.ok(attributes.has('data-native-glass'), 'an empty transient geometry frame cannot revert the committed material');
    NativeClusterLayer.prototype._own.call(layer, { parts: [{ glyph }] });
    assert.ok(attributes.has('data-native-glass'), 'returning keeps glass ownership continuously');
    glyph.isConnected = false;
    NativeClusterLayer.prototype._own.call(layer, { parts: [], retainOwnership: true });
    assert.equal(layer.hidden.size, 0, 'detached glyphs do not stay in committed ownership');
    glyph.isConnected = true;
    NativeClusterLayer.prototype._own.call(layer, { parts: [{ glyph }] });
    NativeClusterLayer.prototype._own.call(layer, null);
    assert.equal(attributes.has('data-native-glass'), false, 'bridge failure still restores the fallback');
}

// The separate cluster material opt-in is off for both new installs and existing button preferences.
{
    assert.equal(getMotionPolicy().clusterGlass, false);
    const previousWindow = globalThis.window;
    let saved = JSON.stringify({ nativeGlass: true, webMotion: false });
    globalThis.window = { localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } } };
    const existing = await import('../../../src/motion/policy.js?existing-cluster-preferences');
    assert.equal(existing.getMotionPolicy().clusterGlass, false, 'an existing nativeGlass preference does not opt into clusters');
    existing.setMotionPreferences({ clusterGlass: true });
    const reloaded = await import('../../../src/motion/policy.js?reloaded-cluster-preferences');
    assert.equal(reloaded.getMotionPolicy().clusterGlass, true, 'the opt-in persists on this device');
    assert.equal(reloaded.getMotionPolicy().webMotion, false, 'other stored preferences survive');
    setMotionPreferences({ clusterGlass: true, nativeGlass: false });
    assert.equal(getMotionPolicy().clusterGlass, true, 'cluster glass is independent from glass buttons');
    setMotionPreferences({ clusterGlass: false, nativeGlass: true });
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
}

console.log('Native cluster transport and animation sampling passed.');
