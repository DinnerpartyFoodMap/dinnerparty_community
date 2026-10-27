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
        await page.getByText('最近200条管理员操作日志', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        if (level === 'YUYUKO') {
            // 用户管理: QQ rebinding on the regular resident's row.
            const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'regular', exact: true }) });
            await row.getByRole('button').click();
            await page.getByRole('menuitem', { name: '修改 QQ 号…', exact: true }).click();
            const qqDialog = page.getByRole('dialog', { name: '修改 QQ 号 · regular', exact: true });
            await qqDialog.getByLabel('QQ 号').fill('12ab');
            assert.equal(await qqDialog.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
            await qqDialog.getByLabel('QQ 号').fill('10001');
            await qqDialog.getByRole('button', { name: '保存', exact: true }).click();
            await qqDialog.waitFor({ state: 'hidden' });
            await row.getByRole('cell', { name: '10001', exact: true }).waitFor();
            assert.equal(db._raw.prepare('SELECT qq FROM User WHERE id = ?').get(users.regular.user.id).qq, '10001');
            continue;
        }
        await page.getByRole('cell', { name: 'regular', exact: true }).waitFor();
        await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'regular', exact: true }) }).getByRole('button').click();
        if (level === 'KOMACHI') {
            assert.equal(await page.getByRole('menuitem', { name: '封禁账号', exact: true }).count(), 0);
            await page.getByRole('menuitem', { name: '永久删除用户…', exact: true }).waitFor();
            continue;
        }
        await page.getByRole('menuitem', { name: '封禁账号', exact: true }).click();
        await page.getByRole('dialog', { name: '封禁用户 regular', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(users.regular.user.id).is_banned, 0);
        await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'regular', exact: true }) }).getByRole('button').click();
        await page.getByRole('menuitem', { name: '封禁账号', exact: true }).click();
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
    // 新增地点复核（AI 初筛拦下的地点，见 places/doc/placeModeration.md）：原因、地点内容、被标出的图片，通过后公开
    const hidden = Number(db._raw.prepare(`INSERT INTO Place (name, description, category, latitude, longitude, creator_id, moderation_status, menu_images)
        VALUES ('复核测试影城', '看电影的地方', '其他', 23.1, 113.3, ?, 'pending', '["/uploads/qr.jpg"]')`).run(users.regular.user.id).lastInsertRowid);
    const report = { decision: { flagged: true, reasons: ['unrelated', 'image'] }, vision: { status: 'ok', flagged_urls: ['/uploads/qr.jpg'] } };
    db._raw.prepare(`INSERT INTO PlaceRequest (place_id, requester_id, proposed, note, status, request_type, moderation)
        VALUES (?, ?, '{}', '电影院与美食和东方无关；图片：第 1 张有个人二维码', 'pending', 'create', ?)`).run(hidden, users.regular.user.id, JSON.stringify(report));
    // 创建者改出不合规内容时，修改被转成带 AI 原因的修改申请
    const editedPlace = Number(db._raw.prepare(`INSERT INTO Place (name, description, latitude, longitude, creator_id)
        VALUES ('原来的面馆', '牛肉面', 23.2, 113.2, ?)`).run(users.regular.user.id).lastInsertRowid);
    db._raw.prepare(`INSERT INTO PlaceRequest (place_id, requester_id, proposed, note, status, request_type, moderation)
        VALUES (?, ?, '{"description":"加微信领券"}', '创建者的修改未通过 AI 初筛：描述含广告引流', 'pending', 'modify', ?)`)
        .run(editedPlace, users.regular.user.id, JSON.stringify({ decision: { flagged: true, reasons: ['harmful'] } }));
    await page.goto(`http://127.0.0.1:${server.address().port}/__admin_ui?level=YOUMU`);
    const heldEdit = page.locator('tr').filter({ hasText: '加微信领券' }).first();
    await heldEdit.getByText('文字含不良信息', { exact: true }).waitFor();
    await heldEdit.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '驳回申请', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await heldEdit.waitFor({ state: 'detached' });
    assert.equal(db._raw.prepare('SELECT description FROM Place WHERE id = ?').get(editedPlace).description, '牛肉面');
    const review = page.locator('tr').filter({ hasText: '复核测试影城' }).first();
    for (const text of ['新增复核', '与美食和东方无关', '图片含不良信息', '电影院与美食和东方无关；图片：第 1 张有个人二维码']) {
        await review.getByText(text, { exact: true }).waitFor();
    }
    assert.equal(await review.locator('img[alt="菜单图"]').count(), 1);
    if (process.env.ADMIN_UI_SCREENSHOT) await review.screenshot({ path: process.env.ADMIN_UI_SCREENSHOT });
    await review.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '通过，公开地点…', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.getByText('当前没有匹配的待处理申请。', { exact: true }).waitFor();
    assert.equal(db._raw.prepare('SELECT moderation_status FROM Place WHERE id = ?').get(hidden).moderation_status, 'visible');
    assert.deepEqual(errors, []);
    console.log('Admin browser permissions passed: role panels, audit, skin restrictions, YOUMU ban/unban on desktop/mobile, cancel, server rejection/retry, KOMACHI without ban controls, YUYUKO QQ rebinding.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
