const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-exhibition-ui-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(temp, 'uploads');
process.env.IMAGE_STORAGE = 'local';
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
let browser, server, vite;

async function main() {
    init();
    const id = randomUUID();
    db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, 'admin', 'unused', 'YUYUKO');
    const token = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    const auth = require('../../modules/accounts/middleware/auth').requireAuth;
    app.use('/admin/exhibitions', auth, require('../../modules/admin/routes/adminExhibitions'));
    app.use('/exhibitions', require('../../modules/community/routes/exhibitions'));
    app.use('/upload', auth, require('../../modules/media/routes/upload'));
    app.use('/uploads', express.static(process.env.UPLOADS_DIR));
    const frontend = path.resolve(__dirname, '../../../frontend');
    const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: frontend, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
    const theme = (fs.readFileSync(path.join(frontend, 'index.html'), 'utf8').match(/:root(?:\[data-theme='dark'\])?\s*\{[^}]*\}/g) || []).join('\n');
    app.get('/__exhibition_ui', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.url,
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}body{margin:0;font-family:system-ui}</style></head><body><div id="root"></div><script>window.__TEST_TOKEN=${JSON.stringify(token)}</script><script type="module" src="/tests/integration/exhibition-harness.jsx"></script></body></html>`)));
    app.use(vite.middlewares);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/__exhibition_ui`);
    await page.getByLabel('展会名称', { exact: true }).fill('秋日展会');
    await page.getByLabel('展会简介', { exact: true }).fill('简介第一行\n简介第二行');
    // 简介与信息都是支持 Markdown 的多行输入框
    assert.equal(await page.getByLabel('展会信息', { exact: true }).evaluate(el => el.tagName), 'TEXTAREA');
    await page.getByLabel('展会信息', { exact: true }).fill('**上海** · 周六 10:00\n- 现场购票');
    await page.getByRole('button', { name: '预览' }).nth(1).click();
    await page.getByRole('region', { name: 'Markdown 预览' }).locator('strong', { hasText: '上海' }).waitFor();
    await page.getByRole('button', { name: '编辑' }).click();
    await page.getByText(/^选填。设置后/).waitFor();
    await page.getByRole('button', { name: '发布展会', exact: true }).click();
    await page.getByText('当前展会：秋日展会', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    const entry = page.getByRole('button', { name: '查看展会：秋日展会' });
    await entry.waitFor();
    assert.ok((await entry.locator('img').getAttribute('src')).endsWith('/favicon.png'));
    const dimensions = await entry.locator('img').boundingBox();
    assert.equal(dimensions.width, 44);
    assert.equal(dimensions.height, 44);
    async function checkPosition(underNotice) {
        await page.waitForFunction(expected => {
            const button = document.querySelector('[data-exhibition-entry]');
            const notice = document.querySelector('.fm-notice');
            if (!button) return false;
            return expected ? button.getBoundingClientRect().top >= notice.getBoundingClientRect().bottom + 7
                : Math.abs(button.getBoundingClientRect().top - 30) < 1;
        }, underNotice);
    }
    async function checkDesktopEntry() {
        await page.waitForFunction(() => {
            const rect = document.querySelector('[data-exhibition-entry]')?.getBoundingClientRect();
            return rect && Math.abs(innerHeight - rect.bottom - 42) < 1 && Math.abs(innerWidth - rect.right - 12) < 1;
        });
    }
    await checkDesktopEntry();
    await entry.click();
    const desktopDetail = page.getByRole('dialog', { name: '秋日展会', exact: true });
    await desktopDetail.waitFor();
    await page.waitForFunction(() => {
        const rect = document.querySelector('[role="dialog"][aria-label="秋日展会"]')?.getBoundingClientRect();
        return rect && Math.abs(rect.width - 370) < 1 && Math.abs(rect.top - 68) < 1 && Math.abs(innerHeight - rect.bottom - 42) < 1;
    });
    await page.keyboard.press('Escape');
    await desktopDetail.waitFor({ state: 'hidden' });
    if (process.env.EXHIBITION_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.EXHIBITION_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EXHIBITION_ARTIFACT_DIR, 'exhibition-notice.png') });
    }
    await page.getByRole('button', { name: 'Resize notice' }).click();
    await checkDesktopEntry();
    await page.setViewportSize({ width: 1440, height: 900 });
    await checkDesktopEntry();
    await page.setViewportSize({ width: 390, height: 844 });
    await checkPosition(true);
    await page.locator('.fm-notice').getByRole('button', { name: '关闭' }).click();
    await checkPosition(false);
    await entry.click();
    const detail = page.getByRole('dialog', { name: '秋日展会', exact: true });
    await detail.waitFor();
    await page.waitForFunction(() => {
        const rect = document.querySelector('[role="dialog"][aria-label="秋日展会"]')?.getBoundingClientRect();
        return rect && Math.abs(rect.top) < 1 && Math.abs(rect.left) < 1 && Math.abs(rect.width - innerWidth) < 1 && Math.abs(rect.height - innerHeight) < 1;
    });
    assert.match(await detail.innerText(), /简介第一行\s+简介第二行/);
    assert.equal(await detail.locator('.fm-markdown strong').innerText(), '上海');
    assert.equal(await detail.locator('.fm-markdown li').innerText(), '现场购票');
    if (process.env.EXHIBITION_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.EXHIBITION_ARTIFACT_DIR, { recursive: true });
        // Wait only for the optional visual artifact, after the interaction assertions above.
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(process.env.EXHIBITION_ARTIFACT_DIR, 'exhibition-mobile.png') });
    }
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByText('当前展会：秋日展会', { exact: true }).waitFor();
    await page.getByLabel('添加图标', { exact: true }).setInputFiles(path.join(frontend, 'public/favicon.png'));
    await page.getByRole('button', { name: '移除图标' }).waitFor();
    const publicationResponse = page.waitForResponse(response => response.url().endsWith('/admin/exhibitions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '发布展会', exact: true }).click();
    assert.ok((await publicationResponse).ok());
    await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled === false);
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await entry.waitFor();
    const uploadedUrl = await entry.locator('img').getAttribute('src');
    assert.ok(uploadedUrl.includes('/uploads/'));
    await page.waitForFunction(() => document.querySelector('[data-exhibition-entry] img')?.naturalWidth > 0);
    // A published icon that disappears from storage still leaves a usable entry.
    await page.route('**/uploads/**', route => route.abort());
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByText('当前展会：秋日展会', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.waitForFunction(() => document.querySelector('[data-exhibition-entry] img')?.getAttribute('src') === '/favicon.png');
    await page.unroute('**/uploads/**');
    // 展会地点：面板显示场馆，“展会附近随机美食”以展会地点为中心
    assert.equal(await page.getByRole('button', { name: '展会附近随机美食' }).count(), 0);
    await page.evaluate(async () => {
        const res = await fetch('/admin/exhibitions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.__TEST_TOKEN}` },
            body: JSON.stringify({ name: '带地点的展会', description: '简介', information: '信息', location_name: '保利世贸博览馆', latitude: 23.0961, longitude: 113.3653 }) });
        if (!res.ok) throw new Error(`publish failed: ${res.status}`);
        window.dispatchEvent(new Event('exhibition-updated'));
    });
    await page.getByRole('button', { name: '查看展会：带地点的展会' }).click();
    const venuePanel = page.getByRole('dialog', { name: '带地点的展会', exact: true });
    await venuePanel.getByText('保利世贸博览馆', { exact: true }).waitFor();
    // 地址可点：收起面板，地图移到展会地点
    await venuePanel.getByRole('button', { name: '在地图上查看展会地点：保利世贸博览馆' }).click();
    await venuePanel.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('地图位置').innerText(), '保利世贸博览馆 23.0961,113.3653');
    await page.getByRole('button', { name: '查看展会：带地点的展会' }).click();
    await venuePanel.getByRole('button', { name: '展会附近随机美食' }).click();
    await venuePanel.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('随机中心').innerText(), '带地点的展会 23.0961,113.3653');
    // 长展会名：入口与面板标题单行来回滚动，读屏名称仍是完整展会名
    const longName = '第二十届东方Project同人展·秋季特别场（上海国际会议中心）';
    await page.evaluate(async (name) => {
        const res = await fetch('/admin/exhibitions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.__TEST_TOKEN}` },
            body: JSON.stringify({ name, description: '简介', information: '信息', location_name: '保利世贸博览馆', latitude: 23.0961, longitude: 113.3653 }) });
        if (!res.ok) throw new Error(`publish failed: ${res.status}`);
        window.dispatchEvent(new Event('exhibition-updated'));
    }, longName);
    const longEntry = page.getByRole('button', { name: `查看展会：${longName}` });
    await longEntry.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-exhibition-entry] .fm-marquee[data-overflow]'));
    await longEntry.click();
    const longPanel = page.getByRole('dialog', { name: longName, exact: true });
    await longPanel.waitFor();
    await page.waitForFunction((name) => {
        const title = document.querySelector(`[role="dialog"][aria-label="${name}"] h2 .fm-marquee`);
        return title?.hasAttribute('data-overflow') && getComputedStyle(title.firstElementChild).animationName === 'fm-marquee'
            && title.getBoundingClientRect().height < 40;
    }, longName);
    if (process.env.EXHIBITION_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.EXHIBITION_ARTIFACT_DIR, 'exhibition-long-title.png') });
    await page.keyboard.press('Escape');
    await longPanel.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByText(`当前展会：${longName}`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('展会地点', { exact: true }).inputValue(), '保利世贸博览馆');
    await page.getByText('已选坐标：23.096100, 113.365300', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除地点' }).click();
    await page.getByText(/^选填。设置后/).waitFor();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByRole('button', { name: '下架展会', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.getByText('当前没有已发布的展会', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await entry.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('Exhibition browser flow passed: publish, favicon, upload, details, responsive notice collision, resize, dismiss, venue link, venue random, long title, markdown, unpublish.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
