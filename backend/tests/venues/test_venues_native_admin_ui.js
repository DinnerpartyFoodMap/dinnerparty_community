// iOS 原生后台的展会场馆选点（网页一侧）：真实 NativeAdminHost、控制器、会话与场馆接口 + 临时库；
// 原生插件与全屏选点地图是测试替身（Vite 别名，见 frontend/tests/integration/native-admin-venues-harness.jsx）。
// 覆盖：后台首页进入场馆页 →「在地图上定位」关闭原生后台（不当作关闭整个后台）→ 选点地图按城市定中心 →
// 选中后落点并重新打开到场馆页（带结果提示）；取消时不落点、同样回到场馆页；从场馆页返回首页。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-venues-native-ui-'));
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
    db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, '小町', 'unused', 'KOMACHI');
    const token = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    venues.receivePush({ events: [
        { key: 'expo-a', label: '上海新国际博览中心', address: '龙阳路2345号', city: '上海' },
        { key: 'expo-b', label: '国家会展中心（天津）', city: '天津' }
    ].map(venues.normalizeEvent) });

    const app = express();
    app.use(express.json());
    const auth = require('../../modules/accounts/middleware/auth').requireAuth;
    app.use('/admin/venues', auth, require('../../modules/venues/routes/admin'));
    app.get('/places/regions', (req, res) => res.json({ regions: [
        { name: '上海市', bounds: [121, 30.7, 122, 31.9], children: [{ name: '上海市', bounds: [121.2, 31.0, 121.8, 31.4] }] }
    ] }));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({
        root: frontend, appType: 'custom', logLevel: 'silent',
        server: { middlewareMode: true, hmr: false },
        resolve: { alias: [
            { find: /^@capacitor\/core$/, replacement: path.join(frontend, 'tests/integration/fakes/capacitorCore.js') },
            { find: /^\.\.\/map\/MapView$/, replacement: path.join(frontend, 'tests/integration/fakes/mapPicker.jsx') }
        ] }
    });
    app.get('/__native_admin_venues', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.url,
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token)}</script><script type="module" src="/tests/integration/native-admin-venues-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/__native_admin_venues`, { timeout: 60000, waitUntil: 'domcontentloaded' });

    const fake = (expression) => page.evaluate(expression);
    const waitFor = (expression, timeout = 8000) => page.waitForFunction(expression, null, { timeout });
    const tap = (actionId) => page.evaluate((actionId) => window.__fakeNativeAdmin.tap(actionId), actionId);
    const lastPage = () => fake(() => window.__fakeNativeAdmin.responded.at(-1)?.page);

    // 1. 打开后台首页：小町也有「展会场馆」，没有直接进入的页面
    await waitFor(() => window.__fakeNativeAdmin?.opens.length === 1, 60000);
    const first = await fake(() => window.__fakeNativeAdmin.opens[0]);
    assert.equal(first.page, undefined);
    const entry = first.dashboard.sections[0].rows.find((row) => row.id === 'venues');
    assert.ok(entry, 'venues row on the dashboard');

    // 2. 进入场馆页，点第一条的「在地图上定位」：原生后台关闭，选点地图按城市定中心
    await tap(entry.actions[0].id);
    await waitFor(() => window.__fakeNativeAdmin.responded.at(-1)?.page?.id?.startsWith('admin-venues'));
    const list = await lastPage();
    assert.equal(list.sections[0].rows.length, 2);
    const expoA = list.sections[0].rows.find((row) => row.title === '上海新国际博览中心');
    await tap(expoA.actions[0].id);
    await waitFor(() => window.__fakeNativeAdmin.current === null);
    const picker = page.getByRole('dialog', { name: '选择场馆位置' });
    await picker.waitFor();
    assert.equal(await picker.getAttribute('data-context'), 'venue');
    assert.equal(await picker.getAttribute('data-center'), '31.2,121.5');

    // 3. 选中：落点写库，原生后台重新打开并直接进入场馆页，带结果提示，已落点的那条不在待办里
    await picker.getByRole('button', { name: '选这里' }).click();
    await waitFor(() => window.__fakeNativeAdmin.opens.length === 2);
    await picker.waitFor({ state: 'detached' });
    assert.deepEqual(venues.resolve('expo-a'), { status: 'placed', latitude: 31.2035, longitude: 121.5732 });
    const reopened = await fake(() => window.__fakeNativeAdmin.opens[1]);
    assert.equal(reopened.dashboard.id, 'admin-dashboard');
    assert.ok(reopened.page.id.startsWith('admin-venues'));
    assert.equal(reopened.page.level, 1);
    assert.equal(reopened.page.message, '已保存位置，跳转时会聚焦到这里');
    assert.deepEqual(reopened.page.sections[0].rows.map((row) => row.title), ['国家会展中心（天津）']);

    // 4. 重新打开后的动作照常可用：另一条取消选点，不落点，回到场馆页（没有提示）；天津不在地区树里，用默认视野
    const expoB = reopened.page.sections[0].rows[0];
    await tap(expoB.actions[0].id);
    await picker.waitFor();
    assert.equal(await picker.getAttribute('data-center'), '');
    await picker.getByRole('button', { name: '返回' }).click();
    await waitFor(() => window.__fakeNativeAdmin.opens.length === 3);
    const afterCancel = await fake(() => window.__fakeNativeAdmin.opens[2]);
    assert.equal(afterCancel.page.message, '');
    assert.equal(venues.resolve('expo-b').status, 'pending');

    // 5. 从场馆页返回首页：网页回传首页模型
    await page.evaluate(() => window.__fakeNativeAdmin.listener({ id: window.__fakeNativeAdmin.current.id, type: 'back', requestId: 'back-1' }));
    await waitFor(() => window.__fakeNativeAdmin.responded.at(-1)?.page?.id === 'admin-dashboard');

    // 选点过程不算关闭后台，也没有回退网页后台
    assert.deepEqual(await fake(() => window.__hostEvents), []);
    assert.deepEqual(errors, []);
    console.log('Native admin venue picking passed: dashboard entry, close for picking, city centre, place + reopen on the venues page with a tip, cancel, back to dashboard.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
