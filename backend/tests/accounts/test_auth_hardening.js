'use strict';

// 鉴权加固：JWT 密钥检查与 HS256 限定、登录失败限流、删除他人饭局走权限表并记审计。
// 真实路由 + 临时 SQLite；会话用内存实现，不需要 Redis。
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-auth-hardening-'));
process.env.DB_FILE = path.join(tempDirectory, 'auth.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
delete process.env.LOGIN_FAILURE_LIMITS;

const { db, init } = require('../../infrastructure/database');
const { setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
const { createSessionStore } = require('../../modules/accounts/services/sessions');
const { JWT_SECRET, DEV_FALLBACK, jwtSecretProblem } = require('../../modules/accounts/services/jwtSecret');
const loginThrottle = require('../../modules/accounts/services/loginThrottle');
const { FakeRedis } = require('../helpers/fakeRedis');
const usersRouter = require('../../modules/accounts/routes/users');
const dinnersRouter = require('../../modules/community/routes/dinners');
const { requestLogger, notFoundHandler, errorHandler } = require('../../http/middleware/requestLogger');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function call(base, method, url, { token, body, ip } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ip) headers['X-Forwarded-For'] = ip;
    const response = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, body: data, headers: response.headers };
}

async function main() {
    // ---- JWT 密钥检查 ----
    assert.strictEqual(jwtSecretProblem(''), 'JWT_SECRET is not set');
    assert.match(jwtSecretProblem(DEV_FALLBACK), /fallback/);
    assert.match(jwtSecretProblem('short-secret'), /shorter/);
    assert.strictEqual(jwtSecretProblem('x'.repeat(48)), null);

    init();
    setSessionStoreForTesting(createSessionStore(new FakeRedis()));
    loginThrottle.resetForTesting();

    const app = express();
    app.set('trust proxy', true);
    app.use(requestLogger);
    app.use(express.json());
    app.use('/users', usersRouter);
    app.use('/dinners', dinnersRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const insertUser = (username, password, adminLevel = null) => {
        const id = crypto.randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, username, sha256(password), adminLevel);
        return id;
    };

    try {
        const aliceId = insertUser('alice', 'right-password');
        insertUser('bob', 'bob-password');
        const login = (username, password, ip = '203.0.113.5') => call(base, 'POST', '/users/login', { body: { username, password }, ip });

        // ---- HS256 限定：别的算法或无签名的 token 一律拒绝 ----
        const good = await login('alice', 'right-password');
        assert.strictEqual(good.status, 200, JSON.stringify(good.body));
        const sid = jwt.decode(good.body.token).sid;
        assert.strictEqual(jwt.decode(good.body.token, { complete: true }).header.alg, 'HS256');
        const hs384 = jwt.sign({ id: aliceId, sid }, JWT_SECRET, { algorithm: 'HS384' });
        assert.strictEqual((await call(base, 'GET', '/users/me', { token: hs384 })).status, 401, 'HS384 token rejected');
        const unsigned = jwt.sign({ id: aliceId, sid }, null, { algorithm: 'none' });
        assert.strictEqual((await call(base, 'GET', '/users/me', { token: unsigned })).status, 401, 'alg=none token rejected');
        assert.strictEqual((await call(base, 'GET', '/users/me', { token: good.body.token })).status, 200);

        // ---- 登录失败限流 ----
        const { accountIp, ip: ipLimit } = loginThrottle.DEFAULTS;
        for (let i = 0; i < accountIp; i += 1) {
            assert.strictEqual((await login('alice', `wrong-${i}`)).status, 401);
        }
        const locked = await login('alice', 'right-password');
        assert.strictEqual(locked.status, 429, 'correct password is refused while locked');
        assert.strictEqual(locked.body.code, 'login_throttled');
        assert.ok(Number(locked.headers.get('retry-after')) > 0);
        // 同一 IP 段的其他账号、其他 IP 段的同一账号不受账号 + IP 段计数影响
        assert.strictEqual((await login('bob', 'bob-password', '203.0.113.77')).status, 200);
        assert.strictEqual((await login('alice', 'right-password', '198.51.100.9')).status, 200);

        // 成功登录清掉账号 + IP 段计数
        loginThrottle.resetForTesting();
        for (let i = 0; i < accountIp - 1; i += 1) await login('alice', `wrong-${i}`);
        assert.strictEqual((await login('alice', 'right-password')).status, 200);
        for (let i = 0; i < accountIp - 1; i += 1) await login('alice', `wrong-again-${i}`);
        assert.strictEqual((await login('alice', 'right-password')).status, 200, 'counter was reset by the earlier success');

        // 一个 IP 段轮换账号名猜测
        loginThrottle.resetForTesting();
        for (let i = 0; i < ipLimit; i += 1) await login(`ghost-${i}`, 'x', '192.0.2.10');
        assert.strictEqual((await login('bob', 'bob-password', '192.0.2.200')).status, 429, 'IP prefix limit covers the /24');
        assert.strictEqual((await login('bob', 'bob-password', '192.0.3.1')).status, 200);
        loginThrottle.resetForTesting();

        // 缺字段或类型不对
        assert.strictEqual((await call(base, 'POST', '/users/login', { body: { username: 'alice', password: { $ne: '' } } })).status, 400);

        // ---- 删除饭局：发起人、有 manage_comments 的管理员可删，管理员删别人的记审计 ----
        const creatorId = insertUser('creator', 'p');
        const strangerId = insertUser('stranger', 'p');
        const komachiId = insertUser('komachi', 'p', 'KOMACHI');
        const bogusId = insertUser('bogus-admin', 'p', 'SOMETHING');
        const tokenOf = async (username) => (await login(username, 'p', '10.0.0.1')).body.token;
        const tokens = {
            creator: await tokenOf('creator'),
            stranger: await tokenOf('stranger'),
            komachi: await tokenOf('komachi'),
            bogus: await tokenOf('bogus-admin')
        };
        const newDinner = () => Number(db._raw.prepare(
            `INSERT INTO DinnerEvent (title, description, place_name, start_time, max_participants, contact_info, creator_id, updated_time)
             VALUES ('周五聚餐', '', '', '2026-12-01T18:00', NULL, '', ?, CURRENT_TIMESTAMP)`
        ).run(creatorId).lastInsertRowid);
        const auditCount = (action) => db._raw.prepare('SELECT COUNT(*) AS n FROM AdminAudit WHERE action = ?').get(action).n;

        const d1 = newDinner();
        assert.strictEqual((await call(base, 'DELETE', `/dinners/${d1}`, { token: tokens.stranger })).status, 403);
        assert.strictEqual((await call(base, 'DELETE', `/dinners/${d1}`, { token: tokens.bogus })).status, 403, 'unknown admin level has no permission');
        assert.strictEqual((await call(base, 'DELETE', `/dinners/${d1}`, { token: tokens.creator })).status, 200);
        assert.strictEqual(auditCount('delete-dinner'), 0, 'creator deleting own dinner is not audited');

        const d2 = newDinner();
        assert.strictEqual((await call(base, 'DELETE', `/dinners/${d2}`, { token: tokens.komachi })).status, 200);
        const audit = db._raw.prepare("SELECT admin_id, target_user_id, details FROM AdminAudit WHERE action = 'delete-dinner'").get();
        assert.strictEqual(audit.admin_id, komachiId);
        assert.strictEqual(audit.target_user_id, creatorId);
        assert.strictEqual(JSON.parse(audit.details).dinner_id, d2);
        assert.ok(strangerId && bogusId);

        console.log('auth hardening tests passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        db._raw.close();
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
