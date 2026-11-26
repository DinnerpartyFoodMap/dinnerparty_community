// 小伙伴 P2：每日排程、配对、拼桌 / 隔空剧情、熟悉度、披露与取消、星标名场面、注销级联。
// 固定日期并直接给服务函数传 now，不等待真实时间；DeepSeek 不参与（ROOM_TEXT_CHECK=false）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-room-social-'));
Object.assign(process.env, {
    DB_FILE: path.join(temp, 'test.sqlite'),
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    ROOMS_AUDIENCE: 'all',
    ROOM_SCHEDULER: 'true',
    ROOM_TEXT_CHECK: 'false'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const { db, init } = require('../../infrastructure/database');
const { daysBefore } = require('../../infrastructure/beijingClock');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { runSchedule } = require('../../modules/rooms/services/roomScheduler');
const { getDay, getMoments } = require('../../modules/rooms/services/roomDay');
const { saveProfile } = require('../../modules/rooms/services/roomProfile');
const { bondLevel, orderedUsers } = require('../../modules/rooms/services/roomMeets');
const { awakeWindow } = require('../../modules/rooms/services/roomSimulator');
const { loadOutingContext } = require('../../modules/rooms/services/roomOutings');
const { syncTexts } = require('../../modules/rooms/services/roomTextCheck');
const sql = db._raw;
const corpus = loadCorpus();
const BASE = '2026-11-01';
const usedDays = new Set();
const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const nextDay = (day) => daysBefore(day, -1);
const hash = (sheet) => createHash('sha256').update(JSON.stringify(sheet)).digest('hex');
const storyEvents = (response) => response.events.filter(({ type }) => type === 'meet' || type === 'bond');
const comparable = (response) => storyEvents(response).map(({ group, ...event }) => event);

function addPlace(name, city, category = '家常菜', moderation = 'visible') {
    const { id } = sql.prepare(`INSERT INTO Place (name, latitude, longitude, category, description, moderation_status)
        VALUES (?, 30, 120, ?, '一家普通的店', ?) RETURNING id`).get(name, category, moderation);
    sql.prepare('INSERT INTO PlaceRegion (place_id, province, city, checked_at) VALUES (?, ?, ?, 0)').run(id, '测试省', city);
    return id;
}

function disableAllRooms() {
    sql.prepare('UPDATE RoomProfile SET enabled = 0').run();
}

function cleanupDay(day) {
    sql.prepare('DELETE FROM RoomMeet WHERE day = ?').run(day);
    sql.prepare('DELETE FROM RoomOuting WHERE day = ?').run(day);
    sql.prepare('DELETE FROM RoomDay WHERE day = ?').run(day);
    sql.prepare('DELETE FROM RoomMoment WHERE day = ?').run(day);
    sql.prepare('DELETE FROM RoomSchedulerRun WHERE day = ?').run(day);
}

function prepareRoom(day, { id, city = '测试城', name = '豆丁', tags = [], quirks = [], sayings = [],
    visibility = 'residents', meets = 1, discovery = 1, paused = false, banned = false, inactive = false }) {
    if (!sql.prepare('SELECT 1 FROM User WHERE id = ?').get(id)) {
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(id, id, 'unused');
    }
    const sheet = { name, tags, untagged: [], answers: {}, quirks, sayings };
    const now = at(day, '03:00');
    sql.prepare(`INSERT INTO RoomProfile (user_id, enabled, visibility, meets, city, sheet, sheet_hash, named_at_ms,
        named_day, last_opened_at_ms, updated_at_ms) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET enabled = 1, visibility = excluded.visibility, meets = excluded.meets,
        city = excluded.city, sheet = excluded.sheet, sheet_hash = excluded.sheet_hash,
        named_at_ms = excluded.named_at_ms, named_day = excluded.named_day,
        last_opened_at_ms = excluded.last_opened_at_ms, updated_at_ms = excluded.updated_at_ms`)
        .run(id, visibility, meets, city, JSON.stringify(sheet), hash(sheet), now, daysBefore(day, 2),
            inactive ? now - 20 * 86400000 : now, now);
    sql.prepare("UPDATE User SET map_settings = ?, is_banned = ?, ban_expires = ? WHERE id = ?")
        .run(paused ? JSON.stringify({ companion_enabled: false }) : null, banned ? 1 : 0,
            banned ? '2999-01-01T00:00:00.000Z' : null, id);
    sql.prepare(`INSERT OR IGNORE INTO MapConsent (user_id, feedback, research, discovery, tags, version, updated_at)
        VALUES (?, 1, 1, 1, '[]', 0, ?)`).run(id, new Date(now).toISOString());
    sql.prepare('UPDATE MapConsent SET discovery = ? WHERE user_id = ?').run(discovery, id);
    syncTexts(sql, id, sheet, now);
    return sheet;
}

async function runDay(day, defs) {
    for (const def of defs) prepareRoom(day, def);
    return runSchedule(sql, { day, now: at(day, '04:31') });
}

async function findSchedule(defs, { start = BASE, cities } = {}) {
    for (let offset = 0; offset < 120; offset += 1) {
        const day = daysBefore(start, -offset);
        if (usedDays.has(day)) continue;
        cleanupDay(day);
        disableAllRooms();
        for (const def of defs) prepareRoom(day, def);
        if (cities) {
            for (const def of defs) sql.prepare('UPDATE RoomProfile SET city = ? WHERE user_id = ?')
                .run(cities[def.id] ?? def.city, def.id);
        }
        const ran = await runSchedule(sql, { day, now: at(day, '04:31') });
        if (!ran) continue;
        const meet = sql.prepare('SELECT * FROM RoomMeet WHERE day = ?').get(day);
        if (meet) {
            usedDays.add(day);
            return { day, meet };
        }
        cleanupDay(day);
    }
    throw new Error('排程多次尝试后仍未配对');
}

const read = (ownerId, viewerId, day, now = at(day, '23:59')) => getDay(sql, { viewerId, ownerId, day, now });
const moments = (ownerId, viewerId, day) => getMoments(sql, { viewerId, ownerId, now: at(day, '23:59') });
const meetEvents = (response, meetId) => response.events.filter(({ group }) => group?.id === meetId);
const pairBond = (sql, a, b) => sql.prepare('SELECT score FROM RoomBond WHERE user_low = ? AND user_high = ?')
    .get(...orderedUsers(a, b))?.score ?? null;

async function main() {
    init();

    // ---- 开关和一天只跑一次 ----
    const switchRoom = { id: 'switch-a', city: '开关城' };
    disableAllRooms();
    const switchDay = BASE;
    cleanupDay(switchDay);
    await runDay(switchDay, [switchRoom]);
    process.env.ROOM_SCHEDULER = 'false';
    assert.equal(await runSchedule(sql, { day: nextDay(switchDay), now: at(nextDay(switchDay), '04:31') }), false);
    process.env.ROOM_SCHEDULER = 'true';
    process.env.ROOMS_AUDIENCE = 'off';
    assert.equal(await runSchedule(sql, { day: switchDay, now: at(switchDay, '04:31') }), false);
    process.env.ROOMS_AUDIENCE = 'admin';
    // 普通住民在 admin 范围内不排
    cleanupDay(switchDay);
    prepareRoom(nextDay(switchDay), switchRoom);
    assert.equal(await runSchedule(sql, { day: switchDay, now: at(switchDay, '04:31') }), true);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(switchRoom.id, switchDay).n, 0);
    process.env.ROOMS_AUDIENCE = 'all';
    cleanupDay(switchDay);
    disableAllRooms();
    assert.equal(await runDay(switchDay, [switchRoom]), true);
    const runRow = sql.prepare('SELECT * FROM RoomSchedulerRun WHERE day = ?').get(switchDay);
    assert.ok(runRow.finished_at_ms >= runRow.started_at_ms);
    assert.equal(await runSchedule(sql, { day: switchDay, now: at(switchDay, '04:31') }), false);
    assert.equal(sql.prepare('SELECT finished_at_ms FROM RoomSchedulerRun WHERE day = ?').get(switchDay).finished_at_ms, runRow.finished_at_ms);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(switchRoom.id, switchDay).n, 1);

    // ---- 排程资格：不活跃 / 当天才入住 / 封禁 / 暂停 / 超出开放范围不排 ----
    const skipCases = [
        { name: 'inactive', inactive: true },
        { name: 'banned', banned: true },
        { name: 'paused', paused: true }
    ];
    for (const [index, entry] of skipCases.entries()) {
        const day = daysBefore(BASE, 2 + index);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        const def = { id: `skip-${entry.name}`, city: '跳过城', ...entry };
        prepareRoom(day, def);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(def.id, day).n, 0, entry.name);
    }
    {
        const day = daysBefore(BASE, 5);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        const id = 'skip-new';
        prepareRoom(day, { id, city: '跳过城' });
        sql.prepare('UPDATE RoomProfile SET named_day = ? WHERE user_id = ?').run(day, id);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomDay WHERE user_id = ? AND day = ?').get(id, day).n, 0, '当天起名');
    }

    // ---- 熟悉度边界 ----
    for (const [score, level] of [[0, 0], [3, 0], [4, 1], [11, 1], [12, 2], [29, 2], [30, 3], [999, 3]]) {
        assert.equal(bondLevel(score), level, `score ${score}`);
    }

    // ---- 拼桌：同城、5 家候选、同店同时段、两边一致、+2 ----
    disableAllRooms();
    const tablePlaces = Array.from({ length: 5 }, (_, i) => addPlace(`桌城小馆${i}`, '桌城'));
    const tableDefs = [
        { id: 'table-a', city: '桌城', name: '甲丁', tags: ['爱看书'] },
        { id: 'table-b', city: '桌城', name: '乙丁', tags: ['打游戏'] }
    ];
    const table = await findSchedule(tableDefs, { cities: { 'table-a': '桌城', 'table-b': '桌城' } });
    const tableMeet = table.meet;
    assert.equal(tableMeet.kind, 'table');
    assert.ok(tablePlaces.includes(tableMeet.place_id));
    assert.equal(pairBond(sql, 'table-a', 'table-b'), 2, '拼桌 +2');
    const tableOutings = sql.prepare("SELECT * FROM RoomOuting WHERE day = ? AND reason = 'meet' ORDER BY user_id").all(table.day);
    assert.deepEqual(tableOutings.map(({ user_id, meet_id, place_id, start_min, end_min }) => [user_id, meet_id, place_id, start_min, end_min]),
        tableDefs.map(({ id }) => [id, tableMeet.id, tableMeet.place_id, tableMeet.start_min, tableMeet.end_min]));
    const tableA = read('table-a', 'table-a', table.day);
    const tableB = read('table-b', 'table-b', table.day);
    assert.ok(comparable(tableA).length > 0);
    assert.deepEqual(comparable(tableA), comparable(tableB), '同一段剧情在两边的时刻和句子逐字相同');
    assert.ok(tableA.events.filter(({ group }) => group?.kind === 'table').length >= storyEvents(tableA).length + 3);
    assert.ok(tableA.people.some(({ user_id }) => user_id === 'table-b'));
    assert.equal(read('table-b', 'table-a', table.day).owner.bond_level, 0, '2 分仍是生面孔');
    for (const id of ['table-a', 'table-b']) {
        const saved = sql.prepare('SELECT kind FROM RoomMoment WHERE user_id = ? AND meet_id = ? ORDER BY kind').all(id, tableMeet.id);
        assert.deepEqual(saved.map(({ kind }) => kind), ['meet'], '剧情星标写进两边');
    }
    const momentCount = sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ? AND meet_id = ?').get('table-a', tableMeet.id).n;
    read('table-a', 'table-a', table.day);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ? AND meet_id = ?').get('table-a', tableMeet.id).n, momentCount);

    // 店不再公开：整串外出和关联名场面不返回
    sql.prepare("UPDATE Place SET moderation_status = 'checking' WHERE id = ?").run(tableMeet.place_id);
    const hiddenShop = read('table-a', 'table-a', table.day);
    assert.equal(meetEvents(hiddenShop, tableMeet.id).length, 0, '下架店铺整组事件不返回');
    assert.equal(hiddenShop.events.some(({ place }) => place?.id === tableMeet.place_id), false);
    assert.equal(moments('table-a', 'table-a', table.day).moments.some(({ kind }) => kind === 'meet' || kind === 'bond'), false);
    sql.prepare("UPDATE Place SET moderation_status = 'visible' WHERE id = ?").run(tableMeet.place_id);

    // 屏蔽 / 仅自己可见 / 封禁：拼桌换回一个人吃（同店同样时长），名场面隐藏
    for (const [label, apply, undo] of [
        ['屏蔽', () => sql.prepare("INSERT INTO UserBlock (user_id, blocked_id) VALUES ('table-b', 'table-a')").run(),
            () => sql.prepare('DELETE FROM UserBlock').run()],
        ['仅自己可见', () => sql.prepare("UPDATE RoomProfile SET visibility = 'self' WHERE user_id = 'table-b'").run(),
            () => sql.prepare("UPDATE RoomProfile SET visibility = 'residents' WHERE user_id = 'table-b'").run()],
        ['封禁', () => sql.prepare("UPDATE User SET is_banned = 1, ban_expires = '2999-01-01T00:00:00.000Z' WHERE id = 'table-b'").run(),
            () => sql.prepare("UPDATE User SET is_banned = 0, ban_expires = NULL WHERE id = 'table-b'").run()]
    ]) {
        apply();
        assert.throws(() => read('table-b', 'table-a', table.day), { code: 'room_not_found' }, label);
        const fallback = read('table-a', 'table-a', table.day);
        const solo = fallback.events.filter((event) => event.group?.kind === 'outing'
            && event.start_min >= tableMeet.start_min && event.end_min <= tableMeet.end_min);
        assert.ok(solo.length >= 1, `${label} 后拼桌应换回一个人吃`);
        assert.equal(solo[0].start_min, tableMeet.start_min, label);
        assert.equal(solo.at(-1).end_min, tableMeet.end_min, label);
        assert.equal(solo[0].group.place.id, tableMeet.place_id, label);
        assert.equal(storyEvents(fallback).length, 0, label);
        assert.equal(moments('table-a', 'table-a', table.day).moments.some(({ kind }) => kind === 'meet' || kind === 'bond'), false, label);
        undo();
    }

    // ---- 拼桌候选不足 5 家改隔空；避雷和低档评价不选 ----
    disableAllRooms();
    const fewCity = '四家城';
    for (let i = 0; i < 4; i += 1) addPlace(`四家小馆${i}`, fewCity);
    const fallbackDefs = [{ id: 'few-a', city: fewCity }, { id: 'few-b', city: fewCity }];
    const few = await findSchedule(fallbackDefs, { start: daysBefore(BASE, -20), cities: { 'few-a': fewCity, 'few-b': fewCity } });
    assert.equal(few.meet.kind, 'remote', '同城候选少于 5 家改隔空');
    assert.equal(few.meet.place_id, null);

    disableAllRooms();
    const filterCity = '筛选城';
    const filterPlaces = Array.from({ length: 6 }, (_, i) => addPlace(`筛选小馆${i}`, filterCity));
    sql.prepare("UPDATE Place SET category = '避雷' WHERE id = ?").run(filterPlaces[0]);
    prepareRoom(daysBefore(BASE, 10), { id: 'filter-probe', city: filterCity });
    for (const id of ['filter-probe', 'filter-a', 'filter-b']) {
        sql.prepare('INSERT OR IGNORE INTO User (id, username, password) VALUES (?, ?, ?)').run(id, id, 'unused');
        sql.prepare(`INSERT INTO PlaceRating (user_id, place_id, score, source, created_at, updated_at)
            VALUES (?, ?, 2, 'user', 0, 0)`).run(id, filterPlaces[1]);
    }
    const context = loadOutingContext(sql, 'filter-probe', { city: filterCity });
    assert.equal(context.candidates.some(({ id }) => id === filterPlaces[0]), false, '避雷店不选');
    assert.equal(context.candidates.some(({ id }) => id === filterPlaces[1]), false, '任一方评 2 档以下的店不选');
    assert.equal(context.candidates.length, 4, '六家里只剩四家可用');
    const filteredDefs = [{ id: 'filter-a', city: filterCity }, { id: 'filter-b', city: filterCity }];
    const filtered = await findSchedule(filteredDefs, { start: daysBefore(BASE, -40), cities: { 'filter-a': filterCity, 'filter-b': filterCity } });
    assert.equal(filtered.meet.kind, 'remote', '可用不足 5 家改隔空');

    // ---- 隔空：+1、双方清醒时段与 19:00–22:30 的交集 ----
    disableAllRooms();
    const remoteDefs = [
        { id: 'remote-a', city: '甲城', name: '甲', tags: ['夜猫子'] },
        { id: 'remote-b', city: '乙城', name: '乙', tags: ['早起'] }
    ];
    const remote = await findSchedule(remoteDefs, { start: daysBefore(BASE, -60), cities: { 'remote-a': '甲城', 'remote-b': '乙城' } });
    assert.equal(remote.meet.kind, 'remote');
    assert.equal(remote.meet.place_id, null);
    assert.equal(pairBond(sql, 'remote-a', 'remote-b'), 1, '隔空 +1');
    for (const def of remoteDefs) {
        const awake = awakeWindow({ userId: def.id, day: remote.day,
            sheet: { name: def.name, tags: def.tags, untagged: [], answers: {}, quirks: [], sayings: [] } });
        assert.ok(remote.meet.start_min >= Math.max(19 * 60, awake.wake_min));
        assert.ok(remote.meet.end_min <= Math.min(22 * 60 + 30, awake.sleep_min));
    }
    const remoteA = read('remote-a', 'remote-a', remote.day);
    const remoteB = read('remote-b', 'remote-b', remote.day);
    assert.ok(comparable(remoteA).length > 0);
    assert.deepEqual(comparable(remoteA), comparable(remoteB));
    assert.ok(remoteA.events.some(({ group }) => group?.kind === 'remote' && group.place === null));

    // ---- 熟悉度升级：两边各一条 bond 名场面 ----
    disableAllRooms();
    const upgradeDefs = [{ id: 'up-a', city: '升级城' }, { id: 'up-b', city: '升级城' }];
    for (let i = 0; i < 5; i += 1) addPlace(`升级小馆${i}`, '升级城');
    // 先让初始分停在 3：拼桌 +2 后到 5，跨过 4。
    for (const id of ['up-a', 'up-b']) {
        sql.prepare('INSERT OR IGNORE INTO User (id, username, password) VALUES (?, ?, ?)').run(id, id, 'unused');
    }
    sql.prepare('INSERT INTO RoomBond (user_low, user_high, score, updated_at_ms) VALUES (?, ?, 3, 0)')
        .run(...orderedUsers('up-a', 'up-b'));
    const upgrade = await findSchedule(upgradeDefs, { start: daysBefore(BASE, -100), cities: { 'up-a': '升级城', 'up-b': '升级城' } });
    assert.equal(upgrade.meet.kind, 'table');
    assert.ok(upgrade.meet.bond_script_id, '升级剧情要挂上');
    assert.equal(pairBond(sql, 'up-a', 'up-b'), 5);
    const upA = read('up-a', 'up-a', upgrade.day);
    const upB = read('up-b', 'up-b', upgrade.day);
    assert.ok(storyEvents(upA).some(({ type }) => type === 'bond'));
    assert.deepEqual(comparable(upA), comparable(upB));
    for (const id of ['up-a', 'up-b']) {
        assert.deepEqual(sql.prepare('SELECT kind FROM RoomMoment WHERE user_id = ? AND meet_id = ? ORDER BY kind')
            .all(id, upgrade.meet.id).map(({ kind }) => kind), ['bond', 'meet'], '两边各存升级名场面');
    }

    // ---- 配对过滤：互动关闭 / 仅自己可见 / 同好发现关闭 / 屏蔽 / 封禁 / 昨天互动过 ----
    const filterCases = [
        { name: 'meets-off', a: { meets: 0 }, b: {} },
        { name: 'self-only', a: { visibility: 'self' }, b: {} },
        { name: 'discovery-off', a: { discovery: 0 }, b: {} },
        { name: 'blocked', a: {}, b: {}, block: true }
    ];
    for (const [index, entry] of filterCases.entries()) {
        const suffix = entry.name;
        const a = `pair-a-${suffix}`;
        const b = `pair-b-${suffix}`;
        const day = daysBefore(BASE, 20 + index);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        prepareRoom(day, { id: a, city: '配对城', ...entry.a });
        prepareRoom(day, { id: b, city: '配对城', ...entry.b });
        if (entry.block) sql.prepare('INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)').run(b, a);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE day = ?').get(day).n, 0, suffix);
        if (entry.block) sql.prepare('DELETE FROM UserBlock').run();
    }
    {
        const day = daysBefore(BASE, 30);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        const a = 'pair-a-name', b = 'pair-b-name';
        prepareRoom(day, { id: a, city: '配对城' });
        prepareRoom(day, { id: b, city: '配对城' });
        sql.prepare("UPDATE User SET is_banned = 1, ban_expires = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(b);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE day = ?').get(day).n, 0, '封禁');
    }
    {
        const day = daysBefore(BASE, 32);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        const a = 'pair-a-yesterday', b = 'pair-b-yesterday';
        prepareRoom(day, { id: a, city: '配对城' });
        prepareRoom(day, { id: b, city: '配对城' });
        sql.prepare(`INSERT INTO RoomMeet (day, kind, x_user, y_user, script_id, start_min, end_min, seed, created_at_ms)
            VALUES (?, 'remote', ?, ?, 'remote.x', 1200, 1230, 'seed', 0)`).run(daysBefore(day, 1), a, b);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE day = ?').get(day).n, 0, '昨天互动过');
    }
    {
        // 一只一天最多一段：四只同城、五个候选，任一只不得出现在两段里。
        const day = daysBefore(BASE, 34);
        usedDays.add(day);
        cleanupDay(day);
        disableAllRooms();
        for (let i = 0; i < 5; i += 1) addPlace(`多只小馆${i}`, '多只城');
        const defs = Array.from({ length: 4 }, (_, i) => ({ id: `many-${i}`, city: '多只城' }));
        for (const def of defs) prepareRoom(day, def);
        await runSchedule(sql, { day, now: at(day, '04:31') });
        const users = sql.prepare('SELECT x_user, y_user FROM RoomMeet WHERE day = ?').all(day).flatMap(({ x_user, y_user }) => [x_user, y_user]);
        assert.equal(users.length, new Set(users).size, '同一只一天最多一段');
    }

    // ---- 对方只关了互动：已经发生的照常显示，今天还没开始的消失 ----
    addPlace('互动城小屋', '互动城', '家常菜', 'checking');
    for (const [label, disableAt] of [['已开始', '23:59'], ['未开始', '06:00']]) {
        disableAllRooms();
        const start = daysBefore(BASE, 40 + (label === '未开始' ? 1 : 0));
        const defs = [{ id: `off-a-${label}`, city: '互动城' }, { id: `off-b-${label}`, city: '互动城' }];
        const scheduled = await findSchedule(defs, { start, cities: { [defs[0].id]: '互动城', [defs[1].id]: '互动城' } });
        const day = scheduled.day;
        if (label === '已开始') {
            const before = read(defs[0].id, defs[0].id, day, at(day, disableAt));
            assert.ok(storyEvents(before).length > 0, '互动关闭前剧情在');
        }
        saveProfile(sql, defs[1].id, {
            visibility: 'residents', meets: 0, city: '互动城',
            sheet: { name: '豆丁', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] }
        }, { now: at(day, disableAt) });
        const after = read(defs[0].id, defs[0].id, day, at(day, disableAt));
        if (label === '已开始') assert.ok(storyEvents(after).length > 0, '已开始的剧情照常显示');
        else assert.equal(storyEvents(after).length, 0, '今天还没开始的剧情不再出现');
    }

    // ---- 星标名场面：第一次展开写入、重复读不重复、每人最多 200 条 ----
    {
        const day = daysBefore(BASE, 50);
        usedDays.add(day);
        cleanupDay(day);
        const id = 'moments-owner';
        const sheet = prepareRoom(day, { id, city: null });
        const events = Array.from({ length: 205 }, (_, i) => ({
            type: 'home', start_min: i, end_min: i + 1, sid: 'home.read', vid: null, quirk: null, icon: 'book',
            action: '翻书', sound: null, detail: null, saying: false, star: 'rare', outing: null, place_id: null, meet_id: null
        }));
        sql.prepare(`INSERT INTO RoomDay (user_id, day, sheet_hash, city, corpus_version, events, used, wake_min, sleep_min, generated_at_ms)
            VALUES (?, ?, ?, NULL, ?, ?, '[]', 0, 1440, 0)`).run(id, day, hash(sheet), corpus.version, JSON.stringify(events));
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ?').get(id).n, 0);
        const first = read(id, id, day);
        assert.equal(first.events.filter(({ star }) => star).length, 205);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ?').get(id).n, 200);
        read(id, id, day);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ?').get(id).n, 200, '重复读不重复写，且只留 200 条');
    }

    // ---- 注销级联与另一边的降级 ----
    {
        const day = daysBefore(BASE, 70);
        usedDays.add(day);
        cleanupDay(day);
        const a = 'cascade-a', b = 'cascade-b';
        disableAllRooms();
        for (let i = 0; i < 5; i += 1) addPlace(`注销小馆${i}`, '注销城');
        const cascade = await findSchedule([{ id: a, city: '注销城' }, { id: b, city: '注销城' }],
            { start: day, cities: { [a]: '注销城', [b]: '注销城' } });
        read(a, a, cascade.day);
        read(b, b, cascade.day);
        assert.ok(sql.prepare('SELECT COUNT(*) AS n FROM RoomMoment WHERE user_id = ?').get(b).n > 0);
        sql.prepare('DELETE FROM User WHERE id = ?').run(b);
        for (const table of ['RoomProfile', 'RoomDay', 'RoomOuting', 'RoomMoment', 'RoomTextQuota', 'RoomText']) {
            assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(b).n, 0, table);
        }
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE x_user = ? OR y_user = ?').get(b, b).n, 0);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomBond WHERE user_low = ? OR user_high = ?').get(b, b).n, 0);
        const fallback = read(a, a, cascade.day);
        assert.equal(storyEvents(fallback).length, 0);
        assert.ok(fallback.events.some(({ group }) => group?.kind === 'outing'
            && group.place.id === cascade.meet.place_id), '对方注销后拼桌降级为一个人吃');
        assert.equal(moments(a, a, cascade.day).moments.some(({ kind }) => kind === 'meet' || kind === 'bond'), false);
    }

    console.log('Room social tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
