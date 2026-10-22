const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-skins-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const skins = require('../../modules/skins/services/skinService');
let server;

async function main() {
    // A database from before skins: the legacy InviteCode table already holds registration codes.
    db._raw.exec(`CREATE TABLE InviteCode (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, max_uses INTEGER DEFAULT 1,
        current_uses INTEGER DEFAULT 0, created_time DATETIME DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO InviteCode (code, max_uses, current_uses) VALUES ('LEGACYCODE01', 5, 0);`);
    init();
    init(); // Initializing twice keeps codes and unlocks.
    const legacy = db._raw.prepare("SELECT * FROM InviteCode WHERE code = 'LEGACYCODE01'").get();
    assert.equal(legacy.skin_id, null, '旧注册邀请码保留，且不是皮肤兑换码');
    assert.equal(legacy.revoked, 0);
    assert.ok(db._raw.prepare("PRAGMA table_info('User')").all().some(column => column.name === 'active_skin'));
    assert.throws(() => skins.setCatalogForTesting([{ id: 'default', name: '默认' }]), /Invalid skin catalog entry/);
    assert.throws(() => skins.setCatalogForTesting([{ id: 'Bad Id', name: 'x' }]), /Invalid skin catalog entry/);
    skins.setCatalogForTesting([{ id: 'sakura', name: '樱花' }, { id: 'night', name: '夜色' }]);

    const users = {};
    const ids = {};
    for (const level of ['YUYUKO', 'YOUMU', 'KOMACHI', 'alice', 'bob', 'carol']) {
        const id = randomUUID();
        const admin = ['YUYUKO', 'YOUMU', 'KOMACHI'].includes(level) ? level : null;
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, level, 'unused', admin);
        ids[level] = id;
        users[level] = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const app = express();
    app.use(express.json());
    app.use('/api/skins', require('../../modules/skins/routes/skins'));
    app.use('/admin/skin-codes', require('../../modules/accounts/middleware/auth').requireAuth, require('../../modules/admin/routes/adminSkinCodes'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, who) {
        const res = await fetch(base + url, { method, headers: {
            'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${users[who]}` } : {})
        }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json() };
    }

    // 权限：独立 manage_skin_codes，仅 YUYUKO 能管理兑换码。
    for (const [who, status] of [[undefined, 401], ['alice', 403], ['YOUMU', 403], ['KOMACHI', 403]]) {
        assert.equal((await request('/admin/skin-codes', 'GET', null, who)).status, status);
        assert.equal((await request('/admin/skin-codes', 'POST', { skin_id: 'sakura' }, who)).status, status);
    }
    const listed = await request('/admin/skin-codes', 'GET', null, 'YUYUKO');
    assert.deepEqual(listed.body.catalog.map(skin => skin.id), ['sakura', 'night']);
    assert.deepEqual(listed.body.codes, [], '旧邀请码不出现在皮肤兑换码列表里');
    for (const bad of [{ skin_id: 'unknown' }, { skin_id: 'default' }, { skin_id: 'sakura', count: 0 }, { skin_id: 'sakura', count: 201 },
        { skin_id: 'sakura', max_uses: 0 }, { skin_id: 'sakura', max_uses: 1.5 }, { skin_id: 'sakura', expires_days: 0 },
        { skin_id: 'sakura', expires_days: 'soon' }, { skin_id: 'sakura', note: 'x'.repeat(101) }]) {
        assert.equal((await request('/admin/skin-codes', 'POST', bad, 'YUYUKO')).status, 400, JSON.stringify(bad));
    }
    const batch = await request('/admin/skin-codes', 'POST', { skin_id: 'sakura', count: 3, max_uses: 2, note: ' 秋季活动 ' }, 'YUYUKO');
    assert.equal(batch.status, 200);
    assert.equal(batch.body.codes.length, 3);
    for (const code of batch.body.codes) {
        assert.match(code.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
        assert.deepEqual([code.skin_id, code.skin_name, code.max_uses, code.current_uses, code.status, code.note, code.created_by],
            ['sakura', '樱花', 2, 0, 'active', '秋季活动', 'YUYUKO']);
    }
    assert.equal(new Set(batch.body.codes.map(code => code.code)).size, 3);
    assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM AdminAudit WHERE action = 'create-skin-codes'").get().n, 1);
    const [shared, single, revoked] = batch.body.codes;

    // 住民：默认样式、格式错误、旧邀请码不能兑换
    assert.equal((await request('/api/skins/me')).status, 401);
    assert.deepEqual((await request('/api/skins/me', 'GET', null, 'alice')).body, { active: 'default', owned: [] });
    assert.equal((await request('/api/skins/redeem', 'POST', { code: '??' }, 'alice')).status, 400);
    assert.equal((await request('/api/skins/redeem', 'POST', { code: 'LEGACYCODE01' }, 'alice')).status, 404);
    assert.equal((await request('/api/skins/active', 'PUT', { skin_id: 'sakura' }, 'alice')).status, 403, '没解锁不能换上');
    assert.equal((await request('/api/skins/active', 'PUT', { skin_id: 'nope' }, 'alice')).status, 400);

    // 兑换成功：忽略大小写、空格与连字符，并默认立即换上
    const messy = ` ${shared.code.toLowerCase().replace(/-/g, ' ')} `;
    const redeemed = await request('/api/skins/redeem', 'POST', { code: messy }, 'alice');
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.active, 'sakura');
    assert.deepEqual(redeemed.body.unlocked, { id: 'sakura', name: '樱花' });
    assert.equal(redeemed.body.already_owned, false);
    assert.deepEqual(redeemed.body.owned.map(skin => skin.id), ['sakura']);
    // 已经拥有时不消耗次数
    const again = await request('/api/skins/redeem', 'POST', { code: shared.code }, 'alice');
    assert.equal(again.body.already_owned, true);
    assert.equal(db._raw.prepare('SELECT current_uses FROM InviteCode WHERE id = ?').get(shared.id).current_uses, 1);
    // 第二位住民用完次数，第三位被拒
    assert.equal((await request('/api/skins/redeem', 'POST', { code: shared.code, activate: false }, 'bob')).body.active, 'default', 'activate: false 只解锁');
    const exhausted = await request('/api/skins/redeem', 'POST', { code: shared.code }, 'carol');
    assert.deepEqual([exhausted.status, exhausted.body.reason], [410, 'exhausted']);
    const adminView = (await request('/admin/skin-codes?skin_id=sakura', 'GET', null, 'YUYUKO')).body.codes.find(code => code.id === shared.id);
    assert.deepEqual([adminView.current_uses, adminView.status], [2, 'exhausted']);

    // 切换：默认 ↔ 已解锁
    assert.equal((await request('/api/skins/active', 'PUT', { skin_id: 'default' }, 'alice')).body.active, 'default');
    assert.equal((await request('/api/skins/active', 'PUT', { skin_id: 'sakura' }, 'alice')).body.active, 'sakura');
    assert.equal((await request('/api/skins/active', 'PUT', { skin_id: 'night' }, 'alice')).status, 403);

    // 作废：之后不能兑换，已解锁的人保留
    assert.equal((await request(`/admin/skin-codes/${revoked.id}`, 'DELETE', null, 'alice')).status, 403);
    const revokedView = await request(`/admin/skin-codes/${revoked.id}`, 'DELETE', null, 'YUYUKO');
    assert.equal(revokedView.body.code.status, 'revoked');
    assert.equal((await request(`/admin/skin-codes/${revoked.id}`, 'DELETE', null, 'YUYUKO')).status, 200, '重复作废是幂等的');
    assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM AdminAudit WHERE action = 'revoke-skin-code'").get().n, 1);
    assert.equal((await request('/admin/skin-codes/999999', 'DELETE', null, 'YUYUKO')).status, 404);
    assert.equal((await request(`/admin/skin-codes/${legacy.id}`, 'DELETE', null, 'YUYUKO')).status, 404, '旧邀请码不受皮肤管理影响');
    const revokedTry = await request('/api/skins/redeem', 'POST', { code: revoked.code }, 'carol');
    assert.deepEqual([revokedTry.status, revokedTry.body.reason], [410, 'revoked']);

    // 过期
    const expiring = skins.createCodes(ids.YUYUKO, { skin_id: 'night', expires_days: 1 }, { now: new Date('2026-01-01T00:00:00Z') })[0];
    assert.throws(() => skins.redeemCode(ids.carol, expiring.code, { now: new Date('2026-01-02T00:00:01Z') }), error => error.reason === 'expired');
    assert.equal(skins.redeemCode(ids.carol, expiring.code, { now: new Date('2026-01-01T12:00:00Z') }).state.active, 'night');

    // 皮肤下架后：不再出现在已解锁列表，正在使用时回到默认；它的兑换码也不能再兑换
    const delisted = skins.createCodes(ids.YUYUKO, { skin_id: 'night' })[0];
    skins.setCatalogForTesting([{ id: 'sakura', name: '樱花' }]);
    assert.deepEqual(skins.getSkinState(ids.carol), { active: 'default', owned: [] });
    const unavailable = await request('/api/skins/redeem', 'POST', { code: delisted.code }, 'bob');
    assert.deepEqual([unavailable.status, unavailable.body.reason], [410, 'unavailable']);
    skins.setCatalogForTesting([{ id: 'sakura', name: '樱花' }, { id: 'night', name: '夜色' }]);
    assert.equal(skins.getSkinState(ids.carol).active, 'night');

    // 输错次数限制（只算失败）
    skins.resetFailuresForTesting();
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/skins/redeem', 'POST', { code: 'WRONGCODE' + i }, 'bob')).status, 404);
    const limited = await request('/api/skins/redeem', 'POST', { code: single.code }, 'bob');
    assert.deepEqual([limited.status, limited.body.reason], [429, 'rate_limited'], '正确的码也要等限制解除');
    assert.equal((await request('/api/skins/redeem', 'POST', { code: single.code }, 'carol')).status, 200, '限制按住民计算');
    skins.resetFailuresForTesting();

    // 注销账号：解锁记录随住民删除，兑换码的计数保留
    db._raw.prepare('DELETE FROM User WHERE id = ?').run(ids.alice);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM UserSkin WHERE user_id = ?').get(ids.alice).n, 0);
    assert.equal(db._raw.prepare('SELECT current_uses FROM InviteCode WHERE id = ?').get(shared.id).current_uses, 2);

    // 生成与审计同一事务：审计写入失败时一个码也不留下
    const before = db._raw.prepare('SELECT COUNT(*) AS n FROM InviteCode').get().n;
    db._raw.exec("CREATE TRIGGER fail_skin_audit BEFORE INSERT ON AdminAudit BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await request('/admin/skin-codes', 'POST', { skin_id: 'sakura', count: 5 }, 'YUYUKO')).status, 500);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM InviteCode').get().n, before);
    db._raw.exec('DROP TRIGGER fail_skin_audit');
    console.log('Skins: legacy invite migration, permissions, code generation, redemption, activation, revoke, expiry, rate limit and audit rollback passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
