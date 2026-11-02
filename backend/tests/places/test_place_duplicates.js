// 同一经纬度（6 位小数）同名的地点只能添加一次：网络卡顿时同时到达的重复提交只建一个，
// 其余回 409 duplicate_place（own 标出是不是本人添加的，前端据此按成功处理）；被驳回的地点不算。
// 临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-duplicates-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    PLACE_MODERATION_ENABLED: 'false'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const placeService = require('../../modules/places/services/placeService');
const sql = db._raw;
// The rating summary normally comes from the external numeric service; the delay lets concurrent
// requests all pass the early duplicate check, so the check inside the transaction is what stops them.
require('../../infrastructure/numericAlgorithmClient').compute = async (_operation, input) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const score = input.ratings[0]?.score ?? 4;
    return { summaries: [{ place_id: 1, count: 1, average: score, tier: score, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, [score]: 1 } }] };
};

(async () => {
    init();
    const owner = randomUUID(), visitor = randomUUID();
    for (const [id, name] of [[owner, 'owner'], [visitor, 'visitor']]) {
        sql.prepare('INSERT INTO User(id, username, password) VALUES(?,?,?)').run(id, name, 'unused');
    }
    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (user, body) => fetch(`${base}/places`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` }, body: JSON.stringify(body)
    });
    const count = (name) => sql.prepare('SELECT COUNT(*) AS n FROM Place WHERE name = ?').get(name).n;
    const shop = { name: '卡顿面馆', latitude: 23.123456, longitude: 113.654321, rating: 4 };
    try {
        // 同时到达的三次相同提交：只建一个，其余两次 409 且标为本人
        const responses = await Promise.all([post(owner, shop), post(owner, shop), post(owner, shop)]);
        const statuses = responses.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 409, 409], 'concurrent duplicates');
        assert.equal(count(shop.name), 1);
        const placeId = sql.prepare('SELECT id FROM Place WHERE name = ?').get(shop.name).id;
        for (const res of responses.filter((r) => r.status === 409)) {
            assert.deepEqual(await res.json(), { error: '这个位置已经有同名地点了', code: 'duplicate_place', place_id: placeId, own: true });
        }

        // 别人在同一位置添加同名地点：拒绝，own 为 false；名称前后空白不影响
        const other = await post(visitor, { ...shop, name: `  ${shop.name} ` });
        assert.equal(other.status, 409);
        assert.equal((await other.json()).own, false);
        // 浮点误差内（< 6 位小数）也算同一位置
        assert.equal((await post(visitor, { ...shop, latitude: shop.latitude + 1e-7 })).status, 409);
        assert.equal(count(shop.name), 1);

        // 同一位置不同名、同名但位置不同（第 6 位小数不同）都可以添加
        assert.equal((await post(owner, { ...shop, name: '卡顿面馆二楼' })).status, 200);
        assert.equal((await post(owner, { ...shop, latitude: shop.latitude + 1e-5 })).status, 200);
        assert.equal(count(shop.name), 2);

        // 被驳回的地点不占位
        sql.prepare("UPDATE Place SET moderation_status = 'rejected' WHERE id = ?").run(placeId);
        assert.equal((await post(visitor, shop)).status, 200);
        assert.equal(count(shop.name), 3);

        // 在别人的事务里调用 insertPlaceSync（QQ 机器人）也会拒绝，事务整体回滚
        const validated = placeService.validateNewPlace(shop);
        assert.throws(() => sql.transaction(() => placeService.insertPlaceSync(validated.value, owner, { source: 'qq_bot' })).immediate(),
            (error) => error.code === 'duplicate_place' && error.status === 409 && error.own === false);
        assert.equal(count(shop.name), 3);
        assert.equal(placeService.findSamePositionPlace('不存在', shop.latitude, shop.longitude), null);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        sql.close();
        const resolved = path.resolve(temp);
        if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yuyuko-place-duplicates-')) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
    console.log('place duplicate tests passed: the same name at the same position is created once, concurrent and later duplicates get 409 duplicate_place.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
