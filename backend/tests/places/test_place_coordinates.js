// 地点坐标只能落在地图可显示的范围内（Web Mercator ±85.0511°）：地图上下边界外点出的 85°~90°
// 会被前端标记层丢弃，存进库就再也无法显示和选中。覆盖新增、编辑、修改申请与审核四条写入路径，
// 以及检查已有数据的 places:check-coordinates 脚本。
// 临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-coordinates-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite')
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const { PLACE_MAX_LATITUDE, validateNewPlace } = require('../../modules/places/services/placeService');
const { collect } = require('../../scripts/places/check_place_coordinates');
const sql = db._raw;

(async () => {
    init();
    const owner = randomUUID(), visitor = randomUUID(), admin = randomUUID();
    for (const [id, name, level] of [[owner, 'owner', null], [visitor, 'visitor', null], [admin, 'admin', 'YUYUKO']]) {
        sql.prepare('INSERT INTO User(id, username, password, admin_level) VALUES(?,?,?,?)').run(id, name, 'unused', level);
    }
    sql.prepare('INSERT INTO Place(id, name, longitude, latitude, creator_id) VALUES(1,?,?,?,?)').run('测试面馆', 120, 30, owner);
    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, user, body) => fetch(`${base}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` }, body: JSON.stringify(body)
    });
    const coords = () => sql.prepare('SELECT longitude, latitude FROM Place WHERE id = 1').get();
    const placeCount = () => sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
    try {
        assert.equal(PLACE_MAX_LATITUDE, 85.0511, 'must match frontend cluster/engine.js MAX_MERCATOR_LAT');
        assert.equal(validateNewPlace({ name: '边界', latitude: PLACE_MAX_LATITUDE, longitude: 180 }).value.latitude, PLACE_MAX_LATITUDE);
        assert.equal(validateNewPlace({ name: '边界', latitude: -PLACE_MAX_LATITUDE, longitude: -180 }).value.latitude, -PLACE_MAX_LATITUDE);
        // 描述按 Markdown（含 HTML）显示且显示前会清理，保存时接受 HTML；店名、分类、地址仍只接受纯文本，描述仍限 1000 字
        const point = { latitude: 23.1, longitude: 113.3 };
        assert.equal(validateNewPlace({ ...point, name: '店', description: '**好吃** <b>推荐</b>' }).value.description, '**好吃** <b>推荐</b>');
        for (const field of ['name', 'category', 'address']) {
            assert.match(validateNewPlace({ ...point, name: '店', [field]: '<b>x</b>' }).error, /纯文本/, field);
        }
        assert.match(validateNewPlace({ ...point, name: '店', description: 'x'.repeat(1001) }).error, /1000/);

        // 新增：地图上方空白处（89.9°）与左右边界外都拒绝，库里不留记录。
        for (const [latitude, longitude] of [[89.9, 120], [-86, 120], [85.06, 120], [30, 181]]) {
            const res = await call('POST', '/places', owner, { name: '界外店', latitude, longitude });
            assert.equal(res.status, 400, `POST /places ${latitude},${longitude}`);
            assert.match((await res.json()).error, /超出有效范围/);
        }
        assert.equal(placeCount(), 1);
        const created = await call('POST', '/places', owner, { name: '北角店', latitude: 85.05, longitude: 120 });
        assert.equal(created.status, 200, await created.clone().text());
        assert.equal(placeCount(), 2);

        // 编辑：越界坐标拒绝且不改动其他字段；字符串数字按数值写入；只改描述不受影响。
        for (const body of [{ latitude: 88 }, { longitude: -200 }, { latitude: 'north' }, { description: '新描述', latitude: 89 }]) {
            const res = await call('PUT', '/places/1', owner, body);
            assert.equal(res.status, 400, `PUT ${JSON.stringify(body)}`);
        }
        assert.deepEqual(coords(), { longitude: 120, latitude: 30 });
        assert.equal(sql.prepare('SELECT description FROM Place WHERE id = 1').get().description, null);
        const moved = await call('PUT', '/places/1', owner, { latitude: '30.5', longitude: 120.5 });
        assert.equal(moved.status, 200, await moved.clone().text());
        assert.deepEqual(coords(), { longitude: 120.5, latitude: 30.5 });
        assert.equal((await call('PUT', '/places/1', owner, { description: '只改描述' })).status, 200);
        assert.deepEqual(coords(), { longitude: 120.5, latitude: 30.5 });

        // 修改申请：两个入口都校验，越界申请不会入库。
        const requestCount = () => sql.prepare('SELECT COUNT(*) AS n FROM PlaceRequest').get().n;
        for (const [url, body] of [
            ['/place-requests', { place_id: 1, proposed: { latitude: 87, longitude: 120 } }],
            ['/places/1/requests', { proposed: { latitude: 30, longitude: 999 } }],
            ['/place-requests', { place_id: 1, proposed: { latitude: null } }]
        ]) {
            const res = await call('POST', url, visitor, body);
            assert.equal(res.status, 400, `${url} ${JSON.stringify(body)}`);
            assert.equal((await res.json()).code, 'INVALID_PLACE_COORDINATE');
        }
        assert.equal(requestCount(), 0);
        const filed = await call('POST', '/place-requests', visitor, { place_id: 1, proposed: { latitude: '31', longitude: 121 } });
        assert.equal(filed.status, 201);
        assert.deepEqual(JSON.parse((await filed.json()).proposed), { latitude: 31, longitude: 121 }, 'stored as numbers');

        // 审核：修复前已提交的越界申请不能被批准，但仍可驳回。
        const legacy = sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, ?, ?, ?)')
            .run(visitor, JSON.stringify({ latitude: 89.5, longitude: 120 }), '').lastInsertRowid;
        const approveLegacy = await call('POST', `/place-requests/${legacy}/review`, admin, { action: 'approve' });
        assert.equal(approveLegacy.status, 400);
        assert.equal((await approveLegacy.json()).code, 'INVALID_PLACE_COORDINATE');
        assert.deepEqual(coords(), { longitude: 120.5, latitude: 30.5 });
        assert.equal(sql.prepare('SELECT status FROM PlaceRequest WHERE id = ?').get(legacy).status, 'pending', 'failed approval rolls back');
        assert.equal((await call('POST', `/place-requests/${legacy}/review`, admin, { action: 'reject' })).status, 200);
        const approve = await call('POST', `/place-requests/${(await (await call('POST', '/place-requests', visitor,
            { place_id: 1, proposed: { latitude: 31, longitude: 121 } })).json()).id}/review`, admin, { action: 'approve' });
        assert.equal(approve.status, 200, await approve.clone().text());
        assert.deepEqual(coords(), { longitude: 121, latitude: 31 });

        // 已有数据检查：只读列出修复前存进库的越界地点和待审核申请。
        const runCheck = () => spawnSync(process.execPath, [path.join(__dirname, '../../scripts/places/check_place_coordinates.js')],
            { cwd: path.join(__dirname, '../..'), env: process.env, encoding: 'utf8' });
        const clean = runCheck();
        assert.equal(clean.status, 0, clean.stdout + clean.stderr);
        assert.match(clean.stdout, /地图无法显示的地点 0 个（共 2 个地点）/);
        const insertPlace = sql.prepare('INSERT INTO Place(id, name, longitude, latitude, creator_id) VALUES(?,?,?,?,?)');
        insertPlace.run(10, '北极店', 120, 89.9, owner);
        insertPlace.run(11, '南极店', 120, -86, owner);
        insertPlace.run(12, '日界线外', 181, 30, owner);
        insertPlace.run(13, '无坐标', null, null, owner);
        const pendingBad = sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, ?, ?, ?)')
            .run(visitor, JSON.stringify({ latitude: 88, longitude: 120 }), '').lastInsertRowid;
        sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, ?, ?, ?)').run(visitor, '{broken', '');
        const before = sql.prepare('SELECT id, latitude, longitude FROM Place ORDER BY id').all();
        const found = collect(sql);
        assert.deepEqual(found.places.map((p) => [p.id, p.error]), [
            [10, '纬度超出有效范围'], [11, '纬度超出有效范围'], [12, '经度超出有效范围'], [13, '纬度必须是有效数字']
        ]);
        assert.equal(found.places[0].creator_name, 'owner');
        assert.deepEqual(found.requests.map((r) => [r.id, r.place_id, r.error]), [[pendingBad, 1, '纬度超出有效范围']],
            'only pending requests with bad coordinates; the rejected legacy one and unparsable payloads are skipped');
        const dirty = runCheck();
        assert.equal(dirty.status, 2, dirty.stdout + dirty.stderr);
        assert.match(dirty.stdout, /地图无法显示的地点 4 个（共 6 个地点）/);
        assert.match(dirty.stdout, /地点 10「北极店」 纬度 89\.9 经度 120/);
        assert.match(dirty.stdout, new RegExp(`申请 ${pendingBad} → 地点 1「测试面馆」 纬度 88`));
        assert.deepEqual(sql.prepare('SELECT id, latitude, longitude FROM Place ORDER BY id').all(), before, 'the check never writes');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        sql.close();
        const resolved = path.resolve(temp);
        if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yuyuko-place-coordinates-')) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
    console.log('place coordinate tests passed: create, edit, modification requests and review stay within the visible map; the read-only check lists existing out-of-map data.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
