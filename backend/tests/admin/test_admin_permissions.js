const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-admin-permissions-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
require.cache[require.resolve('../../modules/preferences/services/placeVectorService')] = {
    exports: { queuePlaceVectorSync() {}, deletePlaceVector() {} }
};
const { db, init } = require('../../infrastructure/database');
const { requireAuth } = require('../../modules/accounts/middleware/auth');
let server;

async function main() {
    init();
    const ids = {}, tokens = {};
    function addUser(name, level = null) {
        const id = randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)')
            .run(id, name, 'unused', level);
        return id;
    }
    for (const level of ['YUYUKO', 'YOUMU', 'KOMACHI', 'regular']) {
        ids[level] = addUser(level, level === 'regular' ? null : level);
        tokens[level] = jwt.sign({ id: ids[level] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const target = addUser('ban-target');
    const app = express();
    app.use(express.json());
    for (const [url, file] of [
        ['users', 'adminUsers'], ['general-users', 'adminGeneralUsers'], ['audit', 'adminAudit'],
        ['skin-codes', 'adminSkinCodes'], ['qq-whitelist', 'adminQQWhitelist'],
        ['notices', 'adminNotices'], ['comments', 'adminComments'], ['exhibitions', 'adminExhibitions']
    ]) app.use(`/admin/${url}`, requireAuth, require(`../../modules/admin/routes/${file}`));
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, who) {
        const response = await fetch(base + url, { method, headers: {
            'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {})
        }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
    }
    const levels = ['YUYUKO', 'YOUMU', 'KOMACHI', 'regular', undefined];
    for (const [url, allowed] of [
        ['/admin/audit', ['YUYUKO', 'YOUMU', 'KOMACHI']],
        ['/place-requests', ['YUYUKO', 'YOUMU', 'KOMACHI']],
        ['/admin/skin-codes', ['YUYUKO']],
        ['/admin/users', ['YUYUKO']],
        ['/admin/general-users', ['YOUMU', 'KOMACHI']],
        ['/admin/qq-whitelist', ['YUYUKO', 'YOUMU']],
        ['/admin/notices', ['YUYUKO', 'YOUMU']],
        ['/admin/exhibitions/current', ['YUYUKO', 'YOUMU']],
        ['/admin/comments', ['YUYUKO', 'YOUMU', 'KOMACHI']]
    ]) {
        for (const who of levels) {
            assert.equal((await request(url, 'GET', null, who)).status,
                allowed.includes(who) ? 200 : who ? 403 : 401, `${who || 'guest'} GET ${url}`);
        }
    }

    // YOUMU can ban ordinary users without gaining administrator management.
    for (const who of ['KOMACHI', 'regular', undefined]) {
        for (const action of ['ban', 'unban']) {
            assert.equal((await request(`/admin/users/${action}`, 'POST', { userId: target }, who)).status,
                who ? 403 : 401);
        }
    }
    assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(target).is_banned, 0);
    assert.equal((await request('/admin/users/ban', 'POST', { userId: target, reason: 'test', durationDays: 7 }, 'YOUMU')).status, 200);
    const banned = db._raw.prepare('SELECT is_banned, ban_reason, ban_expires FROM User WHERE id = ?').get(target);
    assert.equal(banned.is_banned, 1);
    assert.equal(banned.ban_reason, 'test');
    assert.ok(Date.parse(banned.ban_expires) > Date.now());
    const general = (await request('/admin/general-users', 'GET', null, 'YOUMU')).body.find(row => row.id === target);
    assert.equal(general.is_banned, 1, 'ordinary-user panel receives ban state');
    assert.equal((await request('/admin/users/unban', 'POST', { userId: target }, 'YOUMU')).status, 200);
    assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(target).is_banned, 0);
    for (const userId of [ids.YUYUKO, ids.YOUMU, ids.KOMACHI]) {
        for (const action of ['ban', 'unban']) {
            assert.equal((await request(`/admin/users/${action}`, 'POST', { userId }, 'YOUMU')).status, 403,
                `YOUMU cannot ${action} administrators`);
        }
    }
    for (const who of ['YOUMU', 'KOMACHI']) {
        assert.equal((await request('/admin/users/set-level', 'POST', { userId: target, admin_level: 'YUYUKO' }, who)).status, 403);
        assert.equal((await request(`/admin/users/${target}`, 'DELETE', null, who)).status, 403);
        assert.equal((await request(`/admin/general-users/${ids.YUYUKO}`, 'DELETE', null, who)).status, 403);
        for (const [method, url, body] of [
            ['POST', '/admin/skin-codes', { skin_id: 'sakura' }], ['DELETE', '/admin/skin-codes/1', null]
        ]) assert.equal((await request(url, method, body, who)).status, 403);
        const disposable = addUser(`delete-by-${who}`);
        assert.equal((await request(`/admin/general-users/${disposable}`, 'DELETE', null, who)).status, 200);
    }
    // Ban state and audit must roll back together.
    db._raw.exec("CREATE TRIGGER fail_ban_audit BEFORE INSERT ON AdminAudit WHEN NEW.action = 'ban-user' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await request('/admin/users/ban', 'POST', { userId: target }, 'YOUMU')).status, 500);
    assert.equal(db._raw.prepare('SELECT is_banned FROM User WHERE id = ?').get(target).is_banned, 0);
    db._raw.exec('DROP TRIGGER fail_ban_audit');
    assert.equal((await request('/admin/users/ban', 'POST', { userId: target }, 'YUYUKO')).status, 200);
    assert.equal((await request('/admin/users/unban', 'POST', { userId: target }, 'YUYUKO')).status, 200);

    for (const who of levels) {
        const placeId = Number(db._raw.prepare('INSERT INTO Place (name, creator_id) VALUES (?, ?)')
            .run('original', target).lastInsertRowid);
        const expected = !who ? 401 : who === 'regular' ? 403 : 200;
        // Use a non-semantic update so the test never starts vector workers.
        assert.equal((await request(`/places/${placeId}`, 'PUT', { latitude: 23, longitude: 113 }, who)).status, expected);
        const proposal = await request('/place-requests', 'POST', { place_id: placeId, proposed: { latitude: 24, longitude: 114 } }, 'regular');
        assert.equal(proposal.status, 201);
        assert.equal((await request(`/place-requests/${proposal.body.id}/review`, 'POST', { action: 'approve' }, who)).status, expected);
        const place = db._raw.prepare('SELECT latitude FROM Place WHERE id = ?').get(placeId);
        assert.equal(place.latitude, expected === 200 ? 24 : null);
        assert.equal((await request(`/places/${placeId}`, 'DELETE', null, who)).status, expected);
        assert.equal(!!db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId), expected !== 200);
    }
    const actions = (await request('/admin/audit', 'GET', null, 'KOMACHI')).body;
    assert.ok(actions.some(row => row.action === 'ban-user' && row.admin_id === ids.YOUMU));
    // The same token must immediately lose permissions when its database role changes.
    db._raw.prepare('UPDATE User SET admin_level = NULL WHERE id = ?').run(ids.KOMACHI);
    assert.equal((await request('/admin/audit', 'GET', null, 'KOMACHI')).status, 403);
    console.log('Admin permissions passed: role matrix, bans, target protection, place review/edit/delete, skin restrictions, unchanged access and audit rollback.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
