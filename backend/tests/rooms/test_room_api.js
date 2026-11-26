// 小伙伴 P1 接口：开放范围、入住、角色卡、当天时间线、互访披露、名场面分页、同好和主页标记。
// 临时 SQLite + 本地 express；与时间相关的读取直接给服务函数传 now。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-room-api-'));
Object.assign(process.env, {
    DB_FILE: path.join(temp, 'test.sqlite'),
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    ROOMS_AUDIENCE: 'all',
    ROOM_TEXT_CHECK: 'false'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const { db, init } = require('../../infrastructure/database');
const { beijingClock, daysBefore } = require('../../infrastructure/beijingClock');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { nameRoom, saveProfile } = require('../../modules/rooms/services/roomProfile');
const { getDay } = require('../../modules/rooms/services/roomDay');
const { feedCompanionSync } = require('../../modules/skins/services/companionState');
const { syncTexts } = require('../../modules/rooms/services/roomTextCheck');
const sql = db._raw;
const corpus = loadCorpus();
const SECRET = process.env.JWT_SECRET || 'yuyuko_secret_key';
let server;

const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const nextDay = (day) => daysBefore(day, -1);
const PASSWORD = 'unused';

function tokenFor(id) {
    return jwt.sign({ id }, SECRET);
}

function addUser(id, level = null) {
    sql.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)')
        .run(id, id, PASSWORD, level);
    return tokenFor(id);
}

function addPlace(name, city, moderation = 'visible') {
    const { id } = sql.prepare(`INSERT INTO Place (name, latitude, longitude, category, description, moderation_status)
        VALUES (?, 23.1, 113.3, '家常菜', '一家普通的店', ?) RETURNING id`).get(name, moderation);
    sql.prepare('INSERT INTO PlaceRegion (place_id, province, city, checked_at) VALUES (?, ?, ?, 0)').run(id, '广东', city);
    return id;
}

async function insertRoom(id, { name, city = '广州', visibility = 'residents', meets = 1, tags = [], quirks = [], sayings = [], namedDay, now }) {
    await nameRoom(sql, id, { name, visibility, meets, city, answers: {} }, { now });
    const sheet = { name, tags, untagged: [], answers: {}, quirks, sayings };
    saveProfile(sql, id, { visibility, meets, city, sheet }, { now });
    if (namedDay) sql.prepare('UPDATE RoomProfile SET named_day = ?, named_at_ms = ? WHERE user_id = ?')
        .run(namedDay, now, id);
    return sheet;
}

function eventKey(event) {
    return JSON.stringify([event.start_min, event.end_min, event.type, event.action, event.sound, event.detail, event.sid]);
}

async function main() {
    init();
    const ids = Object.fromEntries(['admin', 'me', 'self', 'meets', 'city', 'emptycity', 'long', 'unnamed', 'quota', 'old',
        'paused', 'card', 'citychange', 'night', 'owner', 'viewer', 'friend1', 'friend2', 'friend3', 'friend4']
        .map((key) => [key, `user-${key}`]));
    const tokens = {};
    for (const [key, id] of Object.entries(ids)) tokens[key] = addUser(id, key === 'admin' ? 'YOUMU' : null);
    const cityPlace = addPlace('广州小馆', '广州');
    addPlace('空城小屋', '空城', 'checking');
    sql.prepare(`INSERT INTO UserLastLocation (user_id, latitude, longitude, label, source, updated_at, city)
        VALUES (?, 23.1, 113.3, '', 'web', ?, '广州')`).run(ids.city, new Date().toISOString());
    sql.prepare(`INSERT INTO UserLastLocation (user_id, latitude, longitude, label, source, updated_at, city)
        VALUES (?, 23.1, 113.3, '', 'web', ?, '广州')`).run(ids.old, new Date().toISOString());

    const app = express();
    app.use(express.json());
    app.use('/api/rooms', require('../../modules/rooms/routes/rooms'));
    app.use('/admin/rooms', require('../../modules/accounts/middleware/auth').requireAuth,
        require('../../modules/rooms/routes/adminRooms'));
    app.use('/users', require('../../modules/accounts/routes/users'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function api(url, { method = 'GET', body, who, bearer } = {}) {
        const token = bearer === undefined ? (who ? tokens[who] : null) : bearer;
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status: res.status, cache: res.headers.get('cache-control'), body: parsed };
    }

    const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
    const dayBody = (patch = {}) => ({ name: '汤圆', visibility: 'residents', meets: 1, city: '广州', answers: {}, ...patch });
    const sheetOf = async (who) => (await api('/api/rooms/me', { who })).body.profile.sheet;

    // ---- 开放范围和权限 ----
    for (const [who, status] of [[null, 401], ['me', 200]]) {
        const res = await api('/api/rooms/me', { who });
        assert.equal(res.status, status);
        assert.equal(res.cache, 'private, no-store');
    }
    assert.equal((await api('/api/rooms/me', { who: 'me', bearer: 'bad-token' })).status, 401);
    assert.equal((await api(`/api/rooms/${ids.owner}/day`, { who: null })).status, 401);
    process.env.ROOMS_AUDIENCE = 'off';
    assert.equal((await api('/api/rooms/me', { who: 'me' })).status, 404);
    assert.equal((await api('/api/rooms/me', { who: 'admin' })).status, 404);
    assert.equal((await api(`/api/rooms/${ids.owner}/day`, { who: 'viewer' })).status, 404);
    process.env.ROOMS_AUDIENCE = 'admin';
    assert.equal((await api('/api/rooms/me', { who: 'me' })).status, 404);
    assert.equal((await api('/api/rooms/me', { who: 'admin' })).status, 200);
    process.env.ROOMS_AUDIENCE = 'all';
    const offCache = await api('/api/rooms/me', { who: 'me' });
    assert.equal(offCache.cache, 'private, no-store');

    // ---- GET /me：未入住时的默认值、问答与语料表 ----
    const meBefore = await api('/api/rooms/me', { who: 'me' });
    assert.equal(meBefore.status, 200);
    assert.equal(meBefore.body.named, false);
    assert.equal(meBefore.body.default_name, '饭桶');
    assert.deepEqual(Object.keys(meBefore.body).sort(), ['default_name', 'named', 'profile', 'quiz', 'quirks',
        'suggestions', 'tags', 'text_saves_left', 'texts'].sort());
    assert.equal(meBefore.body.profile.visibility, 'residents');
    assert.equal(meBefore.body.profile.meets, 1);
    assert.equal(meBefore.body.profile.city, null, '没有最近定位时城市为空');
    assert.equal(meBefore.body.profile.sheet.name, '');
    assert.ok(Array.isArray(meBefore.body.suggestions.tags));
    assert.deepEqual(meBefore.body.tags, { groups: corpus.tags.groups, exclusive: corpus.tags.exclusive });
    assert.deepEqual(meBefore.body.quirks, corpus.quirks.map(({ id, name, fits }) => ({ id, name, fits })));
    assert.equal(meBefore.body.text_saves_left, 10);
    assert.equal(meBefore.body.quiz.length, 20);
    assert.deepEqual(meBefore.body.quiz.map(({ n }) => n), Array.from({ length: 20 }, (_, i) => i + 1));
    const rare = new Map(corpus.situations.flatMap((situation) =>
        situation.variants.filter(({ rare: isRare }) => isRare).map(({ id }) => [situation.id, id])));
    for (const question of meBefore.body.quiz) {
        const situation = corpus.situations.find(({ id }) => id === question.situation);
        assert.ok(situation, question.situation);
        assert.equal(question.ask, situation.ask);
        assert.ok(question.options.length >= 2);
        assert.ok(question.options.every(({ id, text }) => id !== rare.get(question.situation) && typeof text === 'string' && text));
    }

    // ---- POST /me/name：名字、设置、城市、重复入住 ----
    for (const name of ['', '   ', '名'.repeat(13), '！？……', '饭桶', 'http://a', 'www.example', '小馆.com',
        '123456', 'qq12345', '微信abc', 'vx123', '小\n团']) {
        const res = await api('/api/rooms/me/name', { method: 'POST', who: 'me', body: dayBody({ name }) });
        if (res.status === 200) assert.fail(`名字「${JSON.stringify(name)}」不应通过`);
        assert.equal(res.status, 400, JSON.stringify(name));
        assert.equal(res.body.code, 'room_invalid');
        assert.ok(Array.isArray(res.body.errors) && res.body.errors.length, JSON.stringify(name));
        assert.equal(res.cache, 'private, no-store');
    }
    for (const patch of [{ visibility: 'public' }, { meets: 'yes' }, { city: '不存在的城' }, { city: 42 }]) {
        const res = await api('/api/rooms/me/name', { method: 'POST', who: 'me', body: dayBody(patch) });
        assert.equal(res.status, 400, JSON.stringify(patch));
        assert.ok(res.body.errors.length);
    }
    assert.equal((await api('/api/rooms/me/name', { method: 'POST', who: null, body: dayBody() })).status, 401);

    const named = await api('/api/rooms/me/name', { method: 'POST', who: 'me', body: dayBody({ name: ' 汤圆 ', answers: {} }) });
    assert.equal(named.status, 200);
    assert.equal(named.body.named, true);
    assert.equal(named.body.profile.sheet.name, '汤圆');
    assert.equal(named.body.profile.city, '广州');
    assert.equal(named.body.text_saves_left, 10, '入住不扣文本额度');
    assert.equal((await api('/api/rooms/me/name', { method: 'POST', who: 'me', body: dayBody({ name: '汤圆' }) })).status, 409);
    assert.equal((await api('/api/rooms/me', { who: 'me' })).body.texts.name.status, 'visible');

    const self = await api('/api/rooms/me/name', { method: 'POST', who: 'self', body: dayBody({ name: '自己', visibility: 'self', meets: 1 }) });
    assert.equal(self.status, 200);
    assert.equal(self.body.profile.meets, 0, '只有自己可见时互动强制为 0');
    assert.equal(sql.prepare('SELECT meets FROM RoomProfile WHERE user_id = ?').get(ids.self).meets, 0);
    assert.equal((await api('/api/rooms/me/name', { method: 'POST', who: 'meets', body: dayBody({ name: '互动', meets: false }) })).body.profile.meets, 0);
    const cityNamed = await api('/api/rooms/me/name', { method: 'POST', who: 'city', body: dayBody({ name: '城市', city: undefined }) });
    assert.equal(cityNamed.status, 200);
    assert.equal(cityNamed.body.profile.city, '广州');
    const emptyCity = await api('/api/rooms/me/name', { method: 'POST', who: 'emptycity', body: dayBody({ name: '空城', city: '   ' }) });
    assert.equal(emptyCity.status, 200);
    assert.equal(emptyCity.body.profile.city, null);
    const longName = await api('/api/rooms/me/name', { method: 'POST', who: 'long', body: dayBody({ name: '🍜'.repeat(12) }) });
    assert.equal(longName.status, 200, '表情算一个字，12 个可以');
    assert.equal(longName.body.profile.sheet.name, '🍜'.repeat(12));

    // 封禁中的住民只能读
    sql.prepare("UPDATE User SET is_banned = 1, ban_expires = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(ids.long);
    assert.equal((await api('/api/rooms/me/name', { method: 'POST', who: 'long', body: dayBody({ name: '新名' }) })).status, 403);
    assert.equal((await api('/api/rooms/me', { who: 'long' })).status, 200);
    sql.prepare('UPDATE User SET is_banned = 0, ban_expires = NULL WHERE id = ?').run(ids.long);

    // ---- PUT /me：角色卡校验、只在名字 / 口头禅变化时扣配额 ----
    assert.equal((await api('/api/rooms/me', { method: 'PUT', who: 'unnamed', body: { sheet: { name: '', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }, visibility: 'residents', meets: 1, city: null } })).status, 409);
    const baseSheet = await sheetOf('me');
    const put = (sheet, patch = {}) => api('/api/rooms/me', {
        method: 'PUT', who: 'me', body: { sheet, visibility: 'residents', meets: 1, city: '广州', ...patch }
    });
    const allowedTags = corpus.tags.groups.flatMap(({ tags }) => tags);
    const [exA, exB] = corpus.tags.exclusive[0];
    const fourQuirks = corpus.quirks.slice(0, 4).map(({ id }) => id);
    const quiz = corpus.situations.find(({ quiz: n }) => n != null);
    const quizOption = quiz.variants.find(({ rare: isRare }) => !isRare);
    const badSheets = [
        { ...baseSheet, tags: ['没有这个标签'] },
        { ...baseSheet, tags: [exA, exB] },
        { ...baseSheet, tags: allowedTags.slice(0, 11) },
        { ...baseSheet, tags: [allowedTags[0]], untagged: [allowedTags[0]] },
        { ...baseSheet, quirks: fourQuirks },
        { ...baseSheet, quirks: ['没有这个小习惯'] },
        { ...baseSheet, sayings: ['一', '二', '三', '四'] },
        { ...baseSheet, sayings: ['一二三四五六七八九'] },
        { ...baseSheet, sayings: ['「好」'] },
        { ...baseSheet, answers: { '不是问答': '做法' } },
        { ...baseSheet, answers: { [quiz.id]: '没有这个做法' } },
        { ...baseSheet, answers: { [quiz.id]: quiz.variants.find(({ rare: isRare }) => isRare)?.id ?? 'nope' } },
        { ...baseSheet, tags: 'not-an-array' },
        null
    ];
    for (const sheet of badSheets) {
        const res = await api('/api/rooms/me', { method: 'PUT', who: 'me', body: { sheet, visibility: 'residents', meets: 1, city: '广州' } });
        assert.equal(res.status, 400, JSON.stringify(sheet)?.slice(0, 80));
        assert.equal(res.body.code, 'room_invalid');
        assert.ok(res.body.errors.length);
    }
    const validSheet = { ...baseSheet, tags: allowedTags.slice(0, 10), quirks: fourQuirks.slice(0, 3),
        sayings: ['开饭', '好饿'], answers: { [quiz.id]: quizOption.id } };
    if (corpus.tags.exclusive.some(([a, b]) => validSheet.tags.includes(a) && validSheet.tags.includes(b))) {
        validSheet.tags = allowedTags.filter((tag) => !corpus.tags.exclusive.some(([a, b]) => tag === a || tag === b)).slice(0, 10);
    }
    const saved = await put(validSheet);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.profile.sheet.sayings, ['开饭', '好饿']);
    assert.equal(saved.body.text_saves_left, 9, '改口头禅扣一次');
    assert.equal((await put({ ...validSheet, tags: [] })).status, 200, '只改标签不扣次数');
    assert.equal((await put(validSheet, { visibility: 'self' })).body.profile.meets, 0);
    assert.equal((await put({ ...validSheet }, { city: '空城' })).body.profile.city, '空城');
    assert.equal((await put({ ...validSheet, tags: [] }, { city: '不存在' })).status, 400);

    // 文本额度：每人每个北京日 10 次，第 11 次 429；其他字段仍可改，跨日重置
    await nameRoom(sql, ids.quota, { name: '额度', visibility: 'residents', meets: 1, city: '广州', answers: {} });
    let left = 10;
    for (let i = 1; i <= 10; i += 1) {
        const res = await api('/api/rooms/me', {
            method: 'PUT', who: 'quota',
            body: { sheet: { name: `额度${i}`, tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }, visibility: 'residents', meets: 1, city: '广州' }
        });
        assert.equal(res.status, 200, `第 ${i} 次应通过`);
        left -= 1;
        assert.equal(res.body.text_saves_left, left);
    }
    const limited = await api('/api/rooms/me', {
        method: 'PUT', who: 'quota',
        body: { sheet: { name: '额度11', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }, visibility: 'residents', meets: 1, city: '广州' }
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'room_text_limit');
    assert.equal((await api('/api/rooms/me', {
        method: 'PUT', who: 'quota',
        body: { sheet: { name: '额度10', tags: ['宅'], untagged: [], answers: {}, quirks: [corpus.quirks[0].id], sayings: [] }, visibility: 'self', meets: 1, city: null }
    })).status, 200, '额度用完后改其他字段仍然可以');
    const tomorrow = nextDay(beijingClock(new Date()).day);
    saveProfile(sql, ids.quota, {
        visibility: 'residents', meets: 1, city: '广州',
        sheet: { name: '额度次日', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }
    }, { now: at(tomorrow, '09:00') });
    const quotaRow = sql.prepare('SELECT count FROM RoomTextQuota WHERE user_id = ? AND day = ?').get(ids.quota, tomorrow);
    assert.equal(quotaRow.count, 1);
    assert.equal(sql.prepare('SELECT sheet FROM RoomProfile WHERE user_id = ?').get(ids.quota).sheet.includes('额度次日'), true);

    // ---- 当天时间线：日期边界、只返回已开始、同日读两次一致、暂停 ----
    const today = beijingClock(new Date()).day;
    const oldNow = at(daysBefore(today, 40), '09:00');
    await insertRoom(ids.old, { name: '旧屋', namedDay: daysBefore(today, 40), now: oldNow });
    for (const [date, status] of [[daysBefore(today, 41), 400], [daysBefore(today, 31), 400], [daysBefore(today, 30), 200],
        [daysBefore(today, 30), 200], [nextDay(today), 400], ['2026-13-01', 400], ['not-a-date', 400]]) {
        const res = await api(`/api/rooms/${ids.old}/day?date=${date}`, { who: 'old' });
        assert.equal(res.status, status, `${date} 应该是 ${status}`);
    }
    assert.equal((await api(`/api/rooms/${ids.unnamed}/day`, { who: 'unnamed' })).body.named, false);

    const todayRead = await api(`/api/rooms/${ids.old}/day`, { who: 'old' });
    assert.equal(todayRead.status, 200);
    const response = todayRead.body;
    assert.deepEqual([response.named, response.paused, response.is_today, response.day, response.first_day],
        [true, false, true, today, daysBefore(today, 40)]);
    assert.equal(typeof response.next_at === 'number' || response.next_at === null, true);
    assert.ok(Array.isArray(response.events) && Array.isArray(response.people));
    const nowMinute = beijingClock(new Date()).msOfDay / 60000 | 0;
    assert.ok(response.events.every(({ start_min }) => start_min <= nowMinute), '今天只返回开始时刻不晚于现在的事件');
    const lastStart = response.events.at(-1)?.start_min ?? -1;
    assert.ok(response.next_at === null || response.next_at > Math.max(lastStart, nowMinute));
    const dayTemplates = JSON.parse(sql.prepare('SELECT events FROM RoomDay WHERE user_id = ? AND day = ?').get(ids.old, today).events);
    assert.equal(response.next_at, dayTemplates.find(({ start_min }) => start_min > nowMinute)?.start_min ?? null,
        'next_at 是下一条事件的开始时刻');
    assert.ok(response.events.every((event) => ['start_min', 'end_min', 'type', 'who', 'icon', 'action', 'sound',
        'detail', 'star', 'saying', 'quirk', 'place', 'group', 'anchor'].every((key) => Object.hasOwn(event, key))));
    assert.deepEqual((await api(`/api/rooms/${ids.old}/day`, { who: 'old' })).body, response, '同一天读两次结果相同');

    // 暂停：不写新的 RoomDay
    await insertRoom(ids.paused, { name: '暂停', namedDay: daysBefore(today, 40), now: oldNow });
    sql.prepare('UPDATE User SET map_settings = ? WHERE id = ?').run(JSON.stringify({ companion_enabled: false }), ids.paused);
    sql.prepare('DELETE FROM RoomDay WHERE user_id = ? AND day = ?').run(ids.paused, today);
    const paused = await getDay(sql, { viewerId: ids.paused, ownerId: ids.paused, day: today, now: at(today, '12:00') });
    assert.equal(paused.paused, true);
    assert.deepEqual(paused.events, []);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(ids.paused, today).n, 0);

    // 夜猫子过了零点还没到今天的起床时刻：省略日期时返回昨天，is_today 仍为真
    await insertRoom(ids.night, { name: '夜猫', namedDay: daysBefore(today, 40), now: oldNow, tags: ['夜猫子'] });
    const nightDay = daysBefore(today, 10);
    getDay(sql, { viewerId: ids.night, ownerId: ids.night, day: nightDay, now: at(nightDay, '23:00') });
    sql.prepare('UPDATE RoomDay SET sleep_min = 1600 WHERE user_id = ? AND day = ?').run(ids.night, nightDay);
    const afterMidnight = at(nextDay(nightDay), '02:00');
    const overnight = getDay(sql, { viewerId: ids.night, ownerId: ids.night, now: afterMidnight });
    assert.equal(overnight.day, nightDay);
    assert.equal(overnight.is_today, true);
    assert.equal(overnight.events.some(({ anchor }) => anchor === 'sleep'), false);
    assert.deepEqual(overnight, getDay(sql, { viewerId: ids.night, ownerId: ids.night, day: nightDay, now: afterMidnight }));

    // 当天改卡：已开始事件不变，之后重排
    const cardSheet = { name: '卡片', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] };
    await insertRoom(ids.card, { name: '卡片', namedDay: daysBefore(today, 40), now: oldNow });
    const noon = at(today, '14:00');
    const beforeCard = await getDay(sql, { viewerId: ids.card, ownerId: ids.card, now: noon });
    assert.ok(beforeCard.events.length > 0);
    const startedBefore = beforeCard.events.filter(({ start_min }) => start_min <= 840).map(eventKey);
    const allBeforeCard = JSON.parse(sql.prepare('SELECT events FROM RoomDay WHERE user_id = ? AND day = ?').get(ids.card, today).events);
    saveProfile(sql, ids.card, {
        visibility: 'residents', meets: 1, city: '广州',
        sheet: { ...cardSheet, tags: ['夜猫子'], quirks: [corpus.quirks[0].id], sayings: [] }
    }, { now: noon });
    const afterCard = await getDay(sql, { viewerId: ids.card, ownerId: ids.card, now: noon });
    assert.deepEqual(afterCard.events.filter(({ start_min }) => start_min <= 840).map(eventKey), startedBefore);
    const allAfterCard = JSON.parse(sql.prepare('SELECT events FROM RoomDay WHERE user_id = ? AND day = ?').get(ids.card, today).events);
    assert.notDeepEqual(allAfterCard.filter(({ start_min }) => start_min >= 841).map(eventKey),
        allBeforeCard.filter(({ start_min }) => start_min >= 841).map(eventKey), '之后的安排应重排');

    // 改城市：今天还没开始的外出重新规划（新城市没有公开候选）
    await insertRoom(ids.citychange, { name: '搬家', namedDay: daysBefore(today, 40), now: oldNow });
    const cityNow = at(today, '14:00');
    const beforeCity = await getDay(sql, { viewerId: ids.citychange, ownerId: ids.citychange, now: cityNow });
    const stored = sql.prepare('SELECT events FROM RoomDay WHERE user_id = ? AND day = ?').get(ids.citychange, today);
    assert.ok(stored);
    const outingId = Number(sql.prepare(`INSERT INTO RoomOuting (user_id, day, slot, place_id, start_min, end_min, reason)
        VALUES (?, ?, 'dinner', ?, 960, 1020, 'solo') RETURNING id`).run(ids.citychange, today, cityPlace).lastInsertRowid);
    const events = JSON.parse(stored.events);
    events.push({ type: 'outing', start_min: 960, end_min: 1020, sid: null, vid: null, quirk: null, icon: 'eat', action: '散步',
        sound: null, detail: null, saying: false, star: null, outing: { id: outingId }, place_id: cityPlace, meet_id: null });
    sql.prepare('UPDATE RoomDay SET events = ? WHERE user_id = ? AND day = ?').run(JSON.stringify(events), ids.citychange, today);
    const startedCity = beforeCity.events.filter(({ start_min }) => start_min <= 840).map(eventKey);
    saveProfile(sql, ids.citychange, {
        visibility: 'residents', meets: 1, city: '空城',
        sheet: { name: '搬家', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }
    }, { now: cityNow });
    const afterCity = await getDay(sql, { viewerId: ids.citychange, ownerId: ids.citychange,
        now: at(today, '23:59') });
    assert.ok(afterCity.events.every(({ group }) => group?.id !== outingId), '新城市没有候选，未开始的外出应被移除');
    assert.deepEqual(afterCity.events.filter(({ start_min }) => start_min <= 840).map(eventKey), startedCity);

    // 打卡只改饱食度，不动时间线
    const fedBefore = await getDay(sql, { viewerId: ids.card, ownerId: ids.card, now: noon });
    const satiety = fedBefore.owner.satiety;
    feedCompanionSync(ids.card, sql, noon);
    const fedAfter = await getDay(sql, { viewerId: ids.card, ownerId: ids.card, now: noon });
    assert.equal(fedAfter.owner.satiety, satiety + 1);
    assert.deepEqual(fedAfter.events, fedBefore.events, '打卡不进时间线');

    // ---- 互访：披露规则、访客字段、熟人和主页 room ----
    await insertRoom(ids.owner, { name: '被看', namedDay: daysBefore(today, 40), now: oldNow, tags: ['宅'], quirks: [corpus.quirks[0].id] });
    const visitDate = daysBefore(today, 5);
    const ownOwner = await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'owner' });
    assert.equal(ownOwner.status, 200);
    const visitor = await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' });
    assert.equal(visitor.status, 200);
    assert.equal(visitor.body.is_today, false);
    assert.deepEqual([visitor.body.owner.user_id, visitor.body.owner.owner_name], [ids.owner, ids.owner]);
    assert.deepEqual(visitor.body.owner.tags, ['宅']);
    assert.deepEqual(visitor.body.owner.quirks, [{ id: corpus.quirks[0].id, name: corpus.quirks[0].name }]);
    assert.equal(visitor.body.owner.bond_level, null);
    for (const key of ['satiety', 'texts', 'answers', 'sheet', 'saying']) assert.equal(Object.hasOwn(visitor.body.owner, key), false);
    assert.ok(visitor.body.people.every(({ avatar }) => avatar === null));
    sql.prepare(`INSERT INTO RoomBond (user_low, user_high, score, updated_at_ms) VALUES (?, ?, 4, 0)`)
        .run(...[ids.owner, ids.viewer].sort());
    assert.equal((await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' })).body.owner.bond_level, 1);

    const ownFriends = await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'owner' });
    assert.equal(ownFriends.body.owner.friends.length, 0, '还没有熟人');
    for (const [key, score] of [['friend1', 4], ['friend2', 12], ['friend3', 29], ['friend4', 30]]) {
        await insertRoom(ids[key], { name: `熟人${key.slice(-1)}`, namedDay: daysBefore(today, 40), now: oldNow });
        sql.prepare('INSERT INTO RoomBond (user_low, user_high, score, updated_at_ms) VALUES (?, ?, ?, 0)')
            .run(...[ids.owner, ids[key]].sort(), score);
    }
    const friends = (await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'owner' })).body.owner.friends;
    assert.deepEqual(friends.map(({ user_id, level }) => [user_id, level]),
        [[ids.friend4, 3], [ids.friend3, 2], [ids.friend2, 2]]);

    const profileRoute = `/users/${ids.owner}/profile`;
    const report = async (who) => (await api(profileRoute, { who })).body;
    assert.equal((await report('viewer')).room, true);
    assert.equal((await report(null)).room, false, '游客不能看');
    assert.equal((await report('owner')).room, true);
    sql.prepare("UPDATE RoomProfile SET visibility = 'self' WHERE user_id = ?").run(ids.owner);
    assert.equal((await report('viewer')).room, false);
    sql.prepare("UPDATE RoomProfile SET visibility = 'residents' WHERE user_id = ?").run(ids.owner);
    assert.equal((await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' })).status, 200);

    const conditions = [
        { sql: ["UPDATE RoomProfile SET visibility = 'self' WHERE user_id = ?", ids.owner], undo: ["UPDATE RoomProfile SET visibility = 'residents' WHERE user_id = ?", ids.owner] },
        { sql: ['UPDATE User SET map_settings = ? WHERE id = ?', JSON.stringify({ companion_enabled: false }), ids.owner], undo: ['UPDATE User SET map_settings = NULL WHERE id = ?', ids.owner] },
        { sql: ["UPDATE User SET is_banned = 1, ban_expires = '2999-01-01T00:00:00.000Z' WHERE id = ?", ids.owner], undo: ['UPDATE User SET is_banned = 0, ban_expires = NULL WHERE id = ?', ids.owner] },
        { sql: ['INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)', ids.viewer, ids.owner], undo: ['DELETE FROM UserBlock WHERE user_id = ? AND blocked_id = ?', ids.viewer, ids.owner] },
        { sql: ['INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)', ids.owner, ids.viewer], undo: ['DELETE FROM UserBlock WHERE user_id = ? AND blocked_id = ?', ids.owner, ids.viewer] }
    ];
    for (const condition of conditions) {
        sql.prepare(condition.sql[0]).run(...condition.sql.slice(1));
        const denied = await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' });
        assert.equal(denied.status, 404, condition.sql[0]);
        assert.equal(denied.body.code, 'room_not_found');
        assert.equal(denied.cache, 'private, no-store');
        assert.equal((await api(`/api/rooms/${ids.owner}/moments`, { who: 'viewer' })).status, 404);
        sql.prepare(condition.undo[0]).run(...condition.undo.slice(1));
    }
    process.env.ROOMS_AUDIENCE = 'off';
    assert.equal((await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' })).status, 404);
    process.env.ROOMS_AUDIENCE = 'admin';
    assert.equal((await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'viewer' })).status, 404);
    assert.equal((await api(`/api/rooms/${ids.owner}/day?date=${visitDate}`, { who: 'admin' })).status, 200);
    process.env.ROOMS_AUDIENCE = 'all';

    // ---- 名场面分页 ----
    const insertMoment = sql.prepare(`INSERT INTO RoomMoment (user_id, day, t, kind, event, created_at_ms)
        VALUES (?, ?, ?, 'rare', ?, 0)`);
    const makeMomentEvent = (t) => JSON.stringify({ type: 'home', start_min: t, end_min: t + 10, sid: 'home.read',
        vid: null, quirk: null, icon: 'book', action: '翻书', sound: null, detail: null, saying: false, star: 'rare', outing: null, place_id: null, meet_id: null });
    for (let i = 0; i < 20; i += 1) insertMoment.run(ids.owner, daysBefore(today, 2), 100 + i, makeMomentEvent(100 + i));
    for (let i = 0; i < 15; i += 1) insertMoment.run(ids.owner, daysBefore(today, 3), 200 + i, makeMomentEvent(200 + i));
    const firstPage = await api(`/api/rooms/${ids.owner}/moments`, { who: 'viewer' });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.moments.length, 30);
    assert.equal(typeof firstPage.body.next_before, 'number');
    assert.ok(firstPage.body.moments.every((moment) => ['id', 'day', 't', 'kind', 'event'].every((key) => Object.hasOwn(moment, key))));
    assert.ok(firstPage.body.moments.every((moment, index, list) => index === 0
        || `${list[index - 1].day}/${list[index - 1].t}/${list[index - 1].id}` > `${moment.day}/${moment.t}/${moment.id}`));
    const secondPage = await api(`/api/rooms/${ids.owner}/moments?before=${firstPage.body.next_before}`, { who: 'viewer' });
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.moments.length, 5);
    assert.equal(secondPage.body.next_before, null);
    assert.equal((await api(`/api/rooms/${ids.owner}/moments?before=${secondPage.body.moments[0].id}`, { who: 'viewer' })).body.moments.length, 4);
    for (const before of ['0', 'abc', '-1', '1.5', '99999999999999999999']) {
        assert.equal((await api(`/api/rooms/${ids.owner}/moments?before=${encodeURIComponent(before)}`, { who: 'viewer' })).status, 400, before);
    }
    assert.deepEqual((await api(`/api/rooms/${ids.owner}/moments?before=999999`, { who: 'viewer' })).body, { moments: [], next_before: null });

    // ---- 同好：前 5 位、只看可见、关了同好发现为空 ----
    const neighborIds = Array.from({ length: 7 }, (_, i) => `neighbor-${i}`);
    for (const [index, id] of neighborIds.entries()) {
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(id, `邻${index}`, PASSWORD);
        await insertRoom(id, { name: `邻${index}`, namedDay: daysBefore(today, 40), now: oldNow });
    }
    const vector = Buffer.alloc(1024 * 4);
    vector.writeFloatLE(1, 0);
    for (const id of [ids.viewer, ...neighborIds]) {
        // 同好需要已就绪的用户向量；所有向量相同，余弦为 1。
        sql.prepare(`INSERT INTO UserPreference (user_id, vector, model, dimensions, algorithm_version, status,
            source_place_count, vector_place_count, total_weight, updated_at, dirty, input_revision, computed_input_revision)
            VALUES (?, ?, ?, 1024, 2, 'ready', 1, 1, 1, ?, 0, 1, 1)
            ON CONFLICT(user_id) DO UPDATE SET vector = excluded.vector, model = excluded.model, status = excluded.status,
            updated_at = excluded.updated_at, dirty = 0, computed_input_revision = 1`)
            .run(id, vector, process.env.EMBEDDING_MODEL || 'Qwen/Qwen3-Embedding-4B', Date.now());
        sql.prepare(`INSERT OR IGNORE INTO MapConsent (user_id, feedback, research, discovery, tags, version, updated_at)
            VALUES (?, 1, 1, 1, '[]', 0, ?)`).run(id, new Date().toISOString());
    }
    const neighbors = await api('/api/rooms/me/neighbors', { who: 'viewer' });
    assert.equal(neighbors.status, 200);
    assert.equal(neighbors.body.neighbors.length, 5);
    assert.deepEqual(Object.keys(neighbors.body.neighbors[0]).sort(), ['avatar', 'name', 'owner_name', 'user_id']);
    assert.ok(neighbors.body.neighbors.every(({ user_id }) => neighborIds.includes(user_id)));
    sql.prepare("UPDATE MapConsent SET discovery = 0 WHERE user_id = ?").run(ids.viewer);
    assert.deepEqual((await api('/api/rooms/me/neighbors', { who: 'viewer' })).body, { neighbors: [] });
    sql.prepare("UPDATE MapConsent SET discovery = 1 WHERE user_id = ?").run(ids.viewer);
    sql.prepare("INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)").run(ids.viewer, neighborIds[0]);
    sql.prepare("UPDATE RoomProfile SET visibility = 'self' WHERE user_id = ?").run(neighborIds[1]);
    const filtered = (await api('/api/rooms/me/neighbors', { who: 'viewer' })).body.neighbors;
    assert.ok(filtered.every(({ user_id }) => user_id !== neighborIds[0] && user_id !== neighborIds[1]));
    assert.ok(filtered.length >= 4);

    console.log('Room API tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    server?.close();
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
