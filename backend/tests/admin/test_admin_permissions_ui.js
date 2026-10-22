const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-admin-ui-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
let browser, server, vite;

async function main() {
    init();
    const users = {};
    for (const level of ['YUYUKO', 'YOUMU', 'KOMACHI', 'regular']) {
        const user = { id: randomUUID(), username: level, admin_level: level === 'regular' ? null : level };
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)')
            .run(user.id, user.username, 'unused', user.admin_level);
        users[level] = { user, token: jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'yuyuko_secret_key') };
    }
    const app = express();
    app.use(express.json());
    const auth = require('../../modules/accounts/middleware/auth').requireAuth;
    for (const [url, file] of [['users', 'adminUsers'], ['general-users', 'adminGeneralUsers'],
        ['audit', 'adminAudit'], ['skin-codes', 'adminSkinCodes'], ['qq-whitelist', 'adminQQWhitelist'],
        ['notices', 'adminNotices'], ['exhibitions', 'adminExhibitions']]) {
        app.use(`/admin/${url}`, auth, require(`../../modules/admin/routes/${file}`));
    }
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
    app.get('/__admin_ui', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.url,
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100vh"></div><script>window.__TEST_AUTH=${JSON.stringify(users[req.query.level] || users.regular)}</script><script type="module" src="/tests/integration/admin-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const level of ['YOUMU', 'KOMACHI', 'YUYUKO', 'regular']) {
        await page.goto(`http://127.0.0.1:${server.address().port}/__admin_ui?level=${level}`);
        await page.getByRole('heading', { name: '管理员后台', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: '皮肤兑换码', exact: true }).count(), level === 'YUYUKO' ? 1 : 0);
        assert.equal(await page.getByRole('heading', { name: '地点修改申请', exact: true }).count(), level === 'regular' ? 0 : 1);
        assert.equal(await page.getByRole('heading', { name: '公告发布', exact: true }).count(), ['YUYUKO', 'YOUMU'].includes(level) ? 1 : 0);
        assert.equal(await page.getByRole('heading', { name: '评论管理', exact: true }).count(), 0);
        if (level === 'regular') {
            assert.equal(await page.getByRole('button', { name: '查看操作日志', exact: true }).count(), 0);
            continue;
        }
        await page.getByRole('button', { name: '查看操作日志', exact: true }).click();
        await page.getByText('管理员操作日志（最近 200 条）', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        if (level === 'YUYUKO') continue;
        await page.getByRole('cell', { name: 'regular', exact: true }).waitFor();
        await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'regular', exact: true }) }).getByRole('button').click();
        if (level === 'KOMACHI') {
            assert.equal(await page.getByRole('menuitem', { name: '封禁账号…', exact: true }).count(), 0);
            await page.getByRole('menuitem', { name: '永久删除用户…', exact: true }).waitFor();
            continue;
        }
        await page.getByRole('menuitem', { name: '封禁账号…', exact: true }).click();
        await page.getByRole('dialog', { name: '封禁用户 regular', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(users.regular.user.id).is_banned, 0);
        await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'regular', exact: true }) }).getByRole('button').click();
        await page.getByRole('menuitem', { name: '封禁账号…', exact: true }).click();
        // An account promoted since the list loaded must be rejected by the server.
        db._raw.prepare('UPDATE User SET admin_level = ? WHERE id = ?').run('KOMACHI', users.regular.user.id);
        await page.getByRole('button', { name: '确认封禁', exact: true }).click();
        await page.getByText('只能封禁或解封普通用户', { exact: true }).waitFor();
        assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(users.regular.user.id).is_banned, 0);
        db._raw.prepare('UPDATE User SET admin_level = NULL WHERE id = ?').run(users.regular.user.id);
        let releaseBan, banStarted;
        const heldBan = new Promise(resolve => { releaseBan = resolve; });
        const started = new Promise(resolve => { banStarted = resolve; });
        await page.route('**/admin/users/ban', async route => {
            banStarted();
            await heldBan;
            await route.continue();
        }, { times: 1 });
        try {
            await page.getByRole('button', { name: '确认封禁', exact: true }).click();
            await started;
            await page.keyboard.press('Escape');
            await page.getByRole('dialog', { name: '封禁用户 regular', exact: true }).waitFor({ state: 'hidden' });
            const panel = page.getByRole('heading', { name: '普通用户管理', exact: true }).locator('..');
            assert.equal(await panel.getByRole('button', { name: '刷新', exact: true }).isDisabled(), true,
                'refresh cannot discard an in-flight mutation result');
            for (const button of await panel.locator('button[aria-haspopup="menu"]').all()) {
                assert.equal(await button.isDisabled(), true, 'other targets cannot start an overlapping mutation');
            }
        } finally { releaseBan(); }
        await page.getByText('已封禁', { exact: true }).waitFor();
        assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(users.regular.user.id).is_banned, 1);
        // Narrow layout must expose the same unban operation and retain state after reload.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await page.getByText('已封禁', { exact: true }).waitFor();
        await page.locator('article').filter({ has: page.getByText('regular', { exact: true }) }).getByRole('button').click();
        await page.getByRole('menuitem', { name: '解除封禁', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
        await page.getByText('正常', { exact: true }).waitFor();
        assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(users.regular.user.id).is_banned, 0);
        await page.setViewportSize({ width: 1100, height: 900 });
    }
    assert.deepEqual(errors, []);
    console.log('Admin browser permissions passed: role panels, audit, skin restrictions, YOUMU ban/unban on desktop/mobile, cancel, server rejection/retry and KOMACHI without ban controls.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
