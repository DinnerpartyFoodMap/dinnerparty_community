// Optional Chromium smoke test: CHROME_BIN overrides the executable on macOS/Linux/Windows.
import { createServer, loadEnv } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foodmap-native-clusters-'));
const browser = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const modulePath = process.argv[2];
const exportName = process.argv[3];
if (!modulePath || !exportName) throw new Error('Usage: run-map-browser.mjs /tests/integration/harness.js exportName');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="result">Loading</pre><script type="module">
import { ${exportName} as runTests } from '${modulePath}';
try { const result = await runTests(); document.getElementById('result').textContent = JSON.stringify(result); document.body.dataset.result = 'passed'; }
catch(error) { document.getElementById('result').textContent = JSON.stringify({passed:false,error:error.stack}); document.body.dataset.result = 'failed'; }
</script></body></html>`;
const server = await createServer({ root, configFile: resolve(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'native-cluster-smoke', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
        if (req.url === '/__map-amap-config') {
            try {
                const config = loadEnv('production', root, 'VITE_');
                const backend = config.VITE_BACKEND_URL;
                if (!backend) throw new Error('No benchmark backend configured');
                const reply = await fetch(backend + '/api/amap/js-config', {signal:AbortSignal.timeout(10000)});
                const body = await reply.json();
                res.setHeader('Content-Type','application/json');
                res.end(JSON.stringify({key:body.key,serviceHost:new URL(backend).origin+'/_AMapService'}));
            } catch (_) { res.statusCode=503; res.end('AMap public configuration unavailable'); }
            return;
        }
        if (new URL(req.url, 'http://localhost').pathname === '/__native-cluster-api/places/list') {
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [], total: 0 })); return;
        }
        if (req.url !== '/__native-cluster-smoke') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
    });
} }] });
let processHandle;
let socket;
try {
    await server.listen();
    const { port } = server.httpServer.address();
    // CDP 使用真实时钟。虚拟时间会让 JS 计时先跑完，Web Animations 的 compositor 却尚未推进。
    processHandle = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'profile')}`, '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
    let seq = 0, traceHandle = null; const pending = new Map();
    const tracePath = process.env.FOODMAP_TRACE_PATH;
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data); const entry = pending.get(message.id);
        if (message.method === 'Tracing.tracingComplete') traceHandle = message.params.stream;
        if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    });
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    if (tracePath) await command('Tracing.start', {
        categories:'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'
    });
    const { targetId } = await command('Target.createTarget', { url: `http://127.0.0.1:${port}/__native-cluster-smoke` });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'no-preference'}] }, sessionId);
    let result;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const snapshot = await command('Runtime.evaluate', { expression: 'document.body?.dataset.result ? document.getElementById("result").textContent : null', returnByValue: true }, sessionId);
        if (snapshot.result?.value) { result = JSON.parse(snapshot.result.value); break; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const page = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
    writeFileSync(join(scratch, 'rendered.html'), page.result.value);
    const browserVersion = await command('Browser.getVersion');
    if (result) result.environment = {browser:browserVersion.product,window:'1280x900',gpu:false};
    console.log(JSON.stringify(result || { passed: false, error: 'No browser result' }));
    if (!result?.passed) { console.error(`Browser output: ${scratch}`); process.exitCode = 1; }
    if (tracePath) {
        await command('Tracing.end');
        const traceDeadline = Date.now()+10000;
        while (!traceHandle && Date.now()<traceDeadline) await new Promise(resolve=>setTimeout(resolve,50));
        if (!traceHandle) throw new Error('Browser trace stream unavailable');
        let trace = '', chunk;
        do { chunk = await command('IO.read',{handle:traceHandle}); trace += chunk.data; } while (!chunk.eof);
        await command('IO.close',{handle:traceHandle});
        writeFileSync(resolve(tracePath),trace);
    }
    await command('Browser.close');
} finally { socket?.close(); processHandle?.kill(); await server.close(); }
