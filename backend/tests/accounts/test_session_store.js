'use strict';

// 会话存储单元测试：不需要 SQLite 或 Redis 服务。
const assert = require('assert');
const { createSessionStore, normalizeClientInfo, keys } = require('../../modules/accounts/services/sessions');
const { FakeRedis } = require('../helpers/fakeRedis');

async function main() {
    const redis = new FakeRedis();
    const store = createSessionStore(redis);
    const userId = 'user-1';

    // 两台设备各自登录，互不顶掉
    const web = await store.createSession(userId, { client: { platform: 'web' }, userAgent: 'UA-web' });
    const phone = await store.createSession(userId, { client: { platform: 'android', app_version: '1.0.0 (3)' } });
    assert.notStrictEqual(web.sid, phone.sid);
    assert.deepStrictEqual(await store.verifySession({ id: userId, sid: web.sid }, 'any'), { ok: true });
    assert.deepStrictEqual(await store.verifySession({ id: userId, sid: phone.sid }, 'any'), { ok: true });

    // 退出当前设备不影响其他设备
    await store.revokeSession(userId, web.sid);
    assert.strictEqual((await store.verifySession({ id: userId, sid: web.sid }, 'any')).ok, false);
    assert.strictEqual((await store.verifySession({ id: userId, sid: phone.sid }, 'any')).ok, true);

    // 旧版单会话 token：按 session:<userId> 精确比对，新会话不会覆盖旧键
    await redis.set(keys.legacyKey(userId), 'legacy-token');
    await store.createSession(userId, {});
    assert.strictEqual(await redis.get(keys.legacyKey(userId)), 'legacy-token');
    assert.deepStrictEqual(await store.verifySession({ id: userId }, 'legacy-token'), { ok: true, legacy: true });
    assert.strictEqual((await store.verifySession({ id: userId }, 'other-token')).ok, false);

    // 列表只返回仍有效的会话，并清理过期索引成员
    redis.strings.delete(keys.sessionKey(userId, phone.sid));
    const listed = await store.listSessions(userId);
    assert.strictEqual(listed.length, 1);
    assert.ok(!(await redis.smembers(keys.indexKey(userId))).includes(phone.sid));

    // 撤销全部（保留指定设备），同时清理旧版单会话键
    const keep = await store.createSession(userId, {});
    const drop = await store.createSession(userId, {});
    await store.revokeAllSessions(userId, { exceptSid: keep.sid });
    assert.strictEqual((await store.verifySession({ id: userId, sid: keep.sid }, 'x')).ok, true);
    assert.strictEqual((await store.verifySession({ id: userId, sid: drop.sid }, 'x')).ok, false);
    assert.strictEqual(await redis.get(keys.legacyKey(userId)), null);
    await store.revokeAllSessions(userId);
    assert.strictEqual((await store.verifySession({ id: userId, sid: keep.sid }, 'x')).ok, false);

    // 旧 token 升级为独立会话后，旧键失效
    await redis.set(keys.legacyKey(userId), 'legacy-2');
    const upgraded = await store.upgradeLegacySession(userId, { client: { platform: 'web' } });
    assert.strictEqual((await store.verifySession({ id: userId }, 'legacy-2')).ok, false);
    assert.strictEqual((await store.verifySession({ id: userId, sid: upgraded.sid }, 'x')).ok, true);

    // Redis 未就绪或查询失败：降级为仅 JWT 校验（期间无法感知撤销，属已知边界）
    redis.ready = false;
    const degraded = await store.verifySession({ id: userId, sid: 'revoked-sid' }, 'x');
    assert.strictEqual(degraded.ok, true);
    assert.strictEqual(degraded.degraded, true);
    redis.ready = true;
    redis.failNext = new Error('ECONNRESET');
    const failed = await store.verifySession({ id: userId, sid: 'revoked-sid' }, 'x');
    assert.strictEqual(failed.ok, true);
    assert.strictEqual(failed.reason, 'redis_lookup_failed');

    // 写入失败时向调用方抛出，由登录接口记录日志
    redis.failNext = new Error('write failed');
    await assert.rejects(() => store.createSession(userId, {}));

    // 客户端信息只保留白名单字段
    assert.deepStrictEqual(normalizeClientInfo({ platform: 'IOS', app_version: '1.2.3', token: 'secret' }, 'x'.repeat(400)), {
        platform: 'ios', app_version: '1.2.3', user_agent: 'x'.repeat(160)
    });
    assert.strictEqual(normalizeClientInfo({ platform: 'desktop' }).platform, 'web');

    console.log('session store tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
