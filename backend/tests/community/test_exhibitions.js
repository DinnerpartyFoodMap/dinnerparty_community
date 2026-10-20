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
    assert.equal((await request('/admin/exhibitions', 'POST', { ...publication, name: '新展会', icon_url: '/uploads/exhibition.png' }, 'YOUMU')).status, 200);
    init();
    assert.equal((await request('/exhibitions/current')).body.exhibition.name, '新展会');
    const located = { ...publication, name: '带地点的展会', location_name: '  保利世贸博览馆  ', latitude: '23.0961', longitude: 113.3653 };
    assert.equal((await request('/admin/exhibitions', 'POST', located, 'YOUMU')).status, 200);
    const venue = (await request('/exhibitions/current')).body.exhibition;
    assert.deepEqual([venue.location_name, venue.latitude, venue.longitude], ['保利世贸博览馆', 23.0961, 113.3653]);
    assert.equal((await request('/admin/exhibitions', 'POST', { ...publication, name: '新展会', icon_url: '/uploads/exhibition.png', latitude: '', longitude: null }, 'YOUMU')).status, 200);
    assert.equal((await request('/exhibitions/current')).body.exhibition.latitude, null, '清空地点');
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM SiteExhibition WHERE is_active = 1').get().n, 1);
    assert.equal(db._raw.prepare("SELECT COUNT(*) AS n FROM AdminAudit WHERE action = 'publish-exhibition'").get().n, 4);
    // An audit write failure must roll back replacement of the current publication.
    db._raw.exec("CREATE TRIGGER fail_exhibition_audit BEFORE INSERT ON AdminAudit BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await request('/admin/exhibitions', 'POST', publication, 'YUYUKO')).status, 500);
    assert.equal((await request('/exhibitions/current')).body.exhibition.name, '新展会');
    db._raw.exec('DROP TRIGGER fail_exhibition_audit');
    assert.equal((await request('/admin/exhibitions/current', 'DELETE', null, 'YOUMU')).body.cleared, true);
    assert.deepEqual((await request('/exhibitions/current')).body, { exhibition: null });
    assert.equal((await request('/admin/exhibitions/current', 'DELETE', null, 'YUYUKO')).body.cleared, false);
    console.log('Exhibition API: permissions, validation, publication, persistence, atomic replacement and unpublish passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
