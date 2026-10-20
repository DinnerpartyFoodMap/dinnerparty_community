// Real map, local search routes, explicit external route and native JS bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-search-ui-'));
process.env.DB_FILE = path.join(temp, 'search.sqlite');
process.env.LOG_TO_FILE = 'false'; process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = ''; process.env.DEEPSEEK_API_KEY = '';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const { createSearchBudget } = require('../../modules/maps/services/amapSearchBudget');
const { createAmapSearch } = require('../../modules/maps/services/amapSearch');
const { createAmapSearchRouter } = require('../../modules/maps/routes/amapSearch');
let browser, vite, server;

async function main() {
    init();
    db._raw.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run('search-user', 'search-user', 'unused');
    db._raw.prepare('INSERT INTO Place (id, name, category, longitude, latitude, creator_id) VALUES (1, ?, ?, 120, 30, ?)').run('测试店', '面馆', 'search-user');
    const budget = createSearchBudget(db._raw); budget.configure({ dailyLimit: 100 });
    let upstreamCalls = 0;
    const service = createAmapSearch({ budget, key: () => 'test-key', fetchImpl: async url => {
        upstreamCalls++;
        const q = new URL(url).searchParams.get('keywords');
        await new Promise(resolve => setTimeout(resolve, 180));
        return new Response(JSON.stringify({ status: '1', pois: [{ id: 'p1', name: `${q}新分店`, location: '120.002,30.002', address: '测试路 1 号', cityname: '测试城市', type: '餐饮服务;快餐厅' }] }));
    } });
    const app = express(); app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/api', require('../../modules/discovery/routes/search'));
    app.use('/api/amap/search', createAmapSearchRouter(service));
    app.use('/api/community', require('../../modules/community/routes/community'));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'warn' });
    const theme = (fs.readFileSync(path.join(frontend, 'index.html'), 'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g) || []).join('\n');
    app.get('/__search_ui', async (req, res) => {
        const native = Object.hasOwn(req.query, 'native');
        res.type('html').send(await vite.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts/material-symbols.css"><style>${theme}body{margin:0;font-family:system-ui}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(jwt.sign({ id: 'search-user' }, process.env.JWT_SECRET || 'yuyuko_secret_key'))};${native ? 'window.CapacitorCustomPlatform={name:"ios"};' : ''}</script><script type="module" src="/tests/integration/search-harness.jsx"></script></body></html>`));
    });
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const capture = async name => {
        if (!process.env.SEARCH_ARTIFACT_DIR) return;
        fs.mkdirSync(process.env.SEARCH_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SEARCH_ARTIFACT_DIR, `${name}.png`) });
    };
    for (const native of [false, true]) {
        await page.setViewportSize(native ? { width: 390, height: 844 } : { width: 1280, height: 900 });
        await page.goto(`${base}/__search_ui${native ? '?native=1' : ''}`);
        await page.waitForFunction(() => window.__TEST_MAPS?.length > 0);
        const input = page.getByPlaceholder('搜店名，或说说现在想吃什么');
        if (native) {
            try { await page.waitForFunction(() => window.__native?.visible && window.__native?.state.revision > 0); }
            catch (error) {
                console.error(await page.evaluate(async () => ({
                    native: window.__native?.state, visible: window.__native?.visible,
                    platform: window.Capacitor?.getPlatform(), available: window.Capacitor?.isPluginAvailable('NativeMapChrome'),
                    status: (await import('/src/platform/nativeMapChrome.js')).getNativeChromeStatus()
                })));
                throw error;
            }
            await page.evaluate(() => window.__native.open());
            await page.waitForFunction(() => window.__native.state.search.expanded);
        }
        const type = async value => native ? page.evaluate(v => window.__native.input(v), value) : input.fill(value);
        const submit = async value => native ? page.evaluate(v => window.__native.submit(v), value) : input.press('Enter');
        const before = upstreamCalls;
        await type('测试店');
        await page.locator('.fm-search-results').getByText('测试店', { exact: true }).waitFor();
        await submit('测试店');
        await page.waitForTimeout(650);
        assert.equal(upstreamCalls, before, 'input and submit must stay local');
        assert.equal(await page.evaluate(() => window.__sdkSearchCalls), 0);
        // Nearby marker refreshes must not cause external requests either.
        await page.evaluate(() => window.__TEST_MAPS[0].setCenter([120.001, 30.001]));
        await page.waitForTimeout(500);
        assert.equal(upstreamCalls, before);
        const button = page.getByRole('button', { name: '没找到？查找未收录地点', exact: true });
        await button.click();
        await page.getByRole('button', { name: '正在查找未收录地点…', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '正在查找未收录地点…', exact: true }).isDisabled(), true);
        await page.locator('.fm-search-results').getByText('测试店新分店', { exact: true }).waitFor();
        assert.equal(upstreamCalls, before + 1);
        await page.locator('.fm-search-results').getByText('测试店', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '已查找未收录地点', exact: true }).isDisabled(), true);
        if (native) {
            assert.match(await page.evaluate(() => window.__native.state.search.hint), /已收录/);
            assert.equal(await page.evaluate(() => window.__native.state.search.focus), false);
        }
        await capture(native ? 'ios-search-results' : 'desktop-search-results');
        // Old results disappear on edit; a failure retains the local marker results.
        budget.configure({ enabled: false });
        await type('测试');
        await page.getByRole('button', { name: '没找到？查找未收录地点', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '外部地点搜索暂时关闭' }).waitFor();
        await page.locator('.fm-search-results').getByText('测试店', { exact: true }).waitFor();
        assert.equal(upstreamCalls, before + 1);
        assert.equal(await page.locator('.fm-search-results').getByText('测试店新分店', { exact: true }).count(), 0);
        await capture(native ? 'ios-search-disabled' : 'desktop-search-disabled');
        budget.configure({ enabled: true });
        // A newly created marker replaces the external suggestion without another paid query.
        const query = native ? '手机未收录' : '网页未收录';
        await type(query);
        await page.getByRole('button', { name: '没找到？查找未收录地点', exact: true }).click();
        await page.locator('.fm-search-results').getByText(`${query}新分店`, { exact: true }).waitFor();
        assert.equal(await page.locator('.fm-search-results').getByText('未找到匹配的结果', { exact: true }).count(), 0);
        db._raw.prepare('INSERT INTO Place (name, category, longitude, latitude, creator_id) VALUES (?, ?, 120.002, 30.002, ?)').run(`${query}新分店`, '面馆', 'search-user');
        await page.evaluate(() => window.dispatchEvent(new Event('journey:places-changed')));
        await page.locator('.fm-search-results').getByText('站内地点', { exact: true }).waitFor();
        await page.locator('.fm-search-results').getByText(`${query}新分店`, { exact: true }).waitFor();
        assert.equal(upstreamCalls, before + 2);
        assert.equal(await page.locator('.fm-search-results').getByText(`${query}新分店`, { exact: true }).count(), 1);
    }
    assert.equal(budget.status().sources.map_manual, 4);
    assert.deepEqual(errors, []);
    console.log('Search UI passed: desktop and native iOS input/submit stay local; explicit search, busy state, results, budget errors and marker refresh.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    const resolved = path.resolve(temp);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('foodmap-search-ui-')) fs.rmSync(resolved, { recursive: true, force: true });
});
