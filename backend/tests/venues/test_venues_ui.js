// 后台「展会场馆」浏览器回归：真实 AdminVenues + 临时库。
// 覆盖：待办列表、计数与刷新、忽略的确认与结果、落点后离开待办、窄屏不横向滚动、深色。
// 截图：设 VENUE_UI_SCREENSHOTS=<目录> 时保存浅色 / 深色 / 窄屏三张。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-venues-ui-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
let browser, server, vite;

async function main() {
    init();
    const venues = require('../../modules/venues/services/venues');
    const id = randomUUID();
    db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, 'admin', 'unused', 'KOMACHI');
    const token = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    // 与推送接口相同：先逐条校验再入库
    const push = (events) => venues.receivePush({ events: events.map(venues.normalizeEvent) });
    push([
        { key: 'expo-a', label: '上海新国际博览中心（Comic Horizon 2026）', address: '上海市浦东新区龙阳路2345号', city: '上海' },
        { key: 'expo-b', label: '保利世贸博览馆', city: '广州' }
    ]);

    const app = express();
    app.use(express.json());
    const auth = require('../../modules/accounts/middleware/auth').requireAuth;
    app.use('/admin/venues', auth, require('../../modules/venues/routes/admin'));
    app.use('/venues', require('../../modules/venues/routes/public'));
    app.get('/places/regions', (req, res) => res.json({ regions: [] }));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
    app.get('/__venue_ui', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.url,
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token)}</script><script type="module" src="/tests/integration/venue-admin-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
    const shots = process.env.VENUE_UI_SCREENSHOTS;
    // 换主题后控件背景有 150ms 过渡，等它结束再截
    const shot = async (name) => { if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `venues-${name}.png`), fullPage: true }); } };

    await page.goto(`http://127.0.0.1:${server.address().port}/__venue_ui`, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.getByText('2 个场馆等待定位', { exact: true }).waitFor({ timeout: 60000 });
    const cards = page.locator('article');
    assert.equal(await cards.count(), 2);
    await cards.first().getByText('上海市浦东新区龙阳路2345号', { exact: true }).waitFor();
    await cards.nth(1).getByText(/^广州 · 收到于 /).waitFor();
    await shot('light');

    // 对端又推了一条：刷新后出现，列表不清空
    push([{ key: 'expo-c', label: '国家会展中心（天津）', city: '天津' }]);
    await page.getByRole('button', { name: '刷新' }).click();
    await page.getByText('3 个场馆等待定位', { exact: true }).waitFor();

    // 忽略：确认框按钮写动作本身，确认后离开待办
    await cards.filter({ hasText: '保利世贸博览馆' }).getByRole('button', { name: '忽略', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText(/^忽略「保利世贸博览馆」？/).waitFor();
    await dialog.getByRole('button', { name: '忽略', exact: true }).click();
    await page.getByText('2 个场馆等待定位', { exact: true }).waitFor();
    assert.equal(venues.resolve('expo-b').status, 'ignored');

    // 落点（选点器需要真实地图，这里直接走服务）后刷新：离开待办，公开解析给出坐标
    const [expoA] = venues.pendingVenues().filter(item => item.external_key === 'expo-a');
    venues.place({ id: expoA.id, latitude: 31.2035, longitude: 121.5732, adminId: id });
    await page.getByRole('button', { name: '刷新' }).click();
    await page.getByText('1 个场馆等待定位', { exact: true }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.deepEqual(venues.resolve('expo-a'), { status: 'placed', latitude: 31.2035, longitude: 121.5732 });

    // 深色与窄屏：不横向滚动
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot('dark');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no horizontal scroll at 360px');
    await shot('narrow');

    assert.deepEqual(errors, []);
    console.log('Venue admin browser flow passed: pending list, count and refresh, ignore confirm, placed venues leave the queue, dark theme, 360px width.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
