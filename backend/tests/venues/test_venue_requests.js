// 场馆请求：denpawave 推送 → 管理员待办 → 关联到 Place → 跳转解析。
// 临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-venue-requests-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    PLACE_MODERATION_ENABLED: 'false',
    VENUE_REQUEST_TOKEN: 'venue-test-token',
    VENUE_REQUEST_ALLOWED_IPS: '127.0.0.1'
});

// Redis 不可用时 requireAuth 只验 JWT 签名；本机若碰巧有 Redis，legacy 会话校验会让测试随机 401。
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const internal = require('../../modules/venues/routes/internal');
const publicRoute = require('../../modules/venues/routes/public');
const adminRoute = require('../../modules/venues/routes/admin');
const { requireAuth } = require('../../modules/accounts/middleware/auth');

const sql = db._raw;

(async () => {
    init();
    const admin = randomUUID();
    const plain = randomUUID();
    for (const [id, name, level] of [[admin, 'admin', 'YUYUKO'], [plain, 'plain', null]]) {
        sql.prepare('INSERT INTO User(id, username, password, admin_level) VALUES(?,?,?,?)').run(id, name, 'unused', level);
    }
    sql.prepare('INSERT INTO Place(id, name, longitude, latitude, creator_id, moderation_status) VALUES(1,?,?,?,?,?)')
        .run('测试场馆', 121.56, 31.20, admin, 'visible');

    const app = express();
    app.use((req, res, next) => { res.locals.requestId = 'test-request-id'; next(); });
    app.use(express.json());
    app.use('/internal/venue-requests', internal);
    app.use('/venue-requests', publicRoute);
    app.use('/admin/venue-requests', requireAuth, adminRoute);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');

    // 默认每次前清空限流计数：限流本身有独立用例，别让它干扰其余断言。
    const rawPush = (body, { auth = 'Bearer venue-test-token' } = {}) => fetch(`${base}/internal/venue-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }) },
        body: JSON.stringify(body)
    });
    const push = (body, options) => { internal.resetRateLimit(); return rawPush(body, options); };
    const adminCall = (method, url, user, body) => fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const event = (over = {}) => ({
        key: 'con-8b1f9a',
        label: '上海新国际博览中心（Comic Horizon 2026）',
        address: '上海市浦东新区龙阳路2345号',
        city: '上海',
        ...over
    });
    const rows = () => sql.prepare('SELECT * FROM VenueRequest ORDER BY id').all();
    const audits = () => sql.prepare("SELECT action, details FROM AdminAudit WHERE action LIKE '%venue-request' ORDER BY id").all();

    try {
        // --- 鉴权 ---
        assert.equal((await push({ events: [event()] }, { auth: null })).status, 401, '缺 bearer 应 401');
        assert.equal((await push({ events: [event()] }, { auth: 'Bearer wrong' })).status, 401, '错 bearer 应 401');
        process.env.VENUE_REQUEST_TOKEN = '';
        assert.equal((await push({ events: [event()] })).status, 503, '未配置 token 应 503，不能放行');
        assert.equal(rows().length, 0, '鉴权失败不得写入');
        process.env.VENUE_REQUEST_TOKEN = 'venue-test-token';

        // 白名单为空 = 拒绝所有（不是不限制）
        process.env.VENUE_REQUEST_ALLOWED_IPS = '';
        assert.equal((await push({ events: [event()] })).status, 503, '未配置白名单应 503');
        assert.equal(rows().length, 0, '白名单未配置时不得写入');
        process.env.VENUE_REQUEST_ALLOWED_IPS = '127.0.0.1';
        // 白名单里没有的来源 IP 应 403（用 authorize 单测，本机无法伪造源 IP）
        assert.deepEqual(
            internal.authorize({ get: () => 'Bearer venue-test-token', ip: '10.1.2.3' }),
            { ok: false, status: 403, error: '来源不在白名单内' }
        );
        assert.equal(internal.authorize({ get: () => 'Bearer venue-test-token', ip: '::ffff:127.0.0.1' }).ok, true);

        // --- 正常推送 ---
        let res = await push({ source: 'denpawave', events: [event()] });
        assert.equal(res.status, 200);
        let data = await res.json();
        assert.deepEqual([data.accepted, data.updated, data.ignored], [1, 0, 0]);
        assert.equal(rows().length, 1);
        assert.equal(rows()[0].status, 'pending');
        assert.equal(rows()[0].label, event().label);

        // --- 重复推送幂等，且内容不变时不算 updated ---
        data = await (await push({ events: [event()] })).json();
        assert.deepEqual([data.accepted, data.updated], [1, 0], '同 key 同内容只算 accepted');
        assert.equal(rows().length, 1, '同 key 不得新建待办');

        // 改了展示文字：更新但不改状态
        data = await (await push({ events: [event({ label: '上海新国际博览中心（CH2026 冬季场）' })] })).json();
        assert.deepEqual([data.accepted, data.updated], [0, 1]);
        assert.equal(rows().length, 1);
        assert.equal(rows()[0].label, '上海新国际博览中心（CH2026 冬季场）');

        // --- 字段校验：单条失败不影响同批 ---
        res = await push({ events: [event({ key: 'bad key!' , }), event({ key: 'con-ok-2' })] });
        assert.equal(res.status, 200);
        data = await res.json();
        assert.equal(data.failed.length, 1);
        assert.equal(data.failed[0].code, 'INVALID_KEY');
        assert.equal(data.accepted, 1);
        assert.equal(rows().length, 2, '合法那条要落库');

        // 超长 label
        data = await (await push({ events: [event({ key: 'con-long', label: 'x'.repeat(121) })] })).json();
        assert.equal(data.failed[0].code, 'INVALID_FIELD');
        // 控制字符
        data = await (await push({ events: [event({ key: 'con-ctrl', label: 'bad\u0000label' })] })).json();
        assert.equal(data.failed[0].code, 'INVALID_FIELD');
        // 全部失败
        assert.equal((await push({ events: [{ key: '!' }] })).status, 400);
        // 空批 / 超量
        assert.equal((await push({ events: [] })).status, 400);
        assert.equal((await push({ events: Array.from({ length: 51 }, (_, i) => event({ key: `con-bulk-${i}` })) })).status, 400);

        // --- 待办列表 ---
        res = await adminCall('GET', '/admin/venue-requests', admin);
        assert.equal(res.status, 200);
        data = await res.json();
        assert.equal(data.count, 2);
        assert.equal(data.pending[0].external_key, 'con-8b1f9a');
        assert.equal((await adminCall('GET', '/admin/venue-requests', plain)).status, 403, '非管理员 403');

        // --- 关联 ---
        const id = data.pending[0].id;
        assert.equal((await adminCall('POST', `/admin/venue-requests/${id}/link`, admin, {})).status, 400, '缺 place_id 400');
        assert.equal((await adminCall('POST', `/admin/venue-requests/${id}/link`, admin, { place_id: 999 })).status, 404, '地点不存在 404');
        res = await adminCall('POST', `/admin/venue-requests/${id}/link`, admin, { place_id: 1 });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { placeId: 1 });
        assert.equal(rows().find((r) => r.id === id).status, 'linked');
        assert.equal(rows().find((r) => r.id === id).handled_by, admin);
        assert.equal(audits().length, 1, '关联要写审计');
        assert.equal(audits()[0].action, 'link-venue-request');
        assert.equal((await adminCall('POST', `/admin/venue-requests/${id}/link`, admin, { place_id: 1 })).status, 409, '重复关联 409');

        // --- 解析 ---
        res = await fetch(`${base}/venue-requests/con-8b1f9a`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'linked', placeId: 1 });
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await (await fetch(`${base}/venue-requests/con-ok-2`)).json(), { status: 'pending', placeId: null });
        assert.deepEqual(await (await fetch(`${base}/venue-requests/con-nope`)).json(), { status: 'unknown', placeId: null });
        assert.equal((await fetch(`${base}/venue-requests/${'x'.repeat(65)}`)).status, 400, '超长 key 400');

        // 解析不泄露展示文字
        const raw = await (await fetch(`${base}/venue-requests/con-8b1f9a`)).text();
        assert.equal(raw.includes('新国际'), false, '公开接口不得回传 label');

        // --- 地点被删 → 退化为 unknown ---
        sql.prepare('DELETE FROM Place WHERE id = 1').run();
        assert.deepEqual(await (await fetch(`${base}/venue-requests/con-8b1f9a`)).json(), { status: 'unknown', placeId: null });

        // --- ignore ---
        const second = rows().find((r) => r.external_key === 'con-ok-2').id;
        res = await adminCall('POST', `/admin/venue-requests/${second}/ignore`, admin, { note: '展会取消' });
        assert.equal(res.status, 200);
        const ignoredRow = rows().find((r) => r.id === second);
        assert.equal(ignoredRow.status, 'ignored');
        assert.equal(ignoredRow.note, '展会取消');
        assert.equal(audits().length, 2, 'ignore 也要写审计');
        assert.equal(audits()[1].action, 'ignore-venue-request');
        assert.equal((await adminCall('POST', `/admin/venue-requests/${second}/ignore`, admin, {})).status, 409);

        // ignored 行再被推送：保持 ignored，不回到待办
        data = await (await push({ events: [event({ key: 'con-ok-2' })] })).json();
        assert.equal(data.ignored, 1);
        assert.equal(rows().find((r) => r.id === second).status, 'ignored');
        assert.deepEqual(await (await fetch(`${base}/venue-requests/con-ok-2`)).json(), { status: 'ignored', placeId: null });
        assert.equal((await adminCall('GET', '/admin/venue-requests', admin).then((r) => r.json())).count, 0, '处理过的都不在待办里');

        // --- 限流：按来源 IP 计，60 秒内第 7 次开始 429 ---
        internal.resetRateLimit();
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await rawPush({ events: [event()] })).status);
        assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200], '前 6 次应放行');
        assert.equal(statuses[6], 429, '第 7 次应 429');
        const limited = await rawPush({ events: [event()] });
        assert.equal(limited.headers.get('retry-after'), '60', '429 要带 Retry-After');
        internal.resetRateLimit();

        console.log('Venue request tests passed.');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        sql.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
