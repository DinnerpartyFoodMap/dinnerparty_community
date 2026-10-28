// Real MapView and add-place form; replace the external AMap and HTTP boundaries.
// Run from frontend: node scripts/testing/test-add-place-pick-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foodmap-add-place-pick-'));
const browser = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body><div id="root"></div><script>
window.__TEST_TOKEN = 'synthetic-add-place-session';
localStorage.setItem('foodmap.privacy-consent', JSON.stringify({version:'2026-10-16',decision:'accepted'}));
localStorage.setItem('foodmap.onboarding', JSON.stringify({version:3}));
</script><script type="module" src="/tests/integration/place-location-harness.jsx"></script></body></html>`;
const server = await createServer({ root, configFile: resolve(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'add-place-pick-regression', configureServer(server) {
    server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/__add-place-pick') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
        const responses = {
            '/users/me': { user: { id: 'add-place-regression', username: '点选测试', is_banned: false } },
            '/places/nearby': [], '/api/favorites': [], '/categories': []
        };
        if (!Object.hasOwn(responses, pathname)) return next();
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(responses[pathname]));
    });
} }] });
let processHandle, socket;
try {
    await server.listen();
    processHandle = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Chromium did not expose CDP')), 15000);
        processHandle.on('error', error => { clearTimeout(timer); reject(error); });
        processHandle.stderr.on('data', bytes => {
            output += bytes.toString(); const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let seq = 0; const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data), entry = pending.get(message.id);
        if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    });
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    const evaluate = async expression => {
        const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    await command('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/__add-place-pick` }, sessionId);
    // Each wait observes real React/DOM state; the deadline only bounds a failed run.
    const waitFor = async expression => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Browser condition timed out: ${expression}`);
    };
    await waitFor(`document.querySelector('[data-tour="add"]:not([disabled])') && window.__TEST_MAPS?.length`);
    await evaluate(`(() => {
        window.__ADD_PICK_ERRORS = [];
        addEventListener('error', event => window.__ADD_PICK_ERRORS.push(event.message));
        const map = window.__TEST_MAPS.at(-1);
        // The original integration double omitted panTo/getSize, hiding this regression behind its catch.
        window.AMap.Pixel = class { constructor(x, y) { this.x = x; this.y = y; } };
        map.getSize = () => ({ getHeight: () => 844 });
        map.containerToLngLat = pixel => new window.AMap.LngLat(120 + (pixel.x - 195) / 10000, 30 - (pixel.y - 422) / 10000);
        map.panTo = point => { map.setCenter([point.lng, point.lat]); };
        window.__ADD_PICK_CLICK = (lng, lat) => map.emit('click', { lnglat: { lng, lat }, target: map });
        document.querySelector('[data-tour="add"]').click();
    })()`);
    await waitFor(`document.querySelector('[data-tour="add"]')?.textContent.includes('取消')`);
    await evaluate(`window.__ADD_PICK_CLICK(120, 89.9)`);
    assert.equal(await evaluate(`!!document.querySelector('.fm-adding-pin')`), false, 'an invalid world-edge point does not create a marker or consume add mode');
    await evaluate(`window.__ADD_PICK_CLICK(120.01, 30.01)`);
    await waitFor(`!!document.querySelector('.fm-adding-pin') && !!document.querySelector('[role="dialog"] input')`);
    const snapshot = () => evaluate(`(() => {
        const map = window.__TEST_MAPS.at(-1);
        return { center: map.center, zoom: map.zoom, pins: [...map.markers].filter(marker => marker.options.content?.classList.contains('fm-adding-pin')).map(marker => marker.position) };
    })()`);
    assert.deepEqual(await snapshot(), { center: [120, 30], zoom: 16, pins: [[120.01, 30.01]] }, 'opening the narrow add form must not move the camera or the selected point');
    await evaluate(`window.__ADD_PICK_CLICK(120.02, 30.02)`);
    // Let any resulting effect finish before inspecting the SDK boundary.
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.deepEqual(await snapshot(), { center: [120, 30], zoom: 16, pins: [[120.01, 30.01]] }, 'a second map click while the form is open must not replace its fixed point');
    await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent.trim() === '取消').click()`);
    await waitFor(`!document.querySelector('.fm-adding-pin')`);
    await evaluate(`document.querySelector('[data-tour="add"]').click()`);
    await waitFor(`document.querySelector('[data-tour="add"]')?.textContent.includes('取消')`);
    // Both events occur before React's next effect; the selection guard must update synchronously.
    await evaluate(`window.__ADD_PICK_CLICK(120.03, 30.03); window.__ADD_PICK_CLICK(120.04, 30.04)`);
    await waitFor(`!!document.querySelector('.fm-adding-pin')`);
    assert.deepEqual(await snapshot(), { center: [120, 30], zoom: 16, pins: [[120.03, 30.03]] }, 'cancel allows a new point, and duplicate same-frame clicks keep the first valid selection');
    assert.deepEqual(await evaluate(`window.__ADD_PICK_ERRORS`), [], 'the real component has no browser errors');
    console.log('Add-place camera and point stability browser regression passed (AMap/HTTP doubles; no native device claim).');
    await command('Browser.close');
} finally { socket?.close(); processHandle?.kill(); await server.close(); }
