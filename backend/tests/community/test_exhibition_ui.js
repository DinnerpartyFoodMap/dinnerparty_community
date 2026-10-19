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
    await page.getByLabel('展会信息', { exact: true }).fill('上海 · 周六 10:00');
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
    await detail.getByText('上海 · 周六 10:00', { exact: true }).waitFor();
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
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByRole('button', { name: '下架展会', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.getByText('当前没有已发布的展会', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await entry.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('Exhibition browser flow passed: publish, favicon, upload, details, responsive notice collision, resize, dismiss, unpublish.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
