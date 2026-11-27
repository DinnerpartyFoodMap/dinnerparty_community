const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-test-'));
process.env.DB_FILE = path.join(directory, 'dinners.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';

const { db, init } = require('../../infrastructure/database');
const { setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
const { createSessionStore } = require('../../modules/accounts/services/sessions');
const { JWT_SECRET } = require('../../modules/accounts/services/jwtSecret');
const { FakeRedis } = require('../helpers/fakeRedis');
const dinners = require('../../modules/community/routes/dinners');

async function main() {
    const organizerId = randomUUID();
    db._raw.exec(`CREATE TABLE DinnerEvent (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
        place_name TEXT NOT NULL, start_time DATETIME NOT NULL, max_participants INTEGER,
        contact_info TEXT, status TEXT DEFAULT 'open', creator_id TEXT NOT NULL,
        created_time DATETIME DEFAULT CURRENT_TIMESTAMP, updated_time DATETIME
    );`);
    db._raw.prepare(`INSERT INTO DinnerEvent (id, title, place_name, start_time, creator_id)
        VALUES (4, '旧火锅', '旧店', '2020-01-01T18:00:00.000Z', ?),
               (20, '已删除', '旧店', '2020-01-01T18:00:00.000Z', ?)`).run(organizerId, organizerId);
    db._raw.exec('DELETE FROM DinnerEvent WHERE id = 20');
    init();
    const sessions = createSessionStore(new FakeRedis());
    setSessionStoreForTesting(sessions);

    const addUser = async (name, id = randomUUID()) => {
        db._raw.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(id, name, 'unused');
        const { sid } = await sessions.createSession(id);
        return jwt.sign({ id, sid }, JWT_SECRET, { algorithm: 'HS256' });
    };
    const organizer = await addUser('发起人', organizerId);
    const member = await addUser('成员');
    const outsider = await addUser('其他住民');
    const app = express();
    app.use(express.json());
    app.use('/dinners', dinners);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const call = async (method, pathname, token, body) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`http://127.0.0.1:${server.address().port}/dinners${pathname}`, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, data: await response.json() };
    };

    try {
        const created = await call('POST', '', organizer, { title: '新火锅', description: '周末见', max_participants: 2 });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const { id, start_time, place_name } = created.data;
        assert.ok(id > 20, '迁移不会重用已删除的活动 ID');
        assert.equal(start_time, null);
        assert.equal(place_name, null);
        const event = `/${id}`;

        assert.deepEqual((await call('GET', '')).data.map(item => item.id), [id]);
        assert.deepEqual((await call('GET', '?include_ended=1&q=旧店')).data.map(item => item.id), [4]);
        assert.deepEqual((await call('GET', '?include_ended=1&q=周末见')).data.map(item => item.id), [id]);
        assert.deepEqual((await call('GET', '?q=%25')).data, []);
        assert.equal((await call('GET', '/4')).data.is_ended, true);
        assert.equal((await call('PUT', '/4/participants/me', member)).status, 409);

        const time = new Date(Date.now() + 86_400_000).toISOString();
        const proposal = { places: ['一店', '二店', '三店'], times: [time] };
        assert.equal((await call('PUT', `${event}/proposals/me`, member, proposal)).status, 403);
        assert.equal((await call('PUT', `${event}/participants/me`)).status, 401);
        assert.equal((await call('PATCH', `${event}/schedule`, outsider, { place_name: '越权' })).status, 403);
        const joins = await Promise.all([member, outsider].map(token => call('PUT', `${event}/participants/me`, token)));
        assert.deepEqual(joins.map(result => result.status).sort(), [200, 409]);
        const joined = joins[0].status === 200 ? member : outsider;
        assert.equal((await call('PUT', `${event}/participants/me`, joined)).data.participant_count, 2);
        assert.equal((await call('PUT', `${event}/proposals/me`, joined, { ...proposal, places: [...proposal.places, '四店'] })).status, 400);
        assert.equal((await call('PUT', `${event}/proposals/me`, joined, { places: ['旧时间'], times: ['2020-01-01T18:00:00Z'] })).status, 400);
        assert.equal((await call('PUT', `${event}/proposals/me`, joined, proposal)).status, 200);
        assert.deepEqual((await call('GET', event, joined)).data.my_proposal, proposal);
        assert.equal((await call('GET', event, organizer)).data.proposals.length, 1);
        assert.equal((await call('GET', event)).data.proposals, undefined);

        const scheduled = await call('PATCH', `${event}/schedule`, organizer, { place_name: '二店' });
        assert.equal(scheduled.data.place_name, '二店');
        assert.equal(scheduled.data.start_time, null);
        const confirmed = await call('PATCH', `${event}/schedule`, organizer, { start_time: time });
        assert.equal(confirmed.data.place_name, '二店');
        assert.equal(confirmed.data.start_time, time);
        assert.equal((await call('DELETE', `${event}/participants/me`, joined)).data.participant_count, 1);
        assert.deepEqual((await call('GET', event, organizer)).data.proposals, []);
        assert.equal((await call('PUT', `${event}/participants/me`, joined)).status, 200);
        assert.equal((await call('PUT', `${event}/proposals/me`, joined, proposal)).status, 200);
        assert.equal((await call('DELETE', event, organizer)).status, 200);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM DinnerParticipant').get().n, 0);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM DinnerProposal').get().n, 0);
        console.log('聚餐迁移、列表筛选、加入、提案与发起人确认通过');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    db._raw.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
