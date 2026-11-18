// Run with an installed Chromium browser: node scripts/testing/test-marker-tile-auth-browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const browser = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const token = 'synthetic-persisted-tile-session';
const ticket = 'synthetic-leaf-ticket';
const guestTile = '/places/tiles/111111111111/12/3413/1689';
const authenticatedTile = '/places/tiles/222222222222/12/3424/1676';
const ticketPath = '/places/tiles/ticket';
const tileRequests = [];
const emptyLeafTile = {
    v: 1, z: 12, fields: ['id', 'name', 'category', 'longitude', 'latitude', 'per_person_cost', 'province', 'city', 'district', 'rating_count', 'rating_average', 'rating_negative_count', 'checkin_count'], rows: [],
};
const responses = {
    '/users/me': { user: { id: 'tile-regression', username: '瓦片测试住民', is_banned: false } },
    '/places/overlay': { own: [], hidden_ids: [] },
    '/api/favorites': [],
    '/categories': [],
    '/places/tiles/manifest': {
        v: 1, version: 'fixture', generated_at: 1, count: 2, dict: '000000000000',
        levels: [{ tile: 2, cell: 9, minZoom: 0, maxZoom: 7 }, { tile: 5, cell: 12, minZoom: 8, maxZoom: 10 }, { tile: 8, cell: 14, minZoom: 11, maxZoom: 12 }],
        leaf: { tile: 12, minZoom: 13 }, tiles: { 2: {}, 5: {}, 8: {}, 12: { '3413/1689': '111111111111', '3424/1676': '222222222222' } },
    },
    '/places/tiles/000000000000/dict': { v: 1, tags: [], regions: [] },
    [guestTile]: emptyLeafTile,
    [authenticatedTile]: emptyLeafTile,
};
const html = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="root"></div><script>
localStorage.setItem('token', ${JSON.stringify(token)});
localStorage.setItem('foodmap.onboarding', JSON.stringify({version:3}));
window.__TEST_TOKEN = localStorage.getItem('token');
window.__TEST_AUTHENTICATED = false;
</script><script type="module">
import { flushSync } from 'react-dom';
import '/tests/integration/place-location-harness.jsx';
async function confirmSession() {
    const response = await fetch('/__tile-auth/guest-loaded');
    if (response.status !== 204) return;
    flushSync(() => window.__TEST_SET_VIEWER({ token: localStorage.getItem('token'), isAuthenticated: true }));
    window.__TEST_MAPS.at(-1).setCenter([121, 31]);
}
confirmSession();
</script>`;

const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{
    name: 'marker-tile-auth-fixture',
    configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, 'http://localhost');
            const { pathname } = url;
            if (pathname === '/__tile-auth') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(await server.transformIndexHtml(pathname, html));
                return;
            }
            if (pathname === '/__tile-auth/guest-loaded') {
                const deadline = Date.now() + 10000;
                while (!res.destroyed && Date.now() < deadline && !tileRequests.some(request => request.path === guestTile)) await delay(25);
                res.writeHead(tileRequests.some(request => request.path === guestTile) ? 204 : 408).end();
                return;
            }
            if ([guestTile, authenticatedTile, ticketPath].includes(pathname)) {
                tileRequests.push({ path: pathname, authorization: req.headers.authorization ?? null, ticket: url.searchParams.get('t') });
            }
            if (pathname !== ticketPath && !Object.hasOwn(responses, pathname)) {
                if (!/^\/(api|places|users)\//.test(pathname)) return next();
                res.writeHead(404).end();
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            if (pathname === ticketPath && req.headers.authorization !== `Bearer ${token}`) {
                res.writeHead(401).end('{}');
                return;
            }
            res.end(JSON.stringify(pathname === ticketPath ? { ticket, expires_at: Date.now() + 600000 } : responses[pathname]));
        });
    },
}] });

const profile = await mkdtemp(join(tmpdir(), 'foodmap-tile-auth-'));
let chromium;
try {
    await server.listen();
    const { port } = server.httpServer.address();
    chromium = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/__tile-auth`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
        chromium.once('spawn', resolve);
        chromium.once('error', reject);
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !tileRequests.some(request => request.path === authenticatedTile)) await delay(25);
    assert.ok(tileRequests.some(request => request.path === authenticatedTile), `Viewport move did not request the second leaf tile: ${JSON.stringify(tileRequests)}`);
    assert.deepEqual(tileRequests, [
        { path: guestTile, authorization: null, ticket: null },
        { path: ticketPath, authorization: `Bearer ${token}`, ticket: null },
        { path: authenticatedTile, authorization: null, ticket },
    ], 'Confirming the persisted session must acquire a ticket for the next uncached leaf tile');
    console.log('Marker tile authentication browser regression passed.');
} finally {
    chromium?.kill();
    server.httpServer?.closeAllConnections();
    await server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
