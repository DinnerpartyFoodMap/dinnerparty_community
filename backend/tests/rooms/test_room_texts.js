// 小伙伴 P3：名字 / 口头禅审核状态、访客与剧情里的默认名、同名写法、管理员清空和大头照授权。
// 模型一律不真调：替换 aiClients 的审核函数；ROOM_TEXT_CHECK=false 用于准备数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-room-texts-'));
const packs = path.join(temp, 'packs');
process.env.RESOURCE_PACK_DIR = packs;
process.env.JWT_SECRET = 'room-text-test-secret-0123456789abcdef';
Object.assign(process.env, {
    DB_FILE: path.join(temp, 'test.sqlite'),
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    ROOMS_AUDIENCE: 'all',
    ROOM_TEXT_CHECK: 'false'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

fs.mkdirSync(path.join(packs, 'companion', 'cat', '1.0.0'), { recursive: true });
fs.writeFileSync(path.join(packs, 'catalog.json'), JSON.stringify({
    companions: [{ id: 'cat', name: '猫猫', version: '1.0.0', entry: 'cat.model3.json', avatar: 'avatar.png' }],
    skins: []
}));
fs.writeFileSync(path.join(packs, 'companion', 'cat', '1.0.0', 'cat.model3.json'), '{}');
fs.writeFileSync(path.join(packs, 'companion', 'cat', '1.0.0', 'avatar.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const { db, init } = require('../../infrastructure/database');
const ai = require('../../infrastructure/aiClients');
const { daysBefore, beijingClock } = require('../../infrastructure/beijingClock');
const { nameRoom, saveProfile } = require('../../modules/rooms/services/roomProfile');
const { getDay } = require('../../modules/rooms/services/roomDay');
const { syncTexts, readTexts, enqueueTextChecks, resumeTextChecks } = require('../../modules/rooms/services/roomTextCheck');
const { avatarUrl, findPack } = require('../../modules/skins/services/resourcePacks');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const sql = db._raw;
const corpus = loadCorpus();
const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const nextDay = (day) => daysBefore(day, -1);
const hash = (sheet) => createHash('sha256').update(JSON.stringify(sheet)).digest('hex');
const sheetFor = (name, sayings = []) => ({ name, tags: [], untagged: [], answers: {}, quirks: [], sayings });
let server;

function addUser(id, level = null) {
    sql.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(id, id, 'unused', level);
    return jwt.sign({ id }, process.env.JWT_SECRET);
}

function addPlace(name, city) {
    const { id } = sql.prepare(`INSERT INTO Place (name, latitude, longitude, category, moderation_status)
        VALUES (?, 30, 120, '家常菜', 'visible') RETURNING id`).get(name);
    sql.prepare('INSERT INTO PlaceRegion (place_id, city, checked_at) VALUES (?, ?, 0)').run(id, city);
    return id;
}

async function main() {
    init();
    ai.hasDeepseekConfiguration = () => true;
    let calls = 0;
    let gate = [];
    let verdict = async () => ({ flagged: false, confidence: 0 });
    ai.completeDeepseekJson = async () => {
        calls += 1;
        await new Promise((resolve, reject) => gate.push({ resolve, reject }));
        return verdict();
    };
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const flush = async (userId) => { await enqueueTextChecks(sql, userId); };
    const release = async (next) => {
        verdict = async () => next;
        const pending = gate.shift();
        assert.ok(pending, '模型调用应在等待回答');
        pending.resolve();
        await flush('text-owner');
    };

    const today = beijingClock(new Date()).day;
    const owner = 'text-owner';
    const viewer = 'text-viewer';
    const admin = 'text-admin';
    const ownerToken = addUser(owner);
    addUser(viewer);
    const adminToken = addUser(admin, 'YOUMU');
    addPlace('城市小馆', '文字城');

    // 准备：先以免审核入住并生成一个过去的日子
    const pastDay = daysBefore(today, 20);
    const setupNow = at(daysBefore(today, 40), '09:00');
    await nameRoom(sql, owner, { name: '旧名', visibility: 'residents', meets: 1, city: '文字城', answers: {} }, { now: setupNow });
    const past = await getDay(sql, { viewerId: owner, ownerId: owner, day: pastDay, now: at(pastDay, '23:59') });
    assert.ok(past.events.length > 0);
    assert.equal(readTexts(sql, owner, sheetFor('旧名')).name.status, 'visible');

    // 保存新名字：检查中；访客和剧情里都先用默认名，主人自己看到新名
    process.env.ROOM_TEXT_CHECK = 'true';
    const newSheet = sheetFor('新名字');
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: newSheet }, { now: at(today, '12:00') });
    await tick();
    assert.equal(readTexts(sql, owner, newSheet).name.status, 'checking');
    assert.equal(calls, 1);
    const checkingDay = (viewerId) => getDay(sql, { viewerId, ownerId: owner, day: pastDay, now: at(pastDay, '23:59') });
    assert.equal(checkingDay(owner).owner.name, '新名字');
    assert.equal(checkingDay(viewer).owner.name, '饭桶', '未通过前访客看到默认名');
    await release({ flagged: false, confidence: 0 });
    assert.equal(readTexts(sql, owner, newSheet).name.status, 'visible');
    assert.equal(checkingDay(viewer).owner.name, '新名字');
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM RoomText WHERE user_id = ? AND field = 'name'").get(owner).n, 1);

    // 明确违规：self_only，只有自己看到
    const badSheet = sheetFor('坏名字');
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: badSheet }, { now: at(today, '12:10') });
    await tick();
    await release({ flagged: true, reason: 'insult', confidence: 0.95 });
    assert.deepEqual(readTexts(sql, owner, badSheet).name, { status: 'self_only', reason: '辱骂' });
    assert.equal(checkingDay(owner).owner.name, '坏名字');
    assert.equal(checkingDay(viewer).owner.name, '饭桶');
    assert.equal(sql.prepare("SELECT status FROM RoomText WHERE user_id = ? AND field = 'name'").get(owner).status, 'self_only');

    // 模型失败：保持 checking，重试后通过；失败的调用不暴露给访客
    const retrySheet = sheetFor('待检查');
    process.env.ROOM_TEXT_CHECK = 'true';
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: retrySheet }, { now: at(today, '12:20') });
    await tick();
    const pending = gate.shift();
    assert.ok(pending);
    verdict = async () => { throw new Error('network down'); };
    pending.resolve();
    await flush(owner);
    assert.equal(readTexts(sql, owner, retrySheet).name.status, 'checking', '模型失败保持 checking');
    assert.equal(checkingDay(viewer).owner.name, '饭桶');
    const retry = resumeTextChecks(sql);
    await tick();
    await release({ flagged: false, confidence: 0 });
    await retry;
    assert.equal(readTexts(sql, owner, retrySheet).name.status, 'visible');

    // ROOM_TEXT_CHECK=false：直接通过，不调用模型
    process.env.ROOM_TEXT_CHECK = 'false';
    const directSheet = sheetFor('直通', ['开饭']);
    const beforeCalls = calls;
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: directSheet }, { now: at(today, '12:30') });
    assert.deepEqual(readTexts(sql, owner, directSheet), {
        name: { status: 'visible', reason: null },
        sayings: [{ text: '开饭', status: 'visible', reason: null }]
    });
    assert.equal(calls, beforeCalls, '关掉检查时不调用模型');
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM RoomText WHERE user_id = ? AND substr(field, 1, 7) = 'saying:'").get(owner).n, 1);

    // 删掉的口头禅同步移除
    const noSaying = sheetFor('直通');
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: noSaying }, { now: at(today, '12:40') });
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM RoomText WHERE user_id = ? AND substr(field, 1, 7) = 'saying:'").get(owner).n, 0);

    // ---- 剧情里的同名：显示「住民名的小伙伴名」；未通过的名字仍是默认名 ----
    const storyDay = daysBefore(today, 15);
    const place = addPlace('剧情小馆', '剧情城');
    const script = corpus.scripts.find((entry) => entry.kind === 'table' && entry.bond[0] === 0);
    const storyA = 'story-a';
    const storyB = 'story-b';
    for (const id of [storyA, storyB]) {
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(id, id, 'unused');
        const name = '同名';
        const sheet = sheetFor(name);
        sql.prepare(`INSERT INTO RoomProfile (user_id, enabled, visibility, meets, city, sheet, sheet_hash, named_day,
            named_at_ms, last_opened_at_ms, updated_at_ms) VALUES (?, 1, 'residents', 1, NULL, ?, ?, ?, ?, 0, 0)`)
            .run(id, JSON.stringify(sheet), hash(sheet), daysBefore(storyDay, 10), at(daysBefore(storyDay, 10), '09:00'));
        syncTexts(sql, id, sheet, at(storyDay, '03:00'));
    }
    const meet = sql.prepare(`INSERT INTO RoomMeet (day, kind, x_user, y_user, script_id, bond_script_id, bond_swap,
        place_id, start_min, end_min, seed, created_at_ms) VALUES (?, 'table', ?, ?, ?, NULL, 0, ?, 720, 780, 'story-seed', 0) RETURNING id`)
        .get(storyDay, storyA, storyB, script.id, place);
    const meetEvent = (day) => JSON.stringify([{ type: 'meet', start_min: 720, end_min: 780, sid: null, vid: null, quirk: null,
        icon: 'eat', action: '剧情', sound: null, detail: null, saying: false, star: null, outing: null,
        place_id: place, meet_id: meet.id }]);
    for (const id of [storyA, storyB]) {
        const sheet = sheetFor('同名');
        sql.prepare(`INSERT INTO RoomDay (user_id, day, sheet_hash, city, corpus_version, events, used, wake_min, sleep_min, generated_at_ms)
            VALUES (?, ?, ?, NULL, ?, ?, '[]', 480, 1440, 0)`).run(id, storyDay, hash(sheet), corpus.version, meetEvent());
    }
    const storyRead = (id) => getDay(sql, { viewerId: id, ownerId: id, day: storyDay, now: at(storyDay, '23:59') });
    assert.ok(storyRead(storyA).events.some(({ action }) => action.includes(`${storyA}的同名`) && action.includes(`${storyB}的同名`)),
        '同名剧情写成「住民名的名字」');
    sql.prepare("UPDATE RoomText SET status = 'checking' WHERE user_id = ? AND field = 'name'").run(storyB);
    const beforePass = storyRead(storyA);
    assert.ok(beforePass.events.some(({ action }) => action.includes('饭桶') && !action.includes(`${storyB}的同名`)),
        '未通过时剧情里用默认名');
    sql.prepare("UPDATE RoomText SET status = 'visible' WHERE user_id = ? AND field = 'name'").run(storyB);
    assert.ok(storyRead(storyA).events.some(({ action }) => action.includes(`${storyB}的同名`)));

    // ---- 管理员清空：口头禅清空、名字仅自己可见、未来快照删除、写审计 ----
    process.env.ROOM_TEXT_CHECK = 'false';
    const clearSheet = sheetFor('直通', ['开饭']);
    saveProfile(sql, owner, { visibility: 'residents', meets: 1, city: '文字城', sheet: clearSheet }, { now: at(today, '13:00') });
    const dayRow = (day) => sql.prepare(`INSERT OR REPLACE INTO RoomDay (user_id, day, sheet_hash, city, corpus_version, events,
        used, wake_min, sleep_min, generated_at_ms) VALUES (?, ?, ?, '文字城', ?, '[]', '[]', 480, 1440, 0)`)
        .run(owner, day, hash(clearSheet), corpus.version);
    dayRow(today);
    dayRow(nextDay(today));
    const app = express();
    app.use(express.json());
    app.use('/admin/rooms', require('../../modules/accounts/middleware/auth').requireAuth,
        require('../../modules/rooms/routes/adminRooms'));
    app.use('/api/skins', require('../../modules/skins/routes/skins'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, { method = 'GET', body, token } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const clearUrl = `/admin/rooms/${owner}/clear-texts`;
    assert.equal((await request(clearUrl, { method: 'POST' })).status, 401);
    assert.equal((await request(clearUrl, { method: 'POST', token: ownerToken })).status, 403);
    const cleared = await request(clearUrl, { method: 'POST', token: adminToken });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, { ok: true });
    assert.deepEqual(readTexts(sql, owner, sheetFor('直通')), {
        name: { status: 'self_only', reason: '管理员清空' }, sayings: []
    });
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM RoomText WHERE user_id = ? AND substr(field, 1, 7) = 'saying:'").get(owner).n, 0);
    assert.deepEqual(JSON.parse(sql.prepare('SELECT sheet FROM RoomProfile WHERE user_id = ?').get(owner).sheet).sayings, []);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day > ?').get(owner, today).n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(owner, today).n, 1);
    const audit = sql.prepare("SELECT * FROM AdminAudit WHERE action = 'room-clear-texts' ORDER BY id DESC LIMIT 1").get();
    assert.equal(audit.admin_id, admin);
    assert.equal(audit.target_user_id, owner);
    assert.equal(checkingDay(owner).owner.name, '直通', '自己仍看到自己的名字');
    assert.equal(checkingDay(viewer).owner.name, '饭桶', '别人看到默认名');
    assert.equal((await request(`/admin/rooms/not-named/clear-texts`, { method: 'POST', token: adminToken })).status, 404);

    // ---- 大头照授权：不看拥有关系、不能取别的文件、过期或无效 403、内置角色为 null ----
    const pack = findPack('companion', 'cat');
    assert.ok(pack);
    const grant = avatarUrl(pack);
    assert.match(grant, /^\/api\/skins\/packs\/avatar\//);
    const avatar = await fetch(base + grant);
    assert.equal(avatar.status, 200);
    assert.match(avatar.headers.get('content-type'), /image\/png/);
    assert.ok((await avatar.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(base + grant.replace(/.$/, (c) => c === 'a' ? 'b' : 'a'))).status, 403, '改动后的授权无效');
    assert.equal((await fetch(base + '/api/skins/packs/avatar/not-a-jwt')).status, 403);
    const avatarGrant = grant.split('/').pop();
    assert.equal((await fetch(`${base}/api/skins/packs/access/${encodeURIComponent(avatarGrant)}/cat.model3.json`)).status, 403,
        '大头照授权不能取资源包文件');
    const signingKey = createHmac('sha256', process.env.JWT_SECRET).update('resource-pack-download').digest();
    const expired = jwt.sign({ id: 'cat', version: '1.0.0', file: 'avatar.png' }, signingKey, {
        algorithm: 'HS256', audience: 'resource-pack-avatar', expiresIn: -1
    });
    assert.equal((await fetch(`${base}/api/skins/packs/avatar/${expired}`)).status, 403, '过期授权');
    assert.equal(avatarUrl(null), null);
    assert.equal(checkingDay(owner).owner.avatar, null, '内置角色没有大头照');

    // 远程角色：时间线返回 24 小时授权，未拥有这个角色的查看者也能取图
    sql.prepare("INSERT INTO UserCompanion (user_id, companion_id, unlocked_time) VALUES (?, 'cat', '2026-01-01T00:00:00.000Z')").run(owner);
    sql.prepare("INSERT INTO CompanionSelection (user_id, companion_id) VALUES (?, 'cat')").run(owner);
    const remoteAvatar = checkingDay(viewer).owner.avatar;
    assert.match(remoteAvatar, /^\/api\/skins\/packs\/avatar\//);
    assert.equal((await fetch(base + remoteAvatar)).status, 200, '查看者没有拥有这个角色也能取大头照');

    console.log('Room text and avatar tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    server?.close();
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
