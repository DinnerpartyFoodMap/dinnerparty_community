const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-exhibitions-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
let server;

async function main() {
    init();
    init(); // Existing databases can initialize again without losing publications.
    const users = {};
    for (const level of ['YUYUKO', 'YOUMU', 'KOMACHI', 'regular']) {
        const id = randomUUID();
        db._raw.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)')
            .run(id, level, 'unused', level === 'regular' ? null : level);
        users[level] = jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const app = express();
    app.use(express.json());
    app.use('/exhibitions', require('../../modules/community/routes/exhibitions'));
    app.use('/admin/exhibitions', require('../../modules/accounts/middleware/auth').requireAuth,
        require('../../modules/admin/routes/adminExhibitions'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, level) {
        const res = await fetch(base + url, { method, headers: {
            'Content-Type': 'application/json', ...(level ? { Authorization: `Bearer ${users[level]}` } : {})
        }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json() };
    }
    const publication = { name: '  秋日展会  ', description: '展会简介\n第二行', information: '上海 · 10月', icon_url: '' };
    assert.deepEqual((await request('/exhibitions/current')).body, { exhibition: null });
    for (const [level, status] of [[undefined, 401], ['regular', 403], ['KOMACHI', 403]]) {
        assert.equal((await request('/admin/exhibitions', 'POST', publication, level)).status, status);
        assert.equal((await request('/admin/exhibitions/current', 'DELETE', null, level)).status, status);
    }
    for (const bad of [{ name: ' ' }, { description: '' }, { information: '' }, { name: 'x'.repeat(81) },
        { icon_url: 'javascript:alert(1)' }, { icon_url: '//evil.test/icon.png' }, { icon_url: '/not-an-upload.png' },
        { latitude: 23.1 }, { longitude: 113.3 }, { latitude: 91, longitude: 113 }, { latitude: 23, longitude: 181 },
        { latitude: 0, longitude: 0 }, { latitude: 'abc', longitude: 113 }, { location_name: 'x'.repeat(81) }]) {
        assert.equal((await request('/admin/exhibitions', 'POST', { ...publication, ...bad }, 'YUYUKO')).status, 400);
    }
    assert.equal((await request('/admin/exhibitions', 'POST', publication, 'YUYUKO')).status, 200);
    const first = (await request('/exhibitions/current')).body.exhibition;
    assert.equal(first.name, '秋日展会');
    assert.equal(first.description, publication.description);
    assert.equal(first.information, publication.information);
    assert.equal(first.icon_url, '');
    assert.equal(first.location_name, '');
    assert.equal(first.latitude, null, '展会地点选填');
    assert.equal(first.longitude, null);
    assert.equal((await request('/admin/exhibitions/current', 'GET', null, 'YOUMU')).body.exhibition.id, first.id);
    // Simulate the old single-active index on a database containing an existing publication.
    db._raw.exec('CREATE UNIQUE INDEX idx_siteexhibition_active ON SiteExhibition(is_active) WHERE is_active = 1');
    init();
    assert.equal((await request('/exhibitions/current')).body.exhibition.id, first.id);
    const create = async (name, event_time) => {
        const result = await request('/admin/exhibitions', 'POST', { ...publication, name, event_time }, 'YOUMU');
        assert.equal(result.status, 200);
        return result.body.id;
    };
    const later = await create('晚场', '2026-12-12T18:00');
    const earlier = await create('早场', '2026-11-01T10:00');
    const tied = await create('同时间', '2026-11-01T10:00');
    const list = async () => (await request('/exhibitions')).body.exhibitions;
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM SiteExhibition WHERE is_active = 1').get().n, 4, 'publishing must preserve other activities');
    init();
    assert.deepEqual((await list()).map(e => e.id), [earlier, tied, later, first.id]);
    assert.equal((await list())[0].event_time, '2026-11-01T10:00');
    assert.equal((await request('/exhibitions/current')).body.exhibition.id, earlier);
    for (const event_time of ['bad', '2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T25:00', 123]) {
        assert.equal((await request('/admin/exhibitions', 'POST', { ...publication, event_time }, 'YUYUKO')).status, 400);
    }
    const edit = { ...publication, name: '编辑晚场', event_time: '2026-10-01T09:00', location_name: '  场馆  ', latitude: 23.0961, longitude: 113.3653 };
    for (const [level, status] of [[undefined, 401], ['regular', 403], ['KOMACHI', 403]]) {
        assert.equal((await request(`/admin/exhibitions/${later}`, 'PUT', edit, level)).status, status);
        assert.equal((await request(`/admin/exhibitions/${later}`, 'DELETE', null, level)).status, status);
    }
    assert.equal((await request(`/admin/exhibitions/${later}`, 'PUT', edit, 'YOUMU')).status, 200);
    assert.deepEqual((await list()).map(e => e.id), [later, earlier, tied, first.id]);
    assert.deepEqual([(await list())[0].name, (await list())[0].location_name, (await list())[0].latitude], ['编辑晚场', '场馆', 23.0961]);
    assert.equal((await request('/admin/exhibitions/999999', 'PUT', edit, 'YOUMU')).status, 404);
    assert.equal((await request('/admin/exhibitions/invalid', 'PUT', edit, 'YOUMU')).status, 400);
    // Audit failures roll back inserts, edits and scoped unpublishing.
    db._raw.exec("CREATE TRIGGER fail_exhibition_audit BEFORE INSERT ON AdminAudit BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await request('/admin/exhibitions', 'POST', publication, 'YUYUKO')).status, 500);
    assert.equal((await request(`/admin/exhibitions/${later}`, 'PUT', { ...edit, name: '丢失' }, 'YUYUKO')).status, 500);
    assert.equal((await request(`/admin/exhibitions/${later}`, 'DELETE', null, 'YUYUKO')).status, 500);
    assert.equal((await list()).length, 4);
    assert.equal((await list())[0].name, '编辑晚场');
    db._raw.exec('DROP TRIGGER fail_exhibition_audit');
    assert.equal((await request(`/admin/exhibitions/${earlier}`, 'DELETE', null, 'YOUMU')).body.cleared, true);
    assert.deepEqual((await list()).map(e => e.id), [later, tied, first.id]);
    assert.equal((await request(`/admin/exhibitions/${earlier}`, 'PUT', edit, 'YOUMU')).status, 404);
    assert.equal((await request(`/admin/exhibitions/${earlier}`, 'DELETE', null, 'YOUMU')).body.cleared, false);
    assert.equal((await request('/admin/exhibitions/current', 'DELETE', null, 'YOUMU')).body.cleared, true);
    assert.deepEqual((await list()).map(e => e.id), [tied, first.id], 'legacy deletion removes only its current item');
    for (const id of [tied, first.id]) await request(`/admin/exhibitions/${id}`, 'DELETE', null, 'YOUMU');
    assert.deepEqual(await list(), []);
    assert.deepEqual((await request('/exhibitions/current')).body, { exhibition: null });
    console.log('Exhibition API: multiple activities, ordering, edits, validation, permissions, migration and atomic unpublishing passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
