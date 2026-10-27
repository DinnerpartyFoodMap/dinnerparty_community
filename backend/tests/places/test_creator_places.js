// 住民创建的地点（GET /users/:id/places，地点卡片点“最近修改”的名字后筛选地图）：最近创建在前、数量上限与 total、
// 审核中的地点只给创建者本人、未知住民 404、无效 token 按游客，以及为屏蔽功能预留的 relation。临时 SQLite + 本地 express。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-creator-places-'));
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', DB_FILE: path.join(temp, 'test.sqlite') });
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const { CREATOR_PLACES_LIMIT } = require('../../modules/places/services/creatorPlaces');
const sql = db._raw;
let server = null;

async function main() {
    init();
    const users = {}, tokens = {};
    for (const name of ['maker', 'other', 'quiet']) {
        users[name] = randomUUID();
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(users[name], name, 'x');
        tokens[name] = jwt.sign({ id: users[name] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const insert = sql.prepare(`INSERT INTO Place (name, latitude, longitude, creator_id, created_time, updated_by, moderation_status)
        VALUES (?, 23.1, 113.3, ?, ?, ?, ?)`);
    const add = (name, creator, created, status = 'visible', updatedBy = null) => Number(insert.run(name, users[creator], created, updatedBy && users[updatedBy], status).lastInsertRowid);
    const oldest = add('老店', 'maker', '2026-01-01 08:00:00', 'visible', 'other');
    const newest = add('新店', 'maker', '2026-03-01 08:00:00');
    const hidden = add('审核中的店', 'maker', '2026-02-01 08:00:00', 'checking');
    add('被驳回的店', 'maker', '2026-02-02 08:00:00', 'rejected');
    add('别人的店', 'other', '2026-04-01 08:00:00');
    sql.prepare("INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at) VALUES (?, ?, 4, 'user', 0, 0)").run(newest, users.other);

    const app = express();
    app.use('/users', require('../../modules/accounts/routes/users'));
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/api', require('../../modules/discovery/routes/search'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (userId, who) => {
        const token = who === 'expired' ? 'not-a-jwt' : tokens[who];
        const res = await fetch(`${base}/users/${encodeURIComponent(userId)}/places`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
        return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
    };

    // 1. 游客与其他住民：只看到公开的地点，最近创建的在前；字段与附近地点相同（创建者 / 修改者名字、评价汇总）
    const guest = await get(users.maker, null);
    assert.equal(guest.status, 200);
    assert.equal(guest.cache, 'no-store');
    assert.deepEqual(guest.body.user, { id: users.maker, username: 'maker' });
    assert.deepEqual(guest.body.places.map((p) => p.id), [newest, oldest]);
    assert.equal(guest.body.total, 2);
    assert.equal(guest.body.limit, CREATOR_PLACES_LIMIT);
    assert.deepEqual(guest.body.relation, { self: false, blocked: false, can_block: false });
    const [first, second] = guest.body.places;
    assert.equal(first.creator_name, 'maker');
    assert.deepEqual([first.rating_count, first.rating_average], [1, 4]);
    assert.equal(second.updated_by_name, 'other', 'the last modifier name comes along');
    assert.deepEqual((await get(users.maker, 'other')).body.places.map((p) => p.id), [newest, oldest]);
    assert.deepEqual((await get(users.maker, 'expired')).body.places.map((p) => p.id), [newest, oldest], 'an invalid token falls back to guest');

    // 2. 创建者本人：连同自己审核中 / 被驳回的地点，relation.self 为真
    const own = await get(users.maker, 'maker');
    assert.equal(own.body.total, 4);
    assert.deepEqual(own.body.places.map((p) => p.name), ['新店', '被驳回的店', '审核中的店', '老店']);
    assert.ok(own.body.places.some((p) => p.id === hidden && p.moderation_status === 'checking'));
    assert.deepEqual(own.body.relation, { self: true, blocked: false, can_block: false });

    // 3. 没有创建过地点的住民：空列表；不存在的住民（含已注销）：404
    const quiet = await get(users.quiet, 'other');
    assert.deepEqual([quiet.status, quiet.body.places, quiet.body.total], [200, [], 0]);
    assert.equal((await get(randomUUID(), null)).status, 404);
    assert.equal((await get('me', 'maker')).status, 404, 'no /me alias');

    // 4. 数量上限：只返回最近的 limit 个，total 是全部可见数量
    const many = sql.transaction(() => {
        for (let i = 0; i < CREATOR_PLACES_LIMIT + 5; i += 1) {
            add(`批量 ${i}`, 'other', `2025-06-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
        }
    });
    many();
    const capped = (await get(users.other, null)).body;
    assert.equal(capped.places.length, CREATOR_PLACES_LIMIT);
    assert.equal(capped.total, CREATOR_PLACES_LIMIT + 6);
    assert.equal(capped.places[0].name, '别人的店');
    assert.equal(capped.places[1].name, `批量 ${CREATOR_PLACES_LIMIT + 4}`);

    // 5. 屏蔽：只影响屏蔽者自己。列表仍可打开（解除屏蔽用）但不列出地点；附近、全部地点和快速搜索都不再有 TA 创建的地点
    const send = async (method, userId, who) => {
        const res = await fetch(`${base}/users/${encodeURIComponent(userId)}/block`, { method, headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} });
        return { status: res.status, body: await res.json() };
    };
    const nearby = async (who) => (await (await fetch(`${base}/places/nearby?minLng=113&minLat=23&maxLng=114&maxLat=24`,
        tokens[who] ? { headers: { Authorization: `Bearer ${tokens[who]}` } } : {})).json()).map((p) => p.id);
    const searchIds = async (who) => (await (await fetch(`${base}/api/places/search/fast?q=${encodeURIComponent('新店')}`,
        tokens[who] ? { headers: { Authorization: `Bearer ${tokens[who]}` } } : {})).json()).map((p) => p.id);
    assert.equal((await send('POST', users.maker, null)).status, 401);
    assert.equal((await send('POST', users.other, 'other')).status, 400, 'cannot block yourself');
    assert.equal((await send('POST', randomUUID(), 'other')).status, 404);
    assert.ok((await nearby('other')).includes(newest));
    assert.ok((await searchIds('other')).includes(newest));
    const blocked = await send('POST', users.maker, 'other');
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.body.relation, { self: false, blocked: true, can_block: true });
    assert.equal((await send('POST', users.maker, 'other')).status, 200, 'blocking twice is harmless');
    const hiddenList = (await get(users.maker, 'other')).body;
    assert.deepEqual([hiddenList.relation.blocked, hiddenList.places, hiddenList.total], [true, [], 0]);
    assert.ok(!(await nearby('other')).includes(newest));
    assert.ok(!(await nearby('other')).includes(oldest), 'places created by the blocked resident, even if last edited by someone else');
    assert.ok(!(await searchIds('other')).includes(newest));
    const all = await (await fetch(`${base}/places`, { headers: { Authorization: `Bearer ${tokens.other}` } })).json();
    assert.ok(!all.some((p) => p.creator_id === users.maker));
    assert.ok((await nearby(null)).includes(newest), 'guests are not affected');
    assert.ok((await nearby('quiet')).includes(newest), 'other residents are not affected');
    assert.deepEqual((await get(users.maker, 'maker')).body.places.length, 4, 'the blocked resident still sees their own places');
    const unblocked = await send('DELETE', users.maker, 'other');
    assert.deepEqual(unblocked.body.relation, { self: false, blocked: false, can_block: true });
    assert.ok((await nearby('other')).includes(newest));
    assert.equal((await get(users.maker, 'other')).body.total, 2);
    // 注销账号时屏蔽记录随之删除
    await send('POST', users.maker, 'other');
    sql.prepare('DELETE FROM User WHERE id = ?').run(users.maker);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM UserBlock').get().n, 0);

    console.log('creator places tests passed: newest first, visibility for others vs. the creator, empty and unknown users, cap and total, blocking (list, nearby, all places, fast search, unblock, cascade).');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    if (server) { server.closeAllConnections(); server.close(); }
    try { db._raw.close(); } catch (_) { }
    fs.rmSync(temp, { recursive: true, force: true });
});
