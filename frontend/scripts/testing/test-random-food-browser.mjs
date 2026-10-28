// Real React useRandomFood lifecycle regression with a deferred HTTP boundary.
// Run from frontend: node scripts/testing/test-random-food-browser.mjs
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foodmap-random-food-'));
const browser = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><pre id="result">Loading</pre><script type="module">
import { runRandomFoodBrowserTests } from '/tests/integration/random-food-harness.jsx';
try { const result = await runRandomFoodBrowserTests(); document.getElementById('result').textContent = JSON.stringify(result); document.body.dataset.result = 'passed'; }
catch(error) { document.getElementById('result').textContent = JSON.stringify({passed:false,error:error.stack}); document.body.dataset.result = 'failed'; }
</script></body></html>`;
const server = await createServer({ root, configFile: resolve(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'random-food-regression', configureServer(server) {
    server.middlewares.use((req, res, next) => {
        if (req.url !== '/__random-food') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
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
    const { targetId } = await command('Target.createTarget', { url: `http://127.0.0.1:${server.httpServer.address().port}/__random-food` });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    let result;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const snapshot = await command('Runtime.evaluate', { expression: 'document.body?.dataset.result ? document.getElementById("result").textContent : null', returnByValue: true }, sessionId);
        if (snapshot.result?.value) { result = JSON.parse(snapshot.result.value); break; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const page = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
    writeFileSync(join(scratch, 'rendered.html'), page.result.value);
    console.log(JSON.stringify(result || { passed: false, error: 'No browser result' }));
    if (!result?.passed) { console.error(`Browser output: ${scratch}`); process.exitCode = 1; }
    await command('Browser.close');
} finally { socket?.close(); processHandle?.kill(); await server.close(); }
