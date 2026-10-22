const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-feedback-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const { LIMITS } = require('../../modules/feedback/services/feedbackService');
let server;

async function main() {
    init();
    init(); // 重复初始化不丢数据
    const users = {}, tokens = {};
    for (const level of ['YUYUKO', 'YOUMU', 'KOMACHI', 'regular', 'other']) {
        const id = randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level, qq) VALUES (?, ?, ?, ?, ?)')
            .run(id, level, 'unused', ['regular', 'other'].includes(level) ? null : level, level === 'regular' ? '10001' : null);
        users[level] = id;
        tokens[level] = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const { requireAuth } = require('../../modules/accounts/middleware/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/feedback', require('../../modules/feedback/routes/feedback'));
    app.use('/admin/feedback', requireAuth, require('../../modules/admin/routes/adminFeedback'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = level => (level ? { Authorization: `Bearer ${tokens[level]}` } : {});
    async function submit(fields, images = [], level = 'regular') {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        images.forEach((image, index) => form.append('images', new Blob([image.buffer], { type: image.type }), `shot-${index}.${image.ext}`));
        const res = await fetch(`${base}/api/feedback`, { method: 'POST', headers: auth(level), body: form });
        return { status: res.status, body: await res.json() };
    }
    async function json(url, method = 'GET', body, level = 'YUYUKO') {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...auth(level) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json().catch(() => null) };
    }

    // 带方向标记的横图 JPEG：入库后摆正、去元数据、转 WebP
    const tall = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#e2789f' } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#00000000' } }).png().toBuffer();
    const jpeg = { buffer: tall, type: 'image/jpeg', ext: 'jpg' };
    const small = { buffer: png, type: 'image/png', ext: 'png' };

    assert.equal((await submit({ type: 'bug', content: '游客' }, [], null)).status, 401);
    for (const bad of [{ content: '缺类型' }, { type: 'spam', content: '类型不对' }, { type: 'place', content: '旧类型已改为 report' }, { type: 'bug', content: '   ' },
        { type: 'bug', content: 'x'.repeat(LIMITS.contentLength + 1) }]) {
        assert.equal((await submit(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await submit({ type: 'bug', content: '太多图' }, Array(LIMITS.images + 1).fill(small))).status, 400);
    assert.equal((await submit({ type: 'bug', content: '不是图片' }, [{ buffer: Buffer.from('hello'), type: 'text/plain', ext: 'txt' }])).status, 400);
    assert.equal((await submit({ type: 'bug', content: '坏图片' }, [{ buffer: Buffer.from('not an image'), type: 'image/png', ext: 'png' }])).status, 400);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserFeedback').get().n, 0, '失败的提交不留记录');

    const created = await submit({ type: 'bug', content: '  搜索结果点不开\n第二行  ', platform: 'ios', app_version: '2.2.3' }, [jpeg, small]);
    assert.equal(created.status, 201);
    const row = db._raw.prepare('SELECT * FROM UserFeedback WHERE id = ?').get(created.body.id);
    assert.deepEqual([row.type, row.content, row.platform, row.app_version, row.status, row.user_id], ['bug', '搜索结果点不开\n第二行', 'ios', '2.2.3', 'open', users.regular]);
    assert.equal((await submit({ type: 'suggestion', content: '未知平台', platform: 'symbian' }, [], 'other')).status, 201);
    assert.equal(db._raw.prepare("SELECT platform FROM UserFeedback WHERE content = '未知平台'").get().platform, 'web');

    // 管理端：KOMACHI 起都能看；普通住民不能
    assert.equal((await json('/admin/feedback', 'GET', null, 'regular')).status, 403);
    assert.equal((await json('/admin/feedback', 'GET', null, null)).status, 401);
    const list = (await json('/admin/feedback?status=open', 'GET', null, 'KOMACHI')).body;
    assert.equal(list.total, 2);
    assert.deepEqual(list.counts, { open: 2, resolved: 0 });
    const item = list.items.find(entry => entry.id === created.body.id);
    assert.equal(item.username, 'regular');
    assert.equal(item.qq, '10001');
    assert.equal(item.images.length, 2);
    assert.deepEqual([item.images[0].width, item.images[0].height], [819, 2048], '按方向摆正后缩到 2048 内');
    assert.equal((await json('/admin/feedback?type=suggestion&status=all', 'GET', null, 'YOUMU')).body.total, 1);

    const image = await fetch(`${base}/admin/feedback/images/${item.images[0].id}`, { headers: auth('YOUMU') });
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /webp/);
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined, '去掉元数据');
    assert.equal((await fetch(`${base}/admin/feedback/images/${item.images[0].id}`, { headers: auth('regular') })).status, 403);
    assert.equal((await fetch(`${base}/admin/feedback/images/missing`, { headers: auth('YUYUKO') })).status, 404);

    assert.equal((await json(`/admin/feedback/${item.id}/status`, 'PUT', { status: 'done' })).status, 400);
    assert.equal((await json('/admin/feedback/99999/status', 'PUT', { status: 'resolved' })).status, 404);
    assert.equal((await json(`/admin/feedback/${item.id}/status`, 'PUT', { status: 'resolved' }, 'KOMACHI')).status, 200);
    const resolved = (await json('/admin/feedback?status=resolved')).body.items[0];
    assert.equal(resolved.handler_username, 'KOMACHI');
    assert.ok(resolved.handled_time);
    assert.equal((await json(`/admin/feedback/${item.id}/status`, 'PUT', { status: 'open' })).status, 200);
    assert.equal((await json('/admin/feedback?status=open')).body.items.find(entry => entry.id === item.id).handled_time, null);
    assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM AdminAudit WHERE action IN ('resolve-feedback', 'reopen-feedback')").get().n, 2);

    // 审计写入失败时状态不变
    db._raw.exec("CREATE TRIGGER fail_feedback_audit BEFORE INSERT ON AdminAudit BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await json(`/admin/feedback/${item.id}/status`, 'PUT', { status: 'resolved' })).status, 500);
    assert.equal((await json(`/admin/feedback/${item.id}`, 'DELETE')).status, 500);
    assert.equal(db._raw.prepare('SELECT status FROM UserFeedback WHERE id = ?').get(item.id).status, 'open');
    db._raw.exec('DROP TRIGGER fail_feedback_audit');

    assert.equal((await json(`/admin/feedback/${item.id}`, 'DELETE', null, 'YOUMU')).status, 200);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserFeedbackImage WHERE feedback_id = ?').get(item.id).n, 0, '图片随反馈删除');
    assert.equal((await json(`/admin/feedback/${item.id}`, 'DELETE')).status, 404);

    // 24 小时内的条数上限（已删除的反馈不再计入）
    for (let i = db._raw.prepare('SELECT COUNT(*) AS n FROM UserFeedback WHERE user_id = ?').get(users.regular).n; i < LIMITS.perDay; i += 1) {
        assert.equal((await submit({ type: 'other', content: `第 ${i} 条` })).status, 201);
    }
    assert.equal((await submit({ type: 'other', content: '超出' })).status, 429);
    db._raw.prepare("UPDATE UserFeedback SET created_time = datetime('now', '-2 day') WHERE user_id = ?").run(users.regular);
    assert.equal((await submit({ type: 'other', content: '隔天再来' }, [small])).status, 201);

    // 账号删除时反馈与截图一并删除
    db._raw.prepare('DELETE FROM User WHERE id = ?').run(users.regular);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserFeedback WHERE user_id = ?').get(users.regular).n, 0);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserFeedbackImage i LEFT JOIN UserFeedback f ON f.id = i.feedback_id WHERE f.id IS NULL').get().n, 0);
    console.log('Feedback tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    server?.close();
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
