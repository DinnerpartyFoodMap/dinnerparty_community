'use strict';

// 多设备会话集成测试：真实 users 路由 + 临时 SQLite；会话存储使用内存实现，无需 Redis 服务。
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-sessions-'));
process.env.DB_FILE = path.join(tempDirectory, 'sessions.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';

const { db, init } = require('../../infrastructure/database');
const { setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
const { createSessionStore, keys } = require('../../modules/accounts/services/sessions');
const { FakeRedis } = require('../helpers/fakeRedis');
const usersRouter = require('../../modules/accounts/routes/users');
const { requestLogger, notFoundHandler, errorHandler } = require('../../http/middleware/requestLogger');

const JWT_SECRET = process.env.JWT_SECRET || 'yuyuko_secret_key';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function call(baseUrl, method, url, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, body: data };
}

async function main() {
    init();
    const redis = new FakeRedis();
    setSessionStoreForTesting(createSessionStore(redis));

    const app = express();
    app.use(requestLogger);
    app.use(express.json());
    app.use('/users', usersRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const userId = crypto.randomUUID();
    db._raw.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(userId, 'session-user', sha256('secret-1'));

    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const login = (client) => call(base, 'POST', '/users/login', { body: { username: 'session-user', password: 'secret-1', client } });
        const me = (token) => call(base, 'GET', '/users/me', { token });

        // T04：网页与两台移动设备同时登录，互不顶掉
        const web = await login({ platform: 'web' });
        const android = await login({ platform: 'android', app_version: '1.0.0 (1)' });
        const ios = await login({ platform: 'ios', app_version: '1.0.0 (1)' });
        for (const session of [web, android, ios]) {
            assert.strictEqual(session.status, 200, JSON.stringify(session.body));
            assert.ok(jwt.decode(session.body.token).sid, 'new tokens carry a session id');
        }
        for (const session of [web, android, ios]) assert.strictEqual((await me(session.body.token)).status, 200);

        const listed = await call(base, 'GET', '/users/me/sessions', { token: android.body.token });
        assert.strictEqual(listed.status, 200);
        assert.strictEqual(listed.body.sessions.length, 3);
        assert.strictEqual(listed.body.sessions.filter((s) => s.current).length, 1);
        assert.deepStrictEqual(listed.body.sessions.map((s) => s.platform).sort(), ['android', 'ios', 'web']);

        // 退出当前设备不影响其他设备
        assert.strictEqual((await call(base, 'POST', '/users/logout', { token: web.body.token })).status, 200);
        assert.strictEqual((await me(web.body.token)).status, 401);
        assert.strictEqual((await me(android.body.token)).status, 200);

        // 改名：沿用当前 sid 签发新 token，其他设备不受影响
        const renamed = await call(base, 'PATCH', '/users/me', { token: android.body.token, body: { username: 'session-user-2' } });
        assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
        assert.strictEqual(jwt.decode(renamed.body.token).sid, jwt.decode(android.body.token).sid);
        assert.strictEqual((await me(renamed.body.token)).status, 200);
        assert.strictEqual((await me(ios.body.token)).status, 200);

        // 迁移前签发的旧 token（无 sid）仍可使用，并可升级为独立会话
        const legacyToken = jwt.sign({ id: userId, username: 'session-user-2' }, JWT_SECRET, { expiresIn: 3600 });
        await redis.set(keys.legacyKey(userId), legacyToken);
        assert.strictEqual((await me(legacyToken)).status, 200);
        const upgraded = await call(base, 'POST', '/users/me/session', { token: legacyToken });
        assert.strictEqual(upgraded.status, 200);
        assert.strictEqual(upgraded.body.upgraded, true);
        assert.strictEqual((await me(upgraded.body.token)).status, 200);
        assert.strictEqual((await me(legacyToken)).status, 401, 'legacy key is removed after upgrade');
        const again = await call(base, 'POST', '/users/me/session', { token: upgraded.body.token });
        assert.strictEqual(again.body.upgraded, false);

        // 修改密码：其他设备全部下线，当前设备拿到新会话
        const changed = await call(base, 'PATCH', '/users/me/password', {
            token: renamed.body.token,
            body: { currentPassword: 'secret-1', newPassword: 'secret-2' }
        });
        assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
        assert.notStrictEqual(jwt.decode(changed.body.token).sid, jwt.decode(renamed.body.token).sid);
        assert.strictEqual((await me(changed.body.token)).status, 200);
        assert.strictEqual((await me(renamed.body.token)).status, 401);
        assert.strictEqual((await me(ios.body.token)).status, 401);
        assert.strictEqual((await me(upgraded.body.token)).status, 401);

        // 撤销指定设备
        const other = await call(base, 'POST', '/users/login', { body: { username: 'session-user-2', password: 'secret-2' } });
        const otherSid = jwt.decode(other.body.token).sid;
        assert.strictEqual((await call(base, 'DELETE', `/users/me/sessions/${otherSid}`, { token: changed.body.token })).status, 200);
        assert.strictEqual((await me(other.body.token)).status, 401);

        // 退出全部设备
        const extra = await call(base, 'POST', '/users/login', { body: { username: 'session-user-2', password: 'secret-2' } });
        assert.strictEqual((await call(base, 'POST', '/users/logout-all', { token: changed.body.token })).status, 200);
        assert.strictEqual((await me(changed.body.token)).status, 401);
        assert.strictEqual((await me(extra.body.token)).status, 401);

        // T05：Redis 不可用时按 JWT 降级（期间无法感知撤销，恢复后撤销重新生效）
        redis.ready = false;
        assert.strictEqual((await me(extra.body.token)).status, 200);
        redis.ready = true;
        assert.strictEqual((await me(extra.body.token)).status, 401);

        // 注销账号：清理全部会话
        const final = await call(base, 'POST', '/users/login', { body: { username: 'session-user-2', password: 'secret-2' } });
        const second = await call(base, 'POST', '/users/login', { body: { username: 'session-user-2', password: 'secret-2' } });
        assert.strictEqual((await call(base, 'DELETE', '/users/me', { token: final.body.token })).status, 200);
        assert.strictEqual(await redis.exists(keys.sessionKey(userId, jwt.decode(second.body.token).sid)), 0);

        console.log('session integration tests passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        try { db._raw.close(); } catch (e) { }
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
