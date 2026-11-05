// 地点列表（GET /places/list）与住民主页（GET /users/:id/profile 等）：列表不带经纬度 / 地址 / 距离，
// 按收缩后的综合评价排序，标签（任一）/ 人均 / 距离筛选；主页的六类偏好、小组件与被驳回地点数。临时 SQLite + 本地 express。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-list-'));
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', DB_FILE: path.join(temp, 'test.sqlite'), AMAP_WEB_SERVICE_KEY: '' });
// This file covers the retained legacy policy. Active bootstrap behavior is
// covered by ratings/test_bootstrap_product.js with the deployed model pack.
Object.assign(process.env,{RATING_ESTIMATE_MODE:'off',RATING_PREDICTION_MODE:'off',RATING_LIST_RANK_MODE:'off'});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
let server = null;

async function main() {
    init();
    const users = {}, tokens = {};
    for (const name of ['maker', 'fan', 'other']) {
        users[name] = randomUUID();
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(users[name], name, 'x');
        tokens[name] = jwt.sign({ id: users[name] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const insert = sql.prepare(`INSERT INTO Place (name, description, category, per_person_cost, latitude, longitude, address, exterior_images, creator_id, created_time, moderation_status)
        VALUES (?, ?, ?, ?, ?, ?, '某路 1 号', ?, ?, ?, ?)`);
    const add = (name, { category = '', cost = null, lat = 23.13, lng = 113.26, images = null, creator = 'maker', created = '2026-01-01 08:00:00', status = 'visible' } = {}) =>
        Number(insert.run(name, `**${name}** 的简介`, category, cost, lat, lng, images && JSON.stringify(images), users[creator], created, status).lastInsertRowid);
    const popular = add('人气火锅', { category: '火锅店', cost: 80, images: ['https://cdn.example.com/a.jpg'] });
    const single = add('一人好评', { category: '甜品店', cost: 30, created: '2026-02-01 08:00:00' });
    const unrated = add('没人评价', { category: '面馆', created: '2026-03-01 08:00:00' });
    const disliked = add('踩雷店', { category: '烧烤', cost: 60, lat: 23.5, lng: 113.6 });
    const hidden = add('审核中', { category: '火锅店', status: 'checking' });
    const rejected = add('被驳回', { category: '火锅店', status: 'rejected' });
    const rate = sql.prepare("INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)");
    for (const who of ['maker', 'fan', 'other']) rate.run(popular, users[who], 4, who === 'maker' ? 'create' : 'user');
    rate.run(single, users.fan, 4, 'user');
    rate.run(disliked, users.fan, 1, 'user');
    rate.run(disliked, users.other, 2, 'user');
    for (const row of sql.prepare("SELECT * FROM PlaceRating WHERE source='user'").all()) {
        require('../../modules/ratings/services/ratingHistory').appendRatingRevision({userId:row.user_id,placeId:row.place_id,before:null,after:{score:row.score},action:'rate',origin:'active'});
    }
    sql.prepare('INSERT INTO Favorite (user_id, place_id) VALUES (?, ?)').run(users.fan, single);

    const app = express();
    app.use(express.json());
    app.use('/users', require('../../modules/accounts/routes/users'));
    app.use('/places', require('../../modules/places/routes/places'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (pathname, { who, method = 'GET', body } = {}) => {
        const headers = { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
        const res = await fetch(`${base}${pathname}`, { method, headers, body: body && JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };

    // 1. 列表只给公开地点；条目不带经纬度、地址和距离；排序：3 人好评 > 1 人好评（向均线收缩）> 没人评价 > 差评
    const list = await call('/places/list?limit=30');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item) => item.id), [popular, single, unrated, disliked]);
    assert.equal(list.body.total, 4);
    for (const item of list.body.items) {
        for (const key of ['latitude', 'longitude', 'address', 'distance', 'distance_km', 'creator_id']) assert.equal(key in item, false, `${key} must not be listed`);
    }
    assert.equal(list.body.items[0].image, 'https://cdn.example.com/a.jpg');
    assert.equal(list.body.items[0].rating_count, 3);
    assert.ok(list.body.items.find((item) => item.id === hidden) === undefined && !list.body.items.some((item) => item.id === rejected));

    // 2. 标签命中任一；设了人均范围时没填人均的地点不显示
    const tagged = await call(`/places/list?tags=${encodeURIComponent('火锅店,面馆')}`);
    assert.deepEqual(tagged.body.items.map((item) => item.id), [popular, unrated]);
    const cheap = await call('/places/list?maxCost=50');
    assert.deepEqual(cheap.body.items.map((item) => item.id), [single]);
    const swapped = await call('/places/list?minCost=70&maxCost=50');
    assert.deepEqual(swapped.body.items.map((item) => item.id), [disliked], 'min > max is swapped (50–70)');

    // 3. 距离：只接受几档半径；中心附近 3 公里内不含远处的店，无效半径不筛选
    const near = await call('/places/list?lat=23.13&lng=113.26&radiusKm=3');
    assert.deepEqual(near.body.items.map((item) => item.id).sort(), [popular, single, unrated].sort());
    const badRadius = await call('/places/list?lat=23.13&lng=113.26&radiusKm=4');
    assert.equal(badRadius.body.total, 4);

    // 4. 分页
    const page = await call('/places/list?offset=1&limit=2');
    assert.deepEqual(page.body.items.map((item) => item.id), [single, unrated]);
    const first = await call('/places/list?limit=2', { who: 'fan' });
    assert.equal(typeof first.body.snapshot, 'string');
    const nextUrl = `/places/list?offset=2&limit=2&snapshot=${encodeURIComponent(first.body.snapshot)}`;
    const numeric = require('../../infrastructure/numericAlgorithmClient'), compute = numeric.compute;
    let next;
    numeric.compute = async (operation, ...args) => {
        assert.notEqual(operation, 'ratingsort', 'continuation must never rerank');
        return compute(operation, ...args);
    };
    try {
        next = await call(nextUrl, { who: 'fan' });
        assert.equal(next.status, 200);
        assert.deepEqual((await call(nextUrl, { who: 'fan' })).body, next.body, 'repeated pages reuse frozen rows and scores');
    } finally { numeric.compute = compute; }
    assert.equal(new Set([...first.body.items, ...next.body.items].map(item => item.id)).size, 4);
    const beforeDerived = sql.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision;
    sql.prepare(`INSERT INTO PlaceModelProfile(place_id,model_hash,input_hash,schema_version,status,assets,updated_at) VALUES(?,'background','input',1,'ready','{}',0)`).run(popular);
    sql.prepare('UPDATE RatingTextClock SET revision=revision+1 WHERE id=1').run();
    sql.prepare('UPDATE Place SET vector_updated_at=123 WHERE id=?').run(popular);
    sql.prepare("UPDATE User SET username='fan-renamed' WHERE id=?").run(users.fan);
    assert.ok(sql.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision>beforeDerived);
    assert.deepEqual((await call(nextUrl, { who: 'fan' })).body, next.body,'background profiles, text judgments, vector refresh and unrelated account writes keep the frozen ranking');
    sql.prepare("UPDATE User SET username='fan' WHERE id=?").run(users.fan);
    assert.equal((await call(nextUrl, { who: 'other' })).status, 409, 'snapshot belongs to its viewer');
    assert.equal((await call(`${nextUrl}&maxCost=50`, { who: 'fan' })).status, 409, 'snapshot belongs to its filters');
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 121000;
        assert.equal((await call(nextUrl, { who: 'fan' })).status, 409, 'expired snapshot requires restart');
    } finally { Date.now = realNow; }
    const revoked = await call('/places/list?limit=2');
    sql.prepare("UPDATE Place SET moderation_status='checking' WHERE id=?").run(disliked);
    assert.equal((await call(`/places/list?offset=2&snapshot=${revoked.body.snapshot}`)).status, 409, 'visibility revoked after page one invalidates snapshot');
    sql.prepare("UPDATE Place SET moderation_status='visible' WHERE id=?").run(disliked);
    const blocked = await call('/places/list?limit=2', { who: 'fan' });
    sql.prepare('INSERT INTO UserBlock(user_id, blocked_id) VALUES (?, ?)').run(users.fan, users.maker);
    assert.equal((await call(`/places/list?offset=2&snapshot=${blocked.body.snapshot}`, { who: 'fan' })).status, 409, 'new viewer block invalidates cached candidates');
    sql.prepare('DELETE FROM UserBlock WHERE user_id=?').run(users.fan);
    const changed = await call('/places/list?limit=2');
    sql.prepare('UPDATE PlaceRating SET score=3 WHERE place_id=? AND user_id=?').run(single, users.fan);
    assert.equal((await call(`/places/list?offset=2&snapshot=${changed.body.snapshot}`)).status, 409, 'rating revision requires a fresh snapshot');
    sql.prepare('UPDATE PlaceRating SET score=4 WHERE place_id=? AND user_id=?').run(single, users.fan);

    // 5. 住民主页：结构、六类偏好（创建时的评价不算；没有依据的轴为 null）、小组件默认值与内容
    const profile = await call(`/users/${users.fan}/profile`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.username, 'fan');
    assert.equal(profile.body.taste.length, 6);
    const axis = (body, key) => body.taste.find((item) => item.key === key);
    assert.equal(axis(profile.body, 'hotpotBbq').basis, 'evidence', '火锅店 + 烧烤都在火锅烧烤');
    assert.equal(axis(profile.body, 'hotpotBbq').store_count, 2);
    assert.equal(axis(profile.body, 'hotpotBbq').positive_count, 1);
    assert.equal(axis(profile.body, 'hotpotBbq').negative_count, 1);
    assert.equal(axis(profile.body, 'drinks').value, null, '没有依据时是待了解，不是 0');
    assert.equal(axis(profile.body, 'drinks').basis, null);
    const makerProfile = await call(`/users/${users.maker}/profile`);
    assert.ok(makerProfile.body.taste.some((item) => item.store_count > 0), 'persisted default ratings continue to inform preferences');
    assert.deepEqual(profile.body.widgets, ['recent', 'favorite']);
    // 最近创建在前（同一时间按 id 倒序），审核中 / 被驳回的不列
    assert.deepEqual(makerProfile.body.content.recent.map((item) => item.id), [unrated, single, disliked, popular]);
    assert.ok(!makerProfile.body.content.recent.some((item) => item.id === hidden || item.id === rejected), 'hidden places stay off the profile');
    assert.ok(!('latitude' in makerProfile.body.content.recent[0]));
    // 最喜欢：自己评“均线之上”及以上的（踩雷店评了强烈拒绝，不算）；同分同时间按 id 倒序
    assert.deepEqual(profile.body.content.favorite.map((item) => item.id), [single, popular], 'only places rated 3+ by them');
    assert.equal(profile.body.city, null);
    assert.equal((await call('/users/nobody/profile')).status, 404);

    // 6. 小组件与自己填的喜好
    assert.equal((await call('/users/me/profile', { who: 'fan', method: 'PUT', body: { widgets: ['collection', 'bad'] } })).status, 400);
    assert.deepEqual((await call('/users/me/profile', { who: 'fan', method: 'PUT', body: { widgets: ['collection', 'recent'] } })).body.widgets, ['collection', 'recent']);
    assert.deepEqual((await call(`/users/${users.fan}/profile`)).body.widgets, ['collection', 'recent']);
    const selfSet = await call('/users/me/taste', { who: 'fan', method: 'PUT', body: { axis: 'drinks', level: 4 } });
    assert.equal(axis(selfSet.body, 'drinks').basis, 'self');
    assert.equal(axis(selfSet.body, 'drinks').value, 1);
    const cleared = await call('/users/me/taste', { who: 'fan', method: 'PUT', body: { axis: 'drinks', level: null } });
    assert.equal(axis(cleared.body, 'drinks').value, null);
    assert.equal((await call('/users/me/taste', { who: 'fan', method: 'PUT', body: { axis: 'nope', level: 3 } })).status, 400);

    // 7. 被驳回的地点数（头像小红点）
    assert.equal((await call('/users/me', { who: 'maker' })).body.user.rejected_place_count, 1);
    assert.equal((await call('/users/me', { who: 'fan' })).body.user.rejected_place_count, 0);

    console.log('Place list and profile tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    server?.close();
    try { db._raw.close(); } catch { /* 已关闭 */ }
    fs.rmSync(temp, { recursive: true, force: true });
});
