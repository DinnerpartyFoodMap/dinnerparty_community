'use strict';

// QQ verification codes: the bot private-message delivery, registration and
// password reset with real users routes, a temp SQLite file, an in-memory session
// store and a fake NapCat client. No network access, no Redis needed.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-qq-verification-'));
process.env.DB_FILE = path.join(tempDirectory, 'verification.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';

const GROUP_A = '30001';
const GROUP_B = '30002';

// The fake bot stands in for NapCat: group membership, friends and private sends.
class FakeBotClient {
    constructor() {
        this.connected = true;
        this.members = { [GROUP_A]: new Set(), [GROUP_B]: new Set() };
        this.friends = new Set();
        this.sent = [];
        this.sendFailure = null;
    }

    async call(action, params) {
        if (!this.connected) throw Object.assign(new Error('offline'), { code: 'not_connected' });
        if (action === 'get_group_member_info') {
            const group = this.members[String(params.group_id)];
            if (group && group.has(String(params.user_id))) return { user_id: params.user_id, group_id: params.group_id };
            throw Object.assign(new Error('不是群成员'), { code: 'failed' });
        }
        if (action === 'get_friend_list') return [...this.friends].map((qq) => ({ user_id: Number(qq) }));
        if (action === 'send_private_msg') {
            if (this.sendFailure === 'failed') throw Object.assign(new Error('对方拒收临时会话'), { code: 'failed' });
            if (this.sendFailure === 'timeout') throw Object.assign(new Error('timed out'), { code: 'timeout', outcomeUnknown: true });
            this.sent.push(params);
            return { message_id: this.sent.length };
        }
        throw Object.assign(new Error(`unexpected ${action}`), { code: 'failed' });
    }

    lastText() {
        const last = this.sent[this.sent.length - 1];
        return last ? last.message[0].data.text : '';
    }

    lastCode() {
        return this.lastText().match(/\d{6}/)[0];
    }
}

const fakeClient = new FakeBotClient();
require.cache[require.resolve('../../modules/qqbot/runtime/index')] = { exports: { getQQBot: () => ({ client: fakeClient }) } };

const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
const botConfig = require('../../modules/qqbot/runtime/config');
const { setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
const { createSessionStore } = require('../../modules/accounts/services/sessions');
const { FakeRedis } = require('../helpers/fakeRedis');
const verification = require('../../modules/accounts/services/qqVerification');
const usersRouter = require('../../modules/accounts/routes/users');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function configure() {
    botConfig.setForTesting({
        enabled: true,
        selfId: '900001',
        commands: { enabled: true, privateEnabled: true, groupIds: [GROUP_B] },
        whitelist: { mode: 'on', groupIds: [GROUP_A], intervalMs: 3600000 },
        notify: { enabled: false, groupIds: [] }
    });
}

function whitelist(...numbers) {
    for (const qq of numbers) sql.prepare('INSERT OR IGNORE INTO QQWhitelist (qq) VALUES (?)').run(qq);
}

function codeRows(qq) {
    return sql.prepare('SELECT id, purpose, status, attempts FROM QQVerificationCode WHERE qq = ? ORDER BY id').all(qq);
}

// Moves a QQ's sends back in time so the 60 s resend cooldown no longer applies.
function skipCooldown(qq) {
    sql.prepare('UPDATE QQVerificationCode SET created_at = ? WHERE qq = ?').run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), qq);
}

async function main() {
    init();
    configure();
    setSessionStoreForTesting(createSessionStore(new FakeRedis()));

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/users', usersRouter);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    let ipCounter = 0;
    async function call(method, url, { body, token, ip } = {}) {
        // A fresh client IP per request keeps the per-IP limit out of unrelated cases.
        const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `198.51.100.${(ipCounter++ % 250) + 1}` };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
    }
    const sendCode = (qq, purpose = 'register', options) => call('POST', '/users/verification-code', { body: { qq, purpose }, ...options });
    const register = (username, qq, verificationCode, password = 'secret-1') =>
        call('POST', '/users/register', { body: { username, password, qq, verificationCode } });
    const resetPassword = (qq, verificationCode, newPassword) =>
        call('POST', '/users/password-reset', { body: { qq, verificationCode, newPassword } });
    const login = (username, password) => call('POST', '/users/login', { body: { username, password } });

    try {
        // --- input validation and registration pre-checks: nothing is sent or recorded
        assert.equal((await sendCode('200001', 'other')).status, 400);
        assert.equal((await sendCode('012345')).status, 400);
        let res = await sendCode('200001');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /白名单/);
        whitelist('200001', '200002', '200003', '200004');
        fakeClient.connected = false;
        assert.equal((await sendCode('200001')).status, 503, 'bot offline');
        fakeClient.connected = true;
        assert.equal(fakeClient.sent.length, 0);
        assert.equal(codeRows('200001').length, 0);

        // --- delivery as a temp session through a shared group
        fakeClient.members[GROUP_B].add('200001');
        res = await sendCode('200001');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual([res.body.expires_in, res.body.resend_after], [300, 60]);
        const firstSend = fakeClient.sent[0];
        assert.deepEqual([firstSend.user_id, firstSend.group_id], [200001, Number(GROUP_B)], 'group_id only for a confirmed member');
        assert.match(fakeClient.lastText(), /^【东方饭联地图】注册验证码：\d{6}\n/);
        const firstCode = fakeClient.lastCode();
        assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM QQVerificationCode').all()).includes(firstCode), 'only a hash is stored');

        // --- resend cooldown
        res = await sendCode('200001');
        assert.equal(res.status, 429);
        assert.ok(res.body.retry_after > 0 && res.body.retry_after <= 60);
        assert.equal(res.headers.get('retry-after'), String(res.body.retry_after));

        // --- wrong guesses lock the code; the attempt count commits although registration fails
        const wrong = firstCode === '000000' ? '000001' : '000000';
        for (let remaining = 4; remaining >= 1; remaining -= 1) {
            res = await register('新住民', '200001', wrong);
            assert.equal(res.status, 400);
            assert.match(res.body.error, new RegExp(`还可以再试 ${remaining} 次`));
        }
        res = await register('新住民', '200001', wrong);
        assert.match(res.body.error, /错误次数过多/);
        res = await register('新住民', '200001', firstCode);
        assert.match(res.body.error, /错误次数过多/, 'a locked code stays locked even when correct');
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM User').get().n, 0);

        // --- a new code supersedes the old one
        skipCooldown('200001');
        assert.equal((await sendCode('200001')).status, 200);
        const secondCode = fakeClient.lastCode();
        if (secondCode !== firstCode) {
            assert.equal((await register('新住民', '200001', firstCode)).status, 400, 'old code is no longer valid');
        }
        assert.deepEqual(codeRows('200001').map((row) => row.status), ['superseded', 'sent']);
        res = await register('新住民', '200001', secondCode);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.ok(res.body.token);
        const registeredToken = res.body.token;
        assert.equal(codeRows('200001')[1].status, 'used');
        assert.equal(sql.prepare('SELECT qq FROM User WHERE username = ?').get('新住民').qq, '200001');

        // --- the QQ is bound now: no more registration codes, the used code is spent
        res = await sendCode('200001');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /已被其他住民绑定/);

        // --- expired code
        fakeClient.members[GROUP_A].add('200002');
        assert.equal((await sendCode('200002')).status, 200);
        const expiredCode = fakeClient.lastCode();
        sql.prepare('UPDATE QQVerificationCode SET expires_at = ? WHERE qq = ?').run(new Date(Date.now() - 1000).toISOString(), '200002');
        res = await register('过期住民', '200002', expiredCode);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /过期/);

        // --- unreachable: no shared group and not a friend; a failed send does not start the cooldown
        const sentBefore = fakeClient.sent.length;
        res = await sendCode('200003');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /无法私聊/);
        assert.equal(fakeClient.sent.length, sentBefore);
        assert.equal(codeRows('200003')[0].status, 'failed');
        fakeClient.friends.add('200003');
        assert.equal((await sendCode('200003')).status, 200, 'retry right after a failed send');
        assert.equal(fakeClient.sent[fakeClient.sent.length - 1].group_id, undefined, 'friends get a normal private message');

        // --- NapCat refuses the message / the outcome is unknown
        fakeClient.members[GROUP_A].add('200004');
        fakeClient.sendFailure = 'failed';
        res = await sendCode('200004');
        assert.equal(res.status, 502);
        assert.equal(codeRows('200004')[0].status, 'failed');
        fakeClient.sendFailure = 'timeout';
        assert.equal((await sendCode('200004')).status, 200, 'unknown outcome may have arrived: keep the code');
        assert.equal(codeRows('200004')[1].status, 'sent');
        fakeClient.sendFailure = null;

        // --- password reset
        res = await sendCode('209999', 'reset_password');
        assert.equal(res.status, 404);
        res = await sendCode('200001', 'reset_password');
        assert.equal(res.status, 429, 'cooldown is per QQ across purposes');
        skipCooldown('200001');
        res = await sendCode('200001', 'reset_password');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.match(fakeClient.lastText(), /^【东方饭联地图】找回通行密码的验证码：\d{6}\n住民名：新住民\n/);
        const resetCode = fakeClient.lastCode();
        assert.equal((await resetPassword('200001', resetCode, '123')).status, 400, 'new password too short');
        // A registration code never works for a reset and vice versa.
        assert.equal((await register('另一个', '200001', resetCode)).status, 400);
        res = await resetPassword('200001', resetCode, 'new-secret');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.user.username, '新住民');
        assert.ok(res.body.token);
        assert.equal((await login('新住民', 'secret-1')).status, 401, 'old password rejected');
        assert.equal((await login('新住民', 'new-secret')).status, 200, 'new password accepted');
        assert.equal((await call('GET', '/users/me', { token: registeredToken })).status, 401, 'sessions from before the reset are revoked');
        assert.equal((await call('GET', '/users/me', { token: res.body.token })).status, 200);
        assert.equal((await resetPassword('200001', resetCode, 'another-secret')).status, 400, 'code is single-use');

        // --- legacy data: one QQ bound to several residents cannot pick an account
        sql.exec('DROP INDEX IF EXISTS idx_user_qq');
        for (const name of ['重复甲', '重复乙']) {
            sql.prepare('INSERT INTO User (id, username, password, qq) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), name, sha256('x'), '200005');
        }
        res = await sendCode('200005', 'reset_password');
        assert.equal(res.status, 409);
        assert.equal(codeRows('200005').length, 0);

        // --- per-IP limit through the route
        for (const qq of ['200010', '200011', '200012', '200013', '200014', '200015', '200016', '200017', '200018', '200019', '200020']) {
            whitelist(qq);
            fakeClient.members[GROUP_A].add(qq);
        }
        const ip = '203.0.113.7';
        const limited = [];
        for (const qq of ['200010', '200011', '200012', '200013', '200014', '200015', '200016', '200017', '200018', '200019', '200020']) {
            limited.push((await sendCode(qq, 'register', { ip })).status);
        }
        assert.deepEqual(limited, [...Array(10).fill(200), 429]);

        // --- hourly limits, driven through the service with explicit clock values
        const later = Date.now() + 24 * 60 * 60 * 1000;
        for (let i = 0; i < verification.LIMITS.perQQ; i += 1) {
            verification.reserveCode({ purpose: 'register', qq: '300001', ip: `10.0.0.${i}`, now: new Date(later + i * 61 * 1000) });
        }
        assert.throws(() => verification.reserveCode({ purpose: 'register', qq: '300001', ip: '10.0.1.1', now: new Date(later + 6 * 61 * 1000) }),
            (error) => error.reason === 'qq_hourly_limit' && error.status === 429 && error.retryAfterSeconds > 0);
        const muchLater = later + 3 * 60 * 60 * 1000;
        for (let i = 0; i < verification.LIMITS.global; i += 1) {
            verification.reserveCode({ purpose: 'register', qq: String(310000 + i), ip: `10.1.${Math.floor(i / 5)}.${i}`, now: new Date(muchLater + i) });
        }
        assert.throws(() => verification.reserveCode({ purpose: 'register', qq: '320000', ip: '10.9.9.9', now: new Date(muchLater + 100) }),
            (error) => error.reason === 'global_hourly_limit');
        // Rows older than the retention window are pruned on the next reservation.
        verification.reserveCode({ purpose: 'register', qq: '330000', ip: '10.9.9.10', now: new Date(muchLater + 3 * 24 * 60 * 60 * 1000) });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM QQVerificationCode').get().n, 1);
        assert.equal(verification.maskQQ('123456789'), '12****89');

        console.log('QQ verification tests passed: validation, delivery via group/friend, cooldown, attempts, supersede, expiry, failures, registration, password reset, session revocation, limits.');
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

main().then(() => {
    db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}).catch((error) => {
    console.error(error);
    try { db.close(); } catch (closeError) { }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    process.exitCode = 1;
});
