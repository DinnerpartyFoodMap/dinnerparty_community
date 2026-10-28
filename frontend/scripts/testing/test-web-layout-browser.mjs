// Actual browser geometry, hit testing and component interactions; AMap/HTTP doubles only.
// Run from frontend: node scripts/testing/test-web-layout-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foodmap-web-layout-'));
const browser = process.env.CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const theme = (readFileSync(join(root, 'index.html'), 'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g) || []).join('\n');
const requests = [];
const searchResults = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: '搜索结果面馆 ' + (index + 1), category: '面食', description: '供搜索结果交叠布局验证', longitude: 120 + index / 10000, latitude: 30, rating_count: 2, rating_average: 3.5 }));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts/material-symbols.css"><style>${theme}body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><script>
window.__WEB_LAYOUT_ERRORS=[]; addEventListener('error', event => window.__WEB_LAYOUT_ERRORS.push(event.message));
addEventListener('unhandledrejection', event => window.__WEB_LAYOUT_ERRORS.push(String(event.reason)));
localStorage.setItem('foodmap.privacy-consent', JSON.stringify({version:'2026-10-16',decision:'accepted'}));
localStorage.setItem('foodmap.onboarding', JSON.stringify({version:3}));
localStorage.setItem('yuyuko.motion.v1', JSON.stringify({webMotion:false,clusterMotion:false}));
</script><script type="module" src="/tests/integration/web-layout-harness.jsx"></script></body></html>`;
const server = await createServer({ root, configFile: resolve(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'web-layout-regression', configureServer(server) {
    server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/__web-layout') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
        const responses = {
            '/users/me': { user: { id: 'web-layout-user', username: '布局测试住民', is_banned: false } },
            '/places/nearby': [], '/api/favorites': [], '/categories': ['面食'],
            '/api/community/consent': { feedback: false, version: 1 },
            '/api/places/search/fast': searchResults,
            '/places/list': { items: [], total: 0, personalized: false }
        };
        if (!Object.hasOwn(responses, url.pathname)) return next();
        requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(responses[url.pathname]));
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
    const evaluate = async expression => {
        const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    const waitFor = async expression => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
        const page = await evaluate('document.documentElement.outerHTML');
        writeFileSync(join(scratch, 'failed-page.html'), page);
        const image = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(join(scratch, 'failed-page.png'), Buffer.from(image.data, 'base64'));
        throw new Error('Browser condition timed out: ' + expression);
    };
    const click = async selector => {
        const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
    };
    const screenshot = async name => {
        await waitFor(`[...document.querySelectorAll('.fm-surface,.fm-search-results')].every(element => Number(getComputedStyle(element).opacity) >= 0.999)`);
        await evaluate(`Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))`);
        const shot = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(join(scratch, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    const waitForRequest = async condition => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) { const entry = requests.filter(item => item.path === '/places/list').at(-1); if (entry && condition(entry.query)) return entry; await new Promise(resolve => setTimeout(resolve, 25)); }
        throw new Error('List API boundary did not receive the expected query');
    };
    const navigate = async (mode, width, height) => {
        await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 }, sessionId);
        await command('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/__web-layout?mode=${mode}` }, sessionId);
        await waitFor(`document.readyState === 'complete'`);
    };

    await navigate('map', 390, 844);
    await waitFor(`!!document.querySelector('.fm-map-search__input:not([disabled])')`);
    await click('.fm-map-search__input');
    await command('Input.insertText', { text: '面馆' }, sessionId);
    await waitFor(`document.querySelector('.fm-search-results')?.textContent.includes('搜索结果面馆 12')`);
    await evaluate(`document.fonts.ready`);
    const overlap = await evaluate(`(() => {
        const results = document.querySelector('.fm-search-results'), r = results.getBoundingClientRect();
        return ['locate','filter','listView'].map(name => {
            const button=document.querySelector('[data-tour="'+name+'"]'), b=button.getBoundingClientRect();
            const left=Math.max(r.left,b.left),right=Math.min(r.right,b.right),top=Math.max(r.top,b.top),bottom=Math.min(r.bottom,b.bottom);
            if(right<=left || bottom<=top) return null;
            const x=(left+right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);
            return {button:name,x,y,resultOnTop:!!hit?.closest('.fm-search-results'),hit:hit?.tagName};
        }).filter(Boolean);
    })()`);
    assert.ok(overlap.length > 0, 'the narrow fixture actually overlaps at least one right-side map button');
    assert.ok(overlap.every(item => item.resultOnTop), 'search results win elementFromPoint at every overlapping control');
    await screenshot('narrow-search-overlap');
    assert.deepEqual(await evaluate('window.__WEB_LAYOUT_ERRORS'), [], 'narrow search has no browser errors');

    await navigate('map', 1280, 900);
    await waitFor(`!!document.querySelector('.fm-map-search__filter [data-tour="filter"]:not([disabled])') && !!document.querySelector('header [data-tour="more"]')`);
    const wide = await evaluate(`(() => {
        const s=document.querySelector('.fm-map-search__submit').getBoundingClientRect(), f=document.querySelector('.fm-map-search__filter [data-tour="filter"]').getBoundingClientRect();
        return {submit:[s.width,s.height],filter:[f.width,f.height],gap:f.left-s.right,topDelta:f.top-s.top,routeButtons:[...document.querySelectorAll('[data-tour="alongRoute"]')].filter(e=>e.getBoundingClientRect().width>0).length};
    })()`);
    assert.deepEqual(wide, { submit: [44,44], filter: [44,44], gap: 8, topDelta: 0, routeButtons: 0 }, 'wide filter is immediately right of submit with 8px gap and route has no separate round button');
    await screenshot('wide-search-filter');
    await click('header [data-tour="more"]');
    await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent.trim()==='顺路吃')`);
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()==='顺路吃').dataset.layoutRouteItem='true'`);
    await click('[data-layout-route-item]');
    await waitFor(`document.querySelector('#route-request-id')?.textContent==='1' && !!document.querySelector('[role="region"][aria-label="顺路吃"]')`);
    await screenshot('wide-more-along-route');
    assert.deepEqual(await evaluate('window.__WEB_LAYOUT_ERRORS'), [], 'More to route has no browser errors');

    await navigate('list', 390, 844);
    await waitFor(`!!document.querySelector('.fm-map-list__radius select')`);
    const options = await evaluate(`(() => {const s=document.querySelector('.fm-map-list__radius select');return {value:s.value,options:[...s.options].map(o=>({value:o.value,text:o.textContent})),buttonHeight:document.querySelector('.fm-map-list__center-button').getBoundingClientRect().height};})()`);
    assert.deepEqual(options.options, [{value:'0.5',text:'500 米内'},{value:'1',text:'1 公里内'},{value:'3',text:'3 公里内'},{value:'5',text:'5 公里内'},{value:'10',text:'10 公里内'}], 'the list exposes the five requested radius options');
    assert.equal(options.value, '3', 'the list starts at 3km');
    assert.ok(options.buttonHeight >= 44, 'the center is a large touch button');
    await waitFor(`document.querySelector('.fm-place-list__summary')?.textContent.includes('0 个地点')`);
    const defaultRequest = requests.filter(entry => entry.path === '/places/list').at(-1);
    assert.deepEqual(defaultRequest.query, {lat:'30.000000',lng:'120.000000',radiusKm:'3',offset:'0',limit:'20'}, 'the default list request carries 3km and the opening map center');
    await evaluate(`(() => {const s=document.querySelector('.fm-map-list__radius select');s.value='0.5';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.fm-map-list__radius select').value==='0.5' && document.querySelector('.fm-place-list__summary')?.textContent.includes('0 个地点')`);
    const halfKm = await waitForRequest(query => query.radiusKm === '0.5');
    assert.equal(halfKm.query.radiusKm, '0.5', 'selecting 500m sends radiusKm=0.5 to the actual API boundary');
    await click('.fm-map-list__center-button');
    await waitFor(`document.querySelector('[role="menuitem"]')?.textContent.trim()==='换个中心'`);
    await screenshot('list-center-menu');
    await click('[role="menuitem"]');
    await waitFor(`document.querySelector('.fm-map-list__center-button')?.textContent.includes('选定的位置')`);
    assert.deepEqual(await evaluate('window.__WEB_LAYOUT_PICK_CENTERS'), [{lng:120,lat:30}], 'changing the center passes the existing center to the picker boundary');
    const customCenter = await waitForRequest(query => query.lat === '31.500000' && query.lng === '121.500000');
    assert.deepEqual(customCenter.query, {lat:'31.500000',lng:'121.500000',radiusKm:'0.5',offset:'0',limit:'20'}, 'the selected center is sent to the list API while retaining the 500m radius');
    await click('.fm-map-list__center-button');
    await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent.trim()==='改回地图中心')`);
    await screenshot('list-custom-center-menu');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()==='改回地图中心').dataset.layoutRestore='true'`);
    await click('[data-layout-restore]');
    await waitFor(`document.querySelector('.fm-map-list__center-button')?.textContent.includes('地图中心')`);
    const restoredCenter = await waitForRequest(query => query.lat === '30.000000' && query.lng === '120.000000');
    assert.deepEqual(restoredCenter.query, {lat:'30.000000',lng:'120.000000',radiusKm:'0.5',offset:'0',limit:'20'}, 'restoring the map center also restores its API coordinates');
    assert.deepEqual(await evaluate('window.__WEB_LAYOUT_ERRORS'), [], 'list center controls have no browser errors');

    await navigate('radar', 500, 500);
    await waitFor(`document.querySelectorAll('svg text').length===6`);
    const radar = await evaluate(`(() => {const s=document.querySelector('svg');return {texts:[...s.querySelectorAll('text')].map(e=>e.textContent),labels:[...s.querySelectorAll('[role="button"]')].map(e=>e.getAttribute('aria-label')),fills:[...s.querySelectorAll('polygon')].filter(e=>e.getAttribute('fill')!=='none').map(e=>({points:e.getAttribute('points'),opacity:e.getAttribute('fill-opacity')})),circles:s.querySelectorAll('circle').length};})()`);
    assert.deepEqual(radar.texts, ['家常正餐','粉面简餐','火锅烧烤','甜品烘焙','咖啡茶饮','异国料理'], 'the radar draws only the six category names');
    assert.deepEqual(radar.labels, ['家常正餐：很喜欢','粉面简餐：喜欢','火锅烧烤：待了解','甜品烘焙：一般','咖啡茶饮：不太喜欢','异国料理：很喜欢'], 'axis values remain available to screen readers');
    assert.equal(radar.fills.length, 4, 'only four adjacent known-axis pairs get fills');
    assert.ok(radar.fills.every(fill => fill.points.startsWith('150,150 ') && fill.points.split(' ').length===3 && fill.opacity==='0.2'), 'each fill is a translucent triangle rooted at the center');
    assert.equal(radar.circles, 5, 'the unknown axis has no fabricated value marker');
    await screenshot('radar-six-labels-and-fill');
    assert.deepEqual(await evaluate('window.__WEB_LAYOUT_ERRORS'), [], 'radar has no browser errors');
    console.log(JSON.stringify({ passed: true, overlap, wide, options, radarFillCount: radar.fills.length, screenshots: scratch }));
    await command('Browser.close');
} catch (error) { console.error(error); console.error('Artifacts: ' + scratch); process.exitCode = 1; }
finally { socket?.close(); processHandle?.kill(); await server.close(); }
