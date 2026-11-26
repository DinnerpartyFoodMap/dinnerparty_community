const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-p2-'));
const filename = path.join(temp, 'rooms.sqlite');
Object.assign(process.env, { DB_FILE: filename, LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false',
    ROOMS_AUDIENCE: 'all', ROOM_SCHEDULER: 'true', ROOM_TEXT_CHECK: 'false' });

const { db, init } = require('../../infrastructure/database');
const ai = require('../../infrastructure/aiClients');
const { daysBefore } = require('../../infrastructure/beijingClock');
const { getDay, getMoments } = require('../../modules/rooms/services/roomDay');
const { canReadRoom } = require('../../modules/rooms/services/roomAccess');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { awakeWindow } = require('../../modules/rooms/services/roomSimulator');
const { runSchedule } = require('../../modules/rooms/services/roomScheduler');
const { pairRooms } = require('../../modules/rooms/services/roomPairing');
const { saveProfile, clearTexts } = require('../../modules/rooms/services/roomProfile');
const { syncTexts, readTexts, enqueueTextChecks, resumeTextChecks, TEXT_SYSTEM_PROMPT } = require('../../modules/rooms/services/roomTextCheck');
const { cancelFutureMeets } = require('../../modules/rooms/services/roomMeets');
const { consent } = require('../../modules/community/services/communityPreferences');
const sql = db._raw;
const ids = ['a', 'b'];
const dateForPair = (start) => Array.from({ length: 31 }, (_, i) => daysBefore(start, -i))
    .find((day) => pairRooms({ day, rooms: ids.map((userId) => ({ userId, city: '测试城' })) }).length === 1);
const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const nextDay = (day) => daysBefore(day, -1);
const template = (name, tags = []) => ({ name, tags, untagged: [], answers: {}, quirks: [], sayings: [] });
const storyEvents = ({ events }) => events.filter(({ type }) => type === 'meet' || type === 'bond');
const read = (ownerId, viewerId, day, now = at(day, '23:59')) => getDay(sql, { viewerId, ownerId, day, now });

function resident(id, day, options = {}) {
    const { active = true, namedDay = '2026-10-01', city = '测试城', tags = [] } = options;
    const sheet = template('豆丁', tags);
    sql.prepare('INSERT INTO User(id, username, password) VALUES (?, ?, ?)').run(id, `住民${id}`, 'unused');
    sql.prepare(`INSERT INTO RoomProfile (user_id, enabled, named_day, sheet, city, last_opened_at_ms, updated_at_ms)
        VALUES (?, 1, ?, ?, ?, ?, 0)`).run(id, namedDay, JSON.stringify(sheet), city, active ? at(day, '03:00') : null);
    syncTexts(sql, id, sheet, at(day, '03:00'));
}

function place(name, moderation = 'visible') {
    const { id } = sql.prepare(`INSERT INTO Place (name, latitude, longitude, category, moderation_status)
        VALUES (?, 30, 120, '家常菜', ?) RETURNING id`).get(name, moderation);
    sql.prepare("INSERT INTO PlaceRegion (place_id, city, checked_at) VALUES (?, '测试城', 0)").run(id);
    return id;
}

async function main() {
    init();
    const day = dateForPair('2026-11-01');
    for (const id of ids) resident(id, day);
    resident('inactive', day, { active: false });
    resident('new', day, { namedDay: day });
    resident('banned', day);
    resident('paused', day);
    resident('solo', day, { city: null });
    resident('private', day, { city: null });
    sql.prepare("UPDATE User SET is_banned = 1 WHERE id = 'banned'").run();
    sql.prepare("UPDATE User SET map_settings = ? WHERE id = 'paused'").run('{"companion_enabled":false}');
    sql.prepare("UPDATE RoomProfile SET visibility = 'self' WHERE user_id = 'private'").run();
    consent('solo');
    sql.prepare("UPDATE MapConsent SET discovery = 0 WHERE user_id = 'solo'").run();
    for (const id of ['new', 'inactive']) sql.prepare('UPDATE RoomProfile SET meets = 0 WHERE user_id = ?').run(id);
    const approved = Array.from({ length: 5 }, (_, i) => place(`小馆${i}`));
    const avoided = place('避雷小馆');
    sql.prepare("UPDATE Place SET category = '避雷' WHERE id = ?").run(avoided);
    const low = place('低档小馆');
    sql.prepare(`INSERT INTO PlaceRating (user_id, place_id, score, source, created_at, updated_at)
        VALUES ('b', ?, 2, 'user', 0, 0)`).run(low);
    place('审核小馆', 'checking');
    sql.prepare("INSERT INTO RoomBond VALUES ('a', 'b', 2, 0)").run();

    const now = at(day, '04:31');
    process.env.ROOM_SCHEDULER = 'false';
    assert.equal(await runSchedule(sql, { day, now }), false);
    process.env.ROOM_SCHEDULER = 'true';
    process.env.ROOMS_AUDIENCE = 'off';
    assert.equal(await runSchedule(sql, { day, now }), false);
    process.env.ROOMS_AUDIENCE = 'all';
    assert.equal(await runSchedule(sql, { day, now }), true);
    assert.equal(await runSchedule(sql, { day, now }), false);
    assert.ok(sql.prepare('SELECT finished_at_ms FROM RoomSchedulerRun WHERE day = ?').get(day).finished_at_ms >= now);
    assert.deepEqual(sql.prepare('SELECT user_id FROM RoomDay WHERE day = ? ORDER BY user_id').all(day).map(({ user_id }) => user_id),
        ['a', 'b', 'private', 'solo']);
    const [meet] = sql.prepare('SELECT * FROM RoomMeet WHERE day = ?').all(day);
    assert.equal(meet.kind, 'table');
    assert.ok(approved.includes(meet.place_id));
    assert.ok(meet.bond_script_id);
    const visits = sql.prepare("SELECT * FROM RoomOuting WHERE reason = 'meet' AND day = ? ORDER BY user_id").all(day);
    assert.deepEqual(visits.map((row) => [row.user_id, row.meet_id, row.place_id, row.start_min, row.end_min]),
        ids.map((id) => [id, meet.id, meet.place_id, meet.start_min, meet.end_min]));
    assert.equal(sql.prepare('SELECT score FROM RoomBond').get().score, 4);

    const a = read('a', 'a', day);
    const b = read('b', 'b', day);
    const comparable = (response) => storyEvents(response).map(({ group, ...event }) => event);
    assert.deepEqual(comparable(a), comparable(b));
    assert.ok(comparable(a).some(({ action }) => action.includes('住民a的豆丁') && action.includes('住民b的豆丁')));
    assert.ok(a.events.filter(({ group }) => group?.kind === 'table').length >= comparable(a).length + 3);
    assert.deepEqual(a.owner.friends.map(({ user_id, level }) => [user_id, level]), [['b', 1]]);
    for (const id of ids) assert.deepEqual(sql.prepare(`SELECT kind FROM RoomMoment WHERE user_id = ? AND meet_id = ? ORDER BY kind`)
        .all(id, meet.id).map(({ kind }) => kind), ['bond', 'meet']);
    const external = read('a', 'b', day);
    assert.equal(external.owner.bond_level, 1);
    assert.equal(Object.hasOwn(external.owner, 'satiety'), false);
    assert.equal(external.people.find(({ user_id }) => user_id === 'b').avatar, null);
    assert.ok(sql.prepare("SELECT last_visited_at_ms FROM RoomProfile WHERE user_id = 'a'").get().last_visited_at_ms);
    for (const id of ['private', 'paused', 'banned']) {
        assert.equal(canReadRoom(sql, 'b', id), false);
        assert.throws(() => read(id, 'b', day), { code: 'room_not_found' });
    }

    sql.prepare("UPDATE RoomProfile SET meets = 0 WHERE user_id = 'b'").run();
    assert.deepEqual(comparable(read('a', 'a', day)), comparable(a));
    sql.prepare("INSERT INTO UserBlock (user_id, blocked_id) VALUES ('b', 'a')").run();
    assert.equal(canReadRoom(sql, 'a', 'b'), false);
    assert.equal(canReadRoom(sql, 'b', 'a'), false);
    const fallback = read('a', 'a', day).events.filter((event) => event.group?.kind === 'outing'
        && event.start_min >= meet.start_min && event.end_min <= meet.end_min);
    assert.equal(fallback.length, 2);
    assert.deepEqual([fallback[0].start_min, fallback[1].end_min, fallback[1].group.place.id],
        [meet.start_min, meet.end_min, meet.place_id]);
    assert.ok(getMoments(sql, { viewerId: 'a', ownerId: 'a', now: at(day, '23:59') }).moments
        .every(({ kind }) => kind !== 'meet' && kind !== 'bond'));
    sql.prepare('DELETE FROM UserBlock').run();
    sql.prepare("UPDATE RoomProfile SET meets = 1, last_opened_at_ms = ? WHERE user_id IN ('a', 'b')").run(at(nextDay(day), '03:00'));
    await runSchedule(sql, { day: nextDay(day), now: at(nextDay(day), '04:31') });
    assert.equal(sql.prepare('SELECT count(*) AS n FROM RoomMeet WHERE day = ?').get(nextDay(day)).n, 0);

    const remoteDay = dateForPair(daysBefore(day, -2));
    sql.prepare("UPDATE Place SET moderation_status = 'checking' WHERE id = ?")
        .run(approved.find((id) => id !== meet.place_id));
    sql.prepare("UPDATE RoomProfile SET last_opened_at_ms = ? WHERE user_id IN ('a', 'b')").run(at(remoteDay, '03:00'));
    await runSchedule(sql, { day: remoteDay, now: at(remoteDay, '04:31') });
    const remote = sql.prepare('SELECT * FROM RoomMeet WHERE day = ?').get(remoteDay);
    assert.equal(remote.kind, 'remote');
    assert.equal(remote.place_id, null);
    assert.equal(sql.prepare('SELECT score FROM RoomBond').get().score, 5);
    for (const userId of ids) {
        const awake = awakeWindow({ userId, day: remoteDay, sheet: template('豆丁') });
        assert.ok(remote.start_min >= Math.max(19 * 60, awake.wake_min));
        assert.ok(remote.end_min <= Math.min(22 * 60 + 30, awake.sleep_min));
    }
    cancelFutureMeets(sql, 'b', at(remoteDay, '06:00'), 'a');
    assert.equal(storyEvents(read('a', 'a', remoteDay)).length, 0);

    sql.prepare("DELETE FROM User WHERE id = 'b'").run();
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet').get().n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomBond').get().n, 0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM RoomOuting WHERE reason = 'meet'").get().n, 0);
    for (const table of ['RoomProfile', 'RoomDay', 'RoomMoment', 'RoomOuting', 'RoomText']) {
        assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 'b'`).get().n, 0);
    }
    assert.ok(read('a', 'a', day, at(nextDay(remoteDay), '10:00')).events
        .some(({ start_min, group }) => start_min === meet.start_min && group?.kind === 'outing'));

    const night = nextDay(remoteDay);
    resident('owl', night, { city: null, tags: ['夜猫子'] });
    read('owl', 'owl', night);
    const midnight = at(nextDay(night), '00:01');
    const overnight = getDay(sql, { viewerId: 'owl', ownerId: 'owl', now: midnight });
    assert.equal(overnight.day, night);
    assert.equal(overnight.is_today, true);
    assert.equal(overnight.events.some(({ anchor }) => anchor === 'sleep'), false);
    assert.deepEqual(overnight, read('owl', 'owl', night, midnight));
    assert.ok(read('owl', 'owl', night, at(nextDay(night), '08:00')).events.some(({ anchor }) => anchor === 'sleep'));

    process.env.ROOM_TEXT_CHECK = 'true';
    ai.hasDeepseekConfiguration = () => true;
    ai.completeDeepseekJson = async () => { throw new Error('fixture failure'); };
    const sheet = { ...template('糯米'), sayings: ['开饭'] };
    saveProfile(sql, 'a', { visibility: 'residents', meets: 1, city: '测试城', sheet }, { now: at(night, '12:00') });
    await enqueueTextChecks(sql, 'a');
    assert.equal(readTexts(sql, 'a', sheet).name.status, 'checking');
    assert.equal(read('a', 'owl', night).owner.name, '饭桶');
    ai.completeDeepseekJson = async ({ user }) => JSON.parse(user).field === 'name'
        ? { flagged: false, confidence: 0 } : { flagged: true, reason: 'advertising', confidence: 1 };
    await resumeTextChecks(sql);
    assert.deepEqual(readTexts(sql, 'a', sheet), {
        name: { status: 'visible', reason: null }, sayings: [{ text: '开饭', status: 'self_only', reason: '广告引流' }]
    });
    assert.equal(read('a', 'owl', night).owner.name, '糯米');
    sql.transaction(() => clearTexts(sql, 'a', at(night, '12:01')))();
    assert.deepEqual(readTexts(sql, 'a', template('糯米')), {
        name: { status: 'self_only', reason: '管理员清空' }, sayings: []
    });
    assert.equal(read('a', 'a', night).owner.name, '糯米');
    assert.equal(read('a', 'owl', night).owner.name, '饭桶');
    const doc = fs.readFileSync(path.join(__dirname, '../../modules/rooms/doc/README.md'), 'utf8').replaceAll('\r\n', '\n');
    assert.ok(doc.includes(TEXT_SYSTEM_PROMPT));
    assert.ok(loadCorpus().scripts.some(({ id }) => id === meet.script_id));
    console.log('Room P2 smoke passed: schedule, pairing, disclosure, bond, cancellation, cascade, rollover, text checks and prompt.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    sql.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(filename + suffix, { force: true });
    fs.rmdirSync(temp);
});
