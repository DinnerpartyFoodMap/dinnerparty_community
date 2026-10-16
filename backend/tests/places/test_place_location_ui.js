// Real React and API routes with an isolated database; only the AMap SDK is a test double.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-location-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
let browser, server, vite;

async function main() {
    init();
    const owner = randomUUID(), visitor = randomUUID(), admin = randomUUID();
    for (const [id, name, level] of [[owner, 'owner', null], [visitor, 'visitor', null], [admin, 'admin', 'YUYUKO']]) {
        sql.prepare('INSERT INTO User(id, username, password, admin_level) VALUES(?,?,?,?)').run(id, name, 'unused', level);
    }
    sql.prepare('INSERT INTO Place(id, name, category, description, longitude, latitude, creator_id) VALUES(1,?,?,?,?,?,?)')
        .run('测试面馆', '面食', '原来的描述', 120, 30, owner);
    const token = id => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    app.use('/users', require('../../modules/accounts/routes/users'));
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    app.use('/categories', require('../../modules/places/routes/categories'));
    app.use('/api/favorites', require('../../modules/preferences/routes/favorites'));
    app.use('/api/ratings', require('../../modules/ratings/routes/placeRatings'));
    app.use('/api/community', require('../../modules/community/routes/community'));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'warn' });
    const themeCss = (fs.readFileSync(path.join(frontend, 'index.html'), 'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g) || []).join('\n');
    app.get('/__place_location_ui', async (req, res) => {
        const id = req.query.user === 'visitor' ? visitor : owner;
        res.type('html').send(await vite.transformIndexHtml(req.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts/material-symbols.css"><style>${themeCss}body{margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token(id))}</script><script type="module" src="/tests/integration/place-location-harness.jsx"></script></body></html>`));
    });
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const form = page.getByRole('dialog', { name: /管理地点/ });
    const picker = page.getByRole('dialog', { name: '修改位置' });
    const coords = () => sql.prepare('SELECT longitude, latitude FROM Place WHERE id=1').get();
    const saved = { longitude: 120, latitude: 30 };
    const open = async (user = 'owner') => {
        await page.goto(`${base}/__place_location_ui?user=${user}`);
        await page.getByRole('button', { name: '测试面馆', exact: true }).click();
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: '编辑此地点' }).click();
        await form.waitFor();
    };
    const move = async (lng, lat) => {
        await page.evaluate(([x, y]) => window.__TEST_MAPS.filter(m => !m.destroyed).at(-1).setCenter([x, y]), [lng, lat]);
    };
    const checkForm = async (lng, lat, description) => {
        await picker.waitFor({ state: 'hidden' });
        await form.waitFor();
        assert.equal(await form.locator('textarea').inputValue(), description);
        await form.getByText(`${lng.toFixed(6)}, ${lat.toFixed(6)}`, { exact: true }).waitFor();
    };
    const snap = async name => {
        if (!process.env.PLACE_LOCATION_ARTIFACT_DIR) return;
        fs.mkdirSync(process.env.PLACE_LOCATION_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PLACE_LOCATION_ARTIFACT_DIR, `${name}.png`) });
    };

    await open();
    await form.locator('textarea').fill('选点前填写的描述');
    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await picker.waitFor();
    assert.deepEqual(await page.evaluate(() => window.__TEST_MAPS.at(-1).center), [120, 30], 'picker opens at the current position');
    await move(120.01, 30.01);
    await picker.getByRole('button', { name: '返回', exact: true }).click();
    await checkForm(120, 30, '选点前填写的描述');
    assert.deepEqual(coords(), saved, 'cancel does not write a location');

    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await move(120.012345, 30.023456);
    await picker.getByRole('button', { name: '选图钉位置' }).click();
    await checkForm(120.012345, 30.023456, '选点前填写的描述');
    await snap('edit-desktop');
    assert.deepEqual(coords(), saved, 'choosing a point only edits the form');
    // Reopening starts at the newly chosen point; Escape cancels only this picker.
    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await picker.waitFor();
    assert.deepEqual(await page.evaluate(() => window.__TEST_MAPS.at(-1).center), [120.012345, 30.023456]);
    await page.keyboard.press('Escape');
    await checkForm(120.012345, 30.023456, '选点前填写的描述');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    assert.deepEqual(coords(), { longitude: 120.012345, latitude: 30.023456 });
    assert.equal(sql.prepare('SELECT description FROM Place WHERE id=1').get().description, '选点前填写的描述');
    // The existing marker moves too, without leaving a ghost at the old position.
    await page.waitForFunction(() => [...window.__TEST_MAPS[0].markers].some(m =>
        m.options.content?.classList.contains('fm-marker') && Math.abs(m.position[0] - 120.012345) < 1e-6 && Math.abs(m.position[1] - 30.023456) < 1e-6));
    assert.equal(await page.evaluate(() => [...window.__TEST_MAPS[0].markers].filter(m => m.options.content?.classList.contains('fm-marker')).length), 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await open('visitor');
    await form.locator('textarea').fill('申请修改位置');
    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await move(120.02, 30.025);
    await snap('picker-mobile');
    await picker.getByRole('button', { name: '选图钉位置' }).click();
    await checkForm(120.02, 30.025, '申请修改位置');
    // Choosing an existing marker changes the position, while retaining this place's name and text.
    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await picker.getByRole('button', { name: '测试面馆', exact: true }).click();
    await page.waitForTimeout(400); // Existing marker-card ghost-click guard.
    // Narrow-screen place cards render in their own overlay portal.
    await page.getByRole('button', { name: '选择此地点', exact: true }).click();
    await checkForm(120.012345, 30.023456, '申请修改位置');
    await form.getByRole('button', { name: '修改位置', exact: true }).click();
    await move(120.02, 30.025);
    await picker.getByRole('button', { name: '选图钉位置' }).click();
    await checkForm(120.02, 30.025, '申请修改位置');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await snap('edit-mobile');
    await form.getByRole('button', { name: '提交申请', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    assert.deepEqual(coords(), { longitude: 120.012345, latitude: 30.023456 }, 'a pending proposal cannot move the public marker');
    const request = sql.prepare('SELECT * FROM PlaceRequest ORDER BY id DESC LIMIT 1').get();
    assert.equal(request.status, 'pending');
    assert.equal(JSON.parse(request.proposed).longitude, 120.02);
    assert.equal(JSON.parse(request.proposed).latitude, 30.025);
    const reviewRequest = (id, action) => fetch(`${base}/place-requests/${id}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(admin)}` }, body: JSON.stringify({ action })
    });
    const rejected = await reviewRequest(request.id, 'reject');
    assert.equal(rejected.status, 200, await rejected.text());
    assert.deepEqual(coords(), { longitude: 120.012345, latitude: 30.023456 }, 'rejecting a proposal leaves the public position unchanged');
    const resubmitted = await fetch(`${base}/place-requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(visitor)}` },
        body: JSON.stringify({ place_id: 1, proposed: JSON.parse(request.proposed) })
    });
    assert.equal(resubmitted.status, 201);
    const review = await reviewRequest((await resubmitted.json()).id, 'approve');
    assert.equal(review.status, 200, await review.text());
    assert.deepEqual(coords(), { longitude: 120.02, latitude: 30.025 });
    await open('visitor');
    await form.locator('textarea').fill('只修改描述');
    await form.getByRole('button', { name: '提交申请', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    const textOnly = JSON.parse(sql.prepare('SELECT proposed FROM PlaceRequest ORDER BY id DESC LIMIT 1').get().proposed);
    assert.equal(Object.hasOwn(textOnly, 'longitude'), false, 'text-only edits cannot propose stale coordinates');
    assert.equal(Object.hasOwn(textOnly, 'latitude'), false);
    assert.deepEqual(errors, []);
    console.log('Place location UI passed: cancel, draft preservation, point/marker selection, direct save, marker move, mobile layout, review approval/rejection and text-only edits.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    sql.close();
    const resolved = path.resolve(temp);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yuyuko-place-location-')) fs.rmSync(resolved, { recursive: true, force: true });
});
