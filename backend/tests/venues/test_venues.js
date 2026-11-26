// 场馆：denpawave 推送（pending）→ 管理员在地图上落点（placed）→ 跳转解析。
// 场馆不是 Place：这里只验证「不写 Place」和坐标落点。临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-venues-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    PLACE_MODERATION_ENABLED: 'false',
    VENUE_TOKEN: 'venue-test-token',
    VENUE_ALLOWED_IPS: '127.0.0.1'
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

    const app = express();
    app.use((req, res, next) => { res.locals.requestId = 'test-request-id'; next(); });
    app.use(express.json());
    app.use('/internal/venues', internal);
    app.use('/venues', publicRoute);
    app.use('/admin/venues', requireAuth, adminRoute);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');

    const rawPush = (body, { auth = 'Bearer venue-test-token' } = {}) => fetch(`${base}/internal/venues`, {
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
    const resolveKey = async (key) => (await fetch(`${base}/venues/${key}`)).json();
    const event = (over = {}) => ({
        key: 'con-8b1f9a',
        label: '上海新国际博览中心（Comic Horizon 2026）',
        address: '上海市浦东新区龙阳路2345号',
        city: '上海',
        ...over
    });
    const rows = () => sql.prepare('SELECT * FROM Venue ORDER BY id').all();
    const placeCount = () => sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
    const audits = () => sql.prepare("SELECT action, details FROM AdminAudit WHERE action LIKE '%venue' ORDER BY id").all();

    try {
        // --- 鉴权 ---
        assert.equal((await push({ events: [event()] }, { auth: null })).status, 401, '缺 bearer 应 401');
        assert.equal((await push({ events: [event()] }, { auth: 'Bearer wrong' })).status, 401, '错 bearer 应 401');
        process.env.VENUE_TOKEN = '';
        assert.equal((await push({ events: [event()] })).status, 503, '未配置 token 应 503');
        assert.equal(rows().length, 0, '鉴权失败不得写入');
        process.env.VENUE_TOKEN = 'venue-test-token';

        process.env.VENUE_ALLOWED_IPS = '';
        assert.equal((await push({ events: [event()] })).status, 503, '未配置白名单等于拒绝所有');
        assert.equal(rows().length, 0, '白名单未配置时不得写入');
        process.env.VENUE_ALLOWED_IPS = '127.0.0.1';
        assert.deepEqual(
            internal.authorize({ get: () => 'Bearer venue-test-token', ip: '10.1.2.3' }),
            { ok: false, status: 403, error: '来源不在白名单内' }
        );
        assert.equal(internal.authorize({ get: () => 'Bearer venue-test-token', ip: '::ffff:127.0.0.1' }).ok, true);

        // --- 推送：只收文字，不收坐标 ---
        let data = await (await push({ source: 'denpawave', events: [event()] })).json();
        assert.deepEqual([data.accepted, data.updated, data.ignored], [1, 0, 0]);
        assert.equal(rows().length, 1);
        assert.equal(rows()[0].status, 'pending');
        assert.equal(rows()[0].latitude, null, '推送不得写入坐标');
        assert.equal(placeCount(), 0, '推送不得创建地点');

        // 幂等：同 key 同内容
        data = await (await push({ events: [event()] })).json();
        assert.deepEqual([data.accepted, data.updated], [1, 0]);
        assert.equal(rows().length, 1, '同 key 不得新建待办');

        // 改文字：更新，状态不变
        data = await (await push({ events: [event({ label: '上海新国际博览中心（CH2026 冬季场）' })] })).json();
        assert.deepEqual([data.accepted, data.updated], [0, 1]);
        assert.equal(rows()[0].label, '上海新国际博览中心（CH2026 冬季场）');
        assert.equal(rows()[0].status, 'pending');

        // 单条失败不影响同批
        data = await (await push({ events: [event({ key: 'bad key!' }), event({ key: 'con-ok-2' })] })).json();
        assert.equal(data.failed.length, 1);
        assert.equal(data.failed[0].code, 'INVALID_KEY');
        assert.equal(data.accepted, 1);
        assert.equal(rows().length, 2);

        data = await (await push({ events: [event({ key: 'con-long', label: 'x'.repeat(121) })] })).json();
        assert.equal(data.failed[0].code, 'INVALID_FIELD');
        data = await (await push({ events: [event({ key: 'con-ctrl', label: 'bad\u0000label' })] })).json();
        assert.equal(data.failed[0].code, 'INVALID_FIELD');
        assert.equal((await push({ events: [{ key: '!' }] })).status, 400);
        assert.equal((await push({ events: [] })).status, 400);
        assert.equal((await push({ events: Array.from({ length: 51 }, (_, i) => event({ key: `con-bulk-${i}` })) })).status, 400);

        // 对端若硬塞坐标，一律忽略（坐标只能来自管理员选点）
        data = await (await push({ events: [event({ key: 'con-with-coords', latitude: 31.2, longitude: 121.5 })] })).json();
        assert.equal(data.accepted, 1);
        const withCoords = rows().find((r) => r.external_key === 'con-with-coords');
        assert.equal(withCoords.latitude, null, '对端坐标不得入库');

        // --- 待办 ---
        let res = await adminCall('GET', '/admin/venues', admin);
        assert.equal(res.status, 200);
        data = await res.json();
        // con-8b1f9a、con-ok-2、con-with-coords 都是 pending
        assert.equal(data.count, 3, '只列 pending');
        assert.equal(data.pending[0].external_key, 'con-8b1f9a');
        assert.equal((await adminCall('GET', '/admin/venues', plain)).status, 403, '非管理员 403');

        // --- 落点 ---
        const id = data.pending[0].id;
        assert.equal((await adminCall('POST', `/admin/venues/${id}/place`, admin, { latitude: 0, longitude: 0 })).status, 400, '(0,0) 拒绝');
        assert.equal((await adminCall('POST', `/admin/venues/${id}/place`, admin, { latitude: 86, longitude: 121 })).status, 400, '超出 Web Mercator 拒绝');
        assert.equal((await adminCall('POST', `/admin/venues/${id}/place`, admin, {})).status, 400, '缺坐标 400');

        res = await adminCall('POST', `/admin/venues/${id}/place`, admin, { latitude: 31.20139, longitude: 121.56528 });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { latitude: 31.20139, longitude: 121.56528 });
        const placed = rows().find((r) => r.id === id);
        assert.equal(placed.status, 'placed');
        assert.equal(placed.placed_by, admin);
        assert.equal(placed.latitude, 31.20139);
        assert.equal(placeCount(), 0, '落点不得创建 Place');
        assert.equal(audits().length, 1);
        assert.equal(audits()[0].action, 'place-venue');
        assert.equal((await adminCall('POST', `/admin/venues/${id}/place`, admin, { latitude: 31, longitude: 121 })).status, 409, '重复落点 409');

        // --- 解析：只回状态与坐标 ---
        res = await fetch(`${base}/venues/con-8b1f9a`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await res.json(), { status: 'placed', latitude: 31.20139, longitude: 121.56528 });
        assert.deepEqual(await resolveKey('con-ok-2'), { status: 'pending', latitude: null, longitude: null });
        assert.deepEqual(await resolveKey('con-nope'), { status: 'unknown', latitude: null, longitude: null });
        assert.equal((await fetch(`${base}/venues/${'x'.repeat(65)}`)).status, 400);

        const raw = await (await fetch(`${base}/venues/con-8b1f9a`)).text();
        assert.equal(raw.includes('新国际'), false, '公开接口不得回传 label');
        assert.equal(raw.includes('上海市'), false, '公开接口不得回传地址');

        // --- 已存在的地点与场馆无关：删掉所有 Place 也不影响解析 ---
        assert.equal(placeCount(), 0);
        assert.deepEqual(await resolveKey('con-8b1f9a'), { status: 'placed', latitude: 31.20139, longitude: 121.56528 });

        // --- ignore ---
        const second = rows().find((r) => r.external_key === 'con-ok-2').id;
        res = await adminCall('POST', `/admin/venues/${second}/ignore`, admin, { note: '展会取消' });
        assert.equal(res.status, 200);
        const ignoredRow = rows().find((r) => r.id === second);
        assert.equal(ignoredRow.status, 'ignored');
        assert.equal(ignoredRow.note, '展会取消');
        assert.equal(audits().length, 2);
        assert.equal(audits()[1].action, 'ignore-venue');
        assert.equal((await adminCall('POST', `/admin/venues/${second}/ignore`, admin, {})).status, 409);
        assert.deepEqual(await resolveKey('con-ok-2'), { status: 'ignored', latitude: null, longitude: null });

        // ignored 行再被推送：保持 ignored
        data = await (await push({ events: [event({ key: 'con-ok-2' })] })).json();
        assert.equal(data.ignored, 1);
        assert.equal(rows().find((r) => r.id === second).status, 'ignored');

        // 第三条（对端硬塞坐标那条）也清掉，待办应为空
        const third = rows().find((r) => r.external_key === 'con-with-coords').id;
        assert.equal((await adminCall('POST', `/admin/venues/${third}/ignore`, admin, {})).status, 200);
        assert.equal((await adminCall('GET', '/admin/venues', admin).then((r) => r.json())).count, 0);

        // --- 限流：按来源 IP 计，60 秒 6 次 ---
        internal.resetRateLimit();
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await rawPush({ events: [event()] })).status);
        assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200], '前 6 次应放行');
        assert.equal(statuses[6], 429, '第 7 次应 429');
        assert.equal((await rawPush({ events: [event()] })).headers.get('retry-after'), '60');
        internal.resetRateLimit();

        console.log('Venue tests passed.');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        sql.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
