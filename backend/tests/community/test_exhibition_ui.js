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
    // Keep motion on requestAnimationFrame so the interval clock also controls animation time.
    await page.addInitScript(() => { Element.prototype.animate = undefined; });
    await page.clock.install();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/__exhibition_ui`, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.getByLabel('展会名称', { exact: true }).fill('秋日展会');
    await page.getByLabel('活动时间', { exact: true }).fill('2026-11-01T10:00');
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
    const publicationResponse = page.waitForResponse(response => response.url().includes('/admin/exhibitions/') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    assert.ok((await publicationResponse).ok());
    await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled === false);
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await entry.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-exhibition-entry] img')?.getAttribute('src')?.includes('/uploads/'));
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
        const current = (await (await fetch('/exhibitions/current')).json()).exhibition;
        const res = await fetch(`/admin/exhibitions/${current.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.__TEST_TOKEN}` },
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
        const current = (await (await fetch('/exhibitions/current')).json()).exhibition;
        const res = await fetch(`/admin/exhibitions/${current.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.__TEST_TOKEN}` },
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
    await page.locator('[data-exhibition-entry]').waitFor({ state: 'hidden' });
    // Create independent activities through the real editor, in deliberately unsorted order.
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    async function addActivity(name, time) {
        await page.getByRole('button', { name: '新增活动', exact: true }).click();
        await page.getByLabel('展会名称', { exact: true }).fill(name);
        await page.getByLabel('活动时间', { exact: true }).fill(time);
        await page.getByLabel('展会简介', { exact: true }).fill(`${name}简介`);
        await page.getByLabel('展会信息', { exact: true }).fill(`${name}信息`);
        await page.getByRole('button', { name: '发布展会', exact: true }).click();
        await page.getByText(`当前展会：${name}`, { exact: true }).waitFor();
    }
    await addActivity('晚场', '2026-12-01T10:00');
    await addActivity('早场', '2026-10-01T10:00');
    await addActivity('中场', '2026-11-01T10:00');
    await page.getByLabel('选择活动', { exact: true }).selectOption({ label: '晚场' });
    assert.equal(await page.getByLabel('活动时间', { exact: true }).inputValue(), '2026-12-01T10:00');
    await page.getByLabel('展会名称', { exact: true }).fill('晚场修改');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByText('当前展会：晚场修改', { exact: true }).waitFor();
    await page.evaluate(() => { Math.random = () => 0.5; });
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    const stack = page.locator('[data-exhibition-entry]');
    await page.getByRole('button', { name: '有 3 个活动' }).waitFor();
    assert.match(await stack.innerText(), /中场/, 'random initial index starts in the middle');
    const deckCards = stack.locator('[data-exhibition-card]');
    assert.equal(await deckCards.count(), 3, 'each activity keeps its own card in the interleaved deck');
    const compactDeck = await stack.locator('.fm-exhibition-deck').boundingBox();
    assert.equal(compactDeck.width, 48);
    assert.equal(compactDeck.height, 48);
    const tilted = await deckCards.evaluateAll(cards => cards.filter(card => {
        const matrix = new DOMMatrix(getComputedStyle(card).transform);
        return Math.abs(matrix.b) > 0.02;
    }).length);
    assert.ok(tilted >= 2, 'back cards alternate their tilt instead of lining up');
    const outgoing = stack.locator('[data-exhibition-card][data-depth="0"]');
    const outgoingId = await outgoing.getAttribute('data-exhibition-card');
    const beforeShuffle = await outgoing.boundingBox();
    await page.evaluate(() => { Math.random = () => 0; }); // Refresh must not choose a new random start.
    await page.clock.runFor(9999);
    assert.match(await stack.innerText(), /中场/);
    await page.clock.runFor(1);
    assert.match(await stack.innerText(), /晚场修改/);
    await page.clock.runFor(300);
    const shuffling = stack.locator(`[data-exhibition-card="${outgoingId}"]`);
    assert.ok((await shuffling.boundingBox()).x < beforeShuffle.x - 15, 'top card travels out before sliding behind the deck');
    await page.clock.runFor(500);
    assert.equal(await shuffling.getAttribute('data-depth'), '2', 'outgoing card becomes the last card');
    await stack.click();
    const choices = page.getByRole('region', { name: '全部活动' });
    await choices.waitFor();
    await page.clock.runFor(900);
    const backdrop = page.locator('[data-exhibition-backdrop]');
    await backdrop.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'expanded activities are not in a popup panel');
    assert.equal(await choices.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const spreadBounds = await choices.locator('button').evaluateAll(items => items.map(item => {
        const rect = item.getBoundingClientRect(); return { x: rect.x, top: rect.top, bottom: rect.bottom };
    }));
    assert.ok(spreadBounds.every((rect, index) => index === 0 || (Math.abs(rect.x - spreadBounds[0].x) < 1 && rect.top > spreadBounds[index - 1].bottom)), 'activities fan down into a single column');
    const compactSpread = await choices.locator('button').first().evaluate(item => {
        const art = item.querySelector('.fm-exhibition-spread__art').getBoundingClientRect();
        const caption = item.querySelector('.fm-exhibition-spread__caption').getBoundingClientRect();
        return { width: art.width, height: art.height, artLeft: art.left, captionRight: caption.right };
    });
    assert.ok(Math.abs(compactSpread.width - compactDeck.width * 1.1) < 0.5, 'expanded icons grow by only ten percent');
    assert.ok(Math.abs(compactSpread.width - compactSpread.height) < 0.1, 'expanded icons remain square');
    assert.ok(compactSpread.captionRight < compactSpread.artLeft, 'title and time sit to the left of the icon');
    assert.deepEqual(await choices.locator('button').allTextContents(), ['早场2026-10-01 10:00', '中场2026-11-01 10:00', '晚场修改2026-12-01 10:00']);
    if (process.env.EXHIBITION_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.EXHIBITION_ARTIFACT_DIR, 'exhibition-stack-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    if (process.env.EXHIBITION_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.EXHIBITION_ARTIFACT_DIR, 'exhibition-stack-desktop.png') });
    const gatheringId = await stack.locator('[data-depth="0"]').getAttribute('data-exhibition-card');
    await choices.getByRole('button', { name: '查看展会：中场', exact: true }).click();
    await page.clock.runFor(450);
    const gatheringTop = await page.locator(`[data-exhibition-choice="${gatheringId}"]`).evaluate(el => el.getBoundingClientRect().top);
    const destinationTop = await stack.locator('.fm-exhibition-deck').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(gatheringTop - destinationTop) < 8, 'after resizing, cards gather into the current deck position');
    await page.clock.runFor(550);
    const middlePanel = page.getByRole('dialog', { name: '中场', exact: true });
    await middlePanel.waitFor();
    await page.clock.runFor(10000);
    assert.match(await stack.innerText(), /早场/, 'wraps chronologically');
    await middlePanel.waitFor(); // Rotating entry must not replace an open detail panel.
    await page.clock.runFor(10000); // Includes the 30-second refresh.
    assert.match(await stack.innerText(), /中场/);
    await page.clock.resume();
    await page.keyboard.press('Escape');
    await middlePanel.waitFor({ state: 'hidden' });
    assert.equal(await stack.evaluate(el => el === document.activeElement), true, 'details restore focus to the persistent stack');
    await stack.click();
    await choices.waitFor();
    await backdrop.click({ position: { x: 10, y: 250 } });
    assert.ok(await choices.count(), 'cards remain mounted during the gathering animation');
    await choices.waitFor({ state: 'hidden' });
    assert.equal(await stack.evaluate(el => el === document.activeElement), true);
    await stack.click();
    await choices.waitFor();
    await page.keyboard.press('Escape');
    await choices.waitFor({ state: 'hidden' });
    await stack.click();
    const consumed = await page.evaluate(async () => (await import('/src/platform/backButton.js')).dispatchBack());
    assert.equal(consumed, true, 'the expanded list participates in app back handling');
    await choices.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByLabel('选择活动', { exact: true }).selectOption({ label: '中场' });
    await page.getByRole('button', { name: '下架展会', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#exhibition-select')?.options.length === 3);
    await page.getByRole('button', { name: 'Toggle admin' }).click();
    await page.getByRole('button', { name: '有 2 个活动' }).waitFor();
    await stack.click();
    assert.equal(await choices.locator('button').count(), 2);
    assert.deepEqual(errors, []);
    console.log('Exhibition browser flow passed: multi-activity create/edit/unpublish, datetime, stack expansion, random start, 10-second chronological rotation, polling continuity, stable details, focus/back handling, responsive layout, icons, markdown and venue actions.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (vite) await vite.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
