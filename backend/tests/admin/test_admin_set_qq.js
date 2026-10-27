const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// 管理后台“用户管理”改绑 QQ 号（POST /admin/users/set-qq）：仅 YUYUKO，格式校验、一个 QQ 只绑一个账号、留空解绑、审计。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-admin-qq-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const { db, init } = require('../../infrastructure/database');
const { requireAuth } = require('../../modules/accounts/middleware/auth');
let server;

async function main() {
    init();
    const ids = {}, tokens = {};
    for (const [name, level] of [['YUYUKO', 'YUYUKO'], ['YOUMU', 'YOUMU'], ['first', null], ['second', null]]) {
        ids[name] = randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(ids[name], name, 'unused', level);
        tokens[name] = jwt.sign({ id: ids[name] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const app = express();
    app.use(express.json());
    app.use('/admin/users', requireAuth, require('../../modules/admin/routes/adminUsers'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const setQq = async (body, who) => {
        const response = await fetch(`${base}/admin/users/set-qq`, { method: 'POST', headers: {
            'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {})
        }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    const qqOf = id => db._raw.prepare('SELECT qq FROM User WHERE id = ?').get(id).qq;
    const audit = () => db._raw.prepare("SELECT details FROM AdminAudit WHERE action = 'set-qq' ORDER BY id").all().map(row => JSON.parse(row.details));

    db._raw.prepare('UPDATE User SET qq = ? WHERE id = ?').run('123456', ids.first);
    assert.equal((await setQq({ userId: ids.second, qq: '654321' })).status, 401);
    for (const who of ['YOUMU', 'first']) assert.equal((await setQq({ userId: ids.second, qq: '654321' }, who)).status, 403, who);
    assert.equal((await setQq({ userId: ids.second, qq: '12ab' }, 'YUYUKO')).status, 400);
    assert.equal((await setQq({ userId: ids.second, qq: '1234' }, 'YUYUKO')).status, 400, 'too short');
    assert.equal((await setQq({ userId: ids.second }, 'YUYUKO')).status, 400);
    assert.equal((await setQq({ userId: randomUUID(), qq: '654321' }, 'YUYUKO')).status, 404);
    const taken = await setQq({ userId: ids.second, qq: '123456' }, 'YUYUKO');
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'QQ_IN_USE');
    assert.equal(qqOf(ids.second), null);

    assert.equal((await setQq({ userId: ids.second, qq: ' 654321 ' }, 'YUYUKO')).body.qq, '654321');
    assert.equal(qqOf(ids.second), '654321');
    assert.equal((await setQq({ userId: ids.second, qq: '654321' }, 'YUYUKO')).status, 200, 'unchanged is fine');
    assert.equal((await setQq({ userId: ids.first, qq: '' }, 'YUYUKO')).body.qq, null);
    assert.equal(qqOf(ids.first), null);
    // The unbound number is free again.
    assert.equal((await setQq({ userId: ids.YOUMU, qq: '123456' }, 'YUYUKO')).status, 200);
    assert.deepEqual(audit(), [{ from: null, to: '654321' }, { from: '123456', to: null }, { from: null, to: '123456' }]);

    console.log('Admin QQ rebinding passed: YUYUKO only, format, one account per QQ, unbind, unchanged without audit.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
