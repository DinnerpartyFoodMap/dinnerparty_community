const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-favorite-collection-'));
Object.assign(process.env, { DB_FILE: path.join(directory, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' });
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
let server;

async function main() {
    init();
    const insertUser = sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)');
    const owner = randomUUID(), guest = randomUUID(), other = randomUUID();
    insertUser.run(owner, '收藏住民', 'unused');
    insertUser.run(guest, '访问住民', 'unused');
    insertUser.run(other, '其他访问住民', 'unused');
    const place = sql.prepare("INSERT INTO Place(id,name,creator_id,moderation_status,category) VALUES(?,?,?,?,'甜品店')");
    place.run(1, '公开地点', owner, 'visible');
    place.run(2, '审核中地点', owner, 'checking');
    place.run(3, '其他住民创建的地点', guest, 'visible');
    place.run(4, '访问住民尚未通过审核的地点', guest, 'checking');
    const add = sql.prepare('INSERT INTO Favorite(user_id,place_id) VALUES(?,?)');
    add.run(owner, 1);
    add.run(owner, 2);
    add.run(owner, 3);
    add.run(owner, 4);
    sql.exec('ALTER TABLE User DROP COLUMN favorites_public');
    init();

    const app = express();
    app.use(express.json());
    app.use('/users', require('../../modules/accounts/routes/users'));
    app.use('/api/favorites', require('../../modules/preferences/routes/favorites'));
    app.use('/api/community', require('../../modules/community/routes/community'));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    async function call(url, user, method = 'GET', body) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET || 'yuyuko_secret_key')}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
    }
    const favoritesUrl = `/users/${owner}/favorites`;
    const profileUrl = `/users/${owner}/profile`;
    const visibilityUrl = '/api/favorites/visibility';
    const ids = (places) => places.map((item) => item.id);
    const publicList = await call(favoritesUrl);
    assert.equal(publicList.status, 200, 'anonymous viewers can read migrated public favorites');
    assert.equal(publicList.cache, 'no-store');
    assert.deepEqual(ids(publicList.data.places), [3, 1], 'anonymous viewers cannot see unreviewed places');
    assert.deepEqual(ids((await call(favoritesUrl, owner)).data.places), [3, 2, 1]);

    const profile = (await call(profileUrl)).data;
    assert.deepEqual(profile.widgets, ['collection', 'recent']);
    assert.deepEqual(profile.hidden_widgets, [], 'legacy profiles show both location sections by default');
    assert.ok(Array.isArray(profile.content.recent) && Array.isArray(profile.content.favorite));
    assert.deepEqual(ids(profile.content.recent), [1], 'visitors see only public created places');
    assert.deepEqual(ids((await call(profileUrl, owner)).data.content.recent), [2, 1], 'the owner preview includes the same pending places as the map list');
    const widgetSettingsUrl = '/users/me/profile';
    assert.equal((await call(widgetSettingsUrl, owner, 'PUT', { widgets: profile.widgets, hidden_widgets: ['recent', 'collection'] })).status, 400);
    assert.equal((await call(widgetSettingsUrl, owner, 'PUT', { widgets: profile.widgets, hidden_widgets: ['recent'] })).status, 200);
    assert.equal((await call(widgetSettingsUrl, owner, 'PUT', { widgets: ['collection', 'favorite'] })).status, 200);
    const adjusted = (await call(profileUrl)).data;
    assert.deepEqual(adjusted.widgets, ['collection', 'favorite']);
    assert.deepEqual(adjusted.hidden_widgets, ['recent'], 'old clients preserve the visibility preference');
    assert.equal(adjusted.content.recent, undefined, 'hidden widget contents are omitted for visitors');
    assert.deepEqual(ids(profile.content.collection[0].places), [3, 1]);
    assert.equal(profile.collection_visibility, undefined);
    assert.equal((await call(profileUrl, owner)).data.collection_visibility, true);
    assert.equal((await call(visibilityUrl, owner)).data.is_public, true);
    assert.equal((await call(visibilityUrl, null, 'PUT', { is_public: false })).status, 401);
    assert.equal((await call(visibilityUrl, owner, 'PUT', { is_public: 'false' })).status, 400);

    const legacy = await call('/api/community/collections', owner, 'POST', { title: '旧公开合集' });
    const legacyUrl = `/api/community/collections/${legacy.data.id}`;
    const publicLegacy = `/api/community/users/${owner}/collections`;
    const publishLegacy = () => call(legacyUrl, owner, 'PUT', { title: '旧公开合集', is_public: true, place_ids: [1, 2, 3, 4] });
    const savedLegacy = await publishLegacy();
    assert.equal(savedLegacy.status, 200);
    assert.deepEqual(ids(savedLegacy.data.places).sort(), [1, 2, 3], 'legacy owners can still manage their own pending places');
    assert.deepEqual(ids((await call(publicLegacy, guest)).data.collections[0].places).sort(), [1, 3], 'legacy visitors cannot see pending places they created');
    sql.prepare('INSERT INTO UserBlock(user_id,blocked_id) VALUES(?,?)').run(other, guest);
    assert.deepEqual(ids((await call(publicLegacy, other)).data.collections[0].places), [1], 'legacy public reads also filter blocked place creators');

    assert.deepEqual((await call(visibilityUrl, owner, 'PUT', { is_public: false })).data, { is_public: false });
    init();
    assert.equal((await call(favoritesUrl)).status, 404);
    assert.deepEqual((await call(profileUrl, guest)).data.content.collection, []);
    assert.equal((await call(profileUrl, owner)).data.collection_visibility, false);
    assert.deepEqual(ids((await call(favoritesUrl, owner)).data.places), [3, 2, 1]);
    const privateVisitorTaste = (await call(profileUrl, guest)).data.taste.find((axis) => axis.key === 'dessert');
    assert.deepEqual(privateVisitorTaste.places, [], 'favorite-only taste evidence cannot disclose the private collection');
    assert.equal(privateVisitorTaste.favorite_count, 0);
    assert.equal((await publishLegacy()).status, 200);
    assert.deepEqual((await call(publicLegacy, guest)).data.collections, [], 'a legacy client cannot republish hidden favorites');

    assert.equal((await call(visibilityUrl, owner, 'PUT', { is_public: true })).status, 200);
    sql.prepare('UPDATE MapConsent SET discovery=0 WHERE user_id=?').run(owner);
    assert.equal((await call(favoritesUrl)).status, 200, 'collection access and matching consent are independent');
    sql.prepare('INSERT INTO UserBlock(user_id,blocked_id) VALUES(?,?)').run(guest, owner);
    assert.equal((await call(favoritesUrl, guest)).status, 404);
    assert.deepEqual((await call(profileUrl, guest)).data.content, {});
    sql.prepare('UPDATE User SET is_banned=1 WHERE id=?').run(owner);
    assert.equal((await call(favoritesUrl)).status, 404);
    console.log('Favorite collection tests passed (migration, anonymous access, toggle, review, block, and legacy API).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    sql.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
