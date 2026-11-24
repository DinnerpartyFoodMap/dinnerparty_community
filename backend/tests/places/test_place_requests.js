// 修改申请：同一住民对同一地点只保留最新一条待审修改；批准后卡片的「最近修改」记成申请人；
// 申请不能改所有者（creator_id）或最近修改人 / 时间。临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-requests-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    PLACE_MODERATION_ENABLED: 'false'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;

(async () => {
    init();
    const owner = randomUUID(), visitor = randomUUID(), other = randomUUID(), admin = randomUUID();
    for (const [id, name, level] of [[owner, 'owner', null], [visitor, 'visitor', null], [other, 'other', null], [admin, 'admin', 'YUYUKO']]) {
        sql.prepare('INSERT INTO User(id, username, password, admin_level) VALUES(?,?,?,?)').run(id, name, 'unused', level);
    }
    sql.prepare(`INSERT INTO Place(id, name, longitude, latitude, creator_id, updated_by, updated_time)
        VALUES(1, '测试面馆', 120, 30, ?, ?, '2000-01-01 00:00:00')`).run(owner, owner);
    const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, user, body) => fetch(`${base}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` },
        body: JSON.stringify({ ...body, no_experience: true })
    });
    const file = async (user, proposed, url = '/place-requests') => {
        const res = await call('POST', url, user, url === '/place-requests' ? { place_id: 1, proposed } : { proposed });
        assert.equal(res.status, 201, await res.clone().text());
        return res.json();
    };
    const review = (id, action) => call('POST', `/place-requests/${id}/review`, admin, { action });
    const status = (id) => sql.prepare('SELECT status FROM PlaceRequest WHERE id = ?').get(id).status;
    const place = () => sql.prepare('SELECT * FROM Place WHERE id = 1').get();
    try {
        // 申请不能改所有者和最近修改人：只有这些字段时拒绝，夹带时剔除
        const ownerOnly = await call('POST', '/place-requests', visitor, { place_id: 1, proposed: { creator_id: visitor, updated_by: visitor } });
        assert.equal(ownerOnly.status, 400);
        assert.equal((await ownerOnly.json()).code, 'EMPTY_PLACE_REQUEST');

        // 同一住民连续提交：之前未审的标成 superseded，只留最新一条；两个提交入口共用此规则
        const first = await file(visitor, { name: '改名一' });
        const second = await file(visitor, { description: '第二次：招牌菜、人均和营业时间都写了' }, '/places/1/requests');
        const third = await file(visitor, { name: '改名三', creator_id: visitor, updated_by: visitor, updated_time: '2099-01-01' });
        assert.equal(status(first.id), 'superseded');
        assert.equal(status(second.id), 'superseded');
        assert.equal(status(third.id), 'pending');
        assert.deepEqual(JSON.parse(third.proposed), { name: '改名三' }, 'owner / modifier fields stripped on filing');
        const audit = sql.prepare("SELECT details FROM AdminAudit WHERE action = 'place-request-created' ORDER BY id DESC LIMIT 1").get();
        assert.deepEqual(JSON.parse(audit.details).superseded_request_ids, [second.id]);

        // 其他住民的申请、新增复核和打卡申请不受影响
        const fromOther = await file(other, { description: '别人的修改：招牌菜、人均和营业时间都写了' });
        const checkIn = Number(sql.prepare(`INSERT INTO PlaceRequest (place_id, requester_id, proposed, note, request_type)
            VALUES (1, ?, '{}', '', 'check_in')`).run(visitor).lastInsertRowid);
        await file(visitor, { name: '改名四' });
        assert.equal(status(fromOther.id), 'pending');
        assert.equal(status(checkIn), 'pending');
        assert.equal(status(third.id), 'superseded');
        const latest = sql.prepare("SELECT * FROM PlaceRequest WHERE requester_id = ? AND status = 'pending' AND request_type = 'modify'").all(visitor);
        assert.equal(latest.length, 1);

        // 被取代的申请不能再审
        const stale = await review(first.id, 'approve');
        assert.equal(stale.status, 409);
        assert.equal(place().name, '测试面馆');

        // 批准：内容生效，所有者不变，最近修改人 / 时间记成申请人
        assert.equal((await review(latest[0].id, 'approve')).status, 200);
        let row = place();
        assert.equal(row.name, '改名四');
        assert.equal(row.creator_id, owner);
        assert.equal(row.updated_by, visitor);
        assert.notEqual(row.updated_time, '2000-01-01 00:00:00');
        assert.equal((await review(fromOther.id, 'approve')).status, 200);
        assert.equal(place().updated_by, other);

        // 修复前入库、夹带所有者字段的旧申请：批准时忽略这些字段，只剩它们时不能批准
        const legacy = Number(sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, ?, ?, ?)')
            .run(visitor, JSON.stringify({ name: '旧申请', creator_id: visitor, updated_by: admin }), '').lastInsertRowid);
        assert.equal((await review(legacy, 'approve')).status, 200);
        row = place();
        assert.equal(row.name, '旧申请');
        assert.equal(row.creator_id, owner);
        assert.equal(row.updated_by, visitor);
        const legacyOwner = Number(sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, ?, ?, ?)')
            .run(visitor, JSON.stringify({ creator_id: visitor }), '').lastInsertRowid);
        const refused = await review(legacyOwner, 'approve');
        assert.equal(refused.status, 400);
        assert.equal((await refused.json()).code, 'EMPTY_PLACE_REQUEST');
        assert.equal(place().creator_id, owner);

        // 申请人账号已删除（requester_id 为空）时保留原最近修改人
        const orphan = Number(sql.prepare('INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (1, NULL, ?, ?)')
            .run(JSON.stringify({ name: '无主申请' }), '').lastInsertRowid);
        assert.equal((await review(orphan, 'approve')).status, 200);
        assert.equal(place().name, '无主申请');
        assert.equal(place().updated_by, visitor);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        sql.close();
        const resolved = path.resolve(temp);
        if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yuyuko-place-requests-')) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
    console.log('place request tests passed: one pending modification per resident and place, approval records the requester as last modifier, requests cannot change the owner.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
