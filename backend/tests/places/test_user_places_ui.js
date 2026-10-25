// 按住民筛选（地点卡片点“最近修改”的名字）：真实 React 与接口、独立数据库，只有高德 SDK 是替身。
// 宽屏：列表与卡片同时可用、地图只剩这位住民的地点、筛选条退出；窄屏：列表是底部面板，选中地点后让位给卡片，
// 关掉卡片后筛选条仍在、可重新打开列表。USER_PLACES_ARTIFACT_DIR 设了时保存截图。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-user-places-ui-'));
Object.assign(process.env, { DB_FILE: path.join(temp, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' });
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
let browser, server, vite;

async function main() {
    init();
    const ids = {};
    for (const name of ['maker', 'editor', 'visitor', 'other']) {
        ids[name] = randomUUID();
        sql.prepare('INSERT INTO User(id, username, password) VALUES(?,?,?)').run(ids[name], name, 'unused');
    }
    const insert = sql.prepare(`INSERT INTO Place(name, category, description, longitude, latitude, creator_id, created_time, updated_by, updated_time, moderation_status)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const add = (name, lng, lat, creator, created, { editor = null, status = 'visible' } = {}) =>
        insert.run(name, '面食', `${name}的描述`, lng, lat, ids[creator], created, editor && ids[editor], editor && '2026-08-08 04:00:00', status);
    add('测试面馆', 120.006, 30.004, 'maker', '2026-01-01 08:00:00', { editor: 'editor' });
    add('牛肉面', 120.0, 30.0, 'maker', '2026-02-01 08:00:00');
    add('远方小馆', 121.0, 31.0, 'maker', '2026-03-01 08:00:00');
    add('别人的店', 119.994, 29.996, 'other', '2026-04-01 08:00:00');
    add('审核中的店', 120.003, 29.994, 'maker', '2026-05-01 08:00:00', { status: 'checking' });

    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    app.use('/users', require('../../modules/accounts/routes/users'));
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/api/favorites', require('../../modules/preferences/routes/favorites'));
    app.use('/api/ratings', require('../../modules/ratings/routes/placeRatings'));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'warn' });
    const themeCss = (fs.readFileSync(path.join(frontend, 'index.html'), 'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g) || []).join('\n');
    app.get('/__user_places_ui', async (req, res) => {
        res.type('html').send(await vite.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts/material-symbols.css"><style>${themeCss}body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token(ids.visitor))}</script><script type="module" src="/tests/integration/place-location-harness.jsx"></script></body></html>`));
    });
    app.use(vite.middlewares);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });

    const run = async ({ width, height, label }) => {
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const snap = async (name) => {
            if (!process.env.USER_PLACES_ARTIFACT_DIR) return;
            fs.mkdirSync(process.env.USER_PLACES_ARTIFACT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.USER_PLACES_ARTIFACT_DIR, `${label}-${name}.png`) });
        };
        // 替身地图把所有标记画在同一点，直接对标记分发点击
        const clickMarker = (name) => page.locator(`.fm-marker [role="button"][aria-label="${name}"]`).first().dispatchEvent('click');
        const markerNames = () => page.evaluate(() => [...window.__TEST_MAPS.filter((m) => !m.destroyed).at(-1).markers]
            .map((m) => m.options.content?.querySelector?.('[role="button"]')?.getAttribute('aria-label'))
            .filter(Boolean).sort());
        const waitMarkers = async (expected) => {
            const sorted = [...expected].sort();
            for (let i = 0; i < 40; i += 1) {
                if (JSON.stringify(await markerNames()) === JSON.stringify(sorted)) return;
                await page.waitForTimeout(100);
            }
            assert.deepEqual(await markerNames(), sorted);
        };
        const list = page.getByRole('dialog', { name: 'maker 创建的地点' });
        const chip = page.locator('[data-map-occluder].fm-glass', { hasText: 'maker 的 3 个地点' });

        await page.goto(`${base}/__user_places_ui`);
        await waitMarkers(['测试面馆', '牛肉面', '别人的店']);

        // 最近修改是修改人；没修改过的地点是创建者
        await clickMarker('测试面馆');
        await page.getByRole('button', { name: '查看 editor 创建的地点' }).waitFor();
        await page.getByText(/最近修改：editor · 2026-08-08/).waitFor();
        await clickMarker('牛肉面');
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: '查看 maker 创建的地点' }).click();

        // 列表：最近创建在前，别人看不到审核中的地点；地图只剩这位住民的地点（含原来视野外的）。
        // 替身地图没有 setBounds，视野调整退回到以第一个地点为中心，回到原处检查其余标记
        await list.waitFor();
        await list.getByText('共 3 个，最近创建的在前').waitFor();
        assert.deepEqual(await list.getByRole('listitem').locator('span:first-child').allTextContents(), ['远方小馆', '牛肉面', '测试面馆']);
        await waitMarkers(['远方小馆']);
        await page.evaluate(() => window.__TEST_MAPS.filter((m) => !m.destroyed).at(-1).setCenter([120, 30]));
        await waitMarkers(['测试面馆', '牛肉面']);
        await snap('list');

        // 选中列表里的地点：卡片打开、地图移过去
        await list.getByRole('listitem').filter({ hasText: '远方小馆' }).click();
        await page.getByText('远方小馆的描述').waitFor();
        assert.deepEqual(await page.evaluate(() => window.__TEST_MAPS.filter((m) => !m.destroyed).at(-1).center), [121, 31]);
        if (label === 'desktop') {
            // 宽屏：列表留在原处，卡片与筛选条同时可用
            await list.waitFor();
            await chip.waitFor();
            await snap('card');
        } else {
            // 窄屏：列表让位给卡片；关掉卡片后筛选条仍在，点它重新打开列表
            await list.waitFor({ state: 'hidden' });
            await snap('card');
            await page.locator('button[title="关闭"]').first().click();
            await page.getByText('远方小馆的描述').waitFor({ state: 'hidden' });
            await chip.waitFor();
            await snap('chip');
            await chip.getByRole('button', { name: /maker 的 3 个地点/ }).click();
            await list.waitFor();
            await page.keyboard.press('Escape');
            await list.waitFor({ state: 'hidden' });
            await chip.waitFor();
        }

        // 退出筛选：回到附近地点
        await chip.getByRole('button', { name: '显示全部地点' }).click();
        await chip.waitFor({ state: 'hidden' });
        await list.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.__TEST_MAPS.filter((m) => !m.destroyed).at(-1).setCenter([120, 30]));
        await waitMarkers(['测试面馆', '牛肉面', '别人的店']);

        // 没有公开地点的住民：空列表提示
        await clickMarker('测试面馆');
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: '查看 editor 创建的地点' }).click();
        await page.getByText('测试面馆的描述').waitFor({ state: 'hidden' });
        const empty = page.getByRole('dialog', { name: 'editor 创建的地点' });
        await empty.getByText('还没有公开的地点').waitFor();
        await snap('empty');
        await empty.getByRole('button', { name: '显示全部地点' }).click();
        await empty.waitFor({ state: 'hidden' });

        assert.deepEqual(errors, [], `${label}: no page errors`);
        await page.close();
    };

    await run({ width: 1280, height: 860, label: 'desktop' });
    await run({ width: 390, height: 844, label: 'mobile' });
    console.log('user places UI tests passed: modifier link, filtered markers and list, card from list, chip reopen/exit, empty user, desktop and mobile.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    try { await browser?.close(); } catch (_) { }
    try { await vite?.close(); } catch (_) { }
    if (server) { server.closeAllConnections(); server.close(); }
    try { db._raw.close(); } catch (_) { }
    fs.rmSync(temp, { recursive: true, force: true });
});
