const { setImmediate: yieldTurn } = require('node:timers/promises');
const { beijingClock, currentMinute, daysBefore, DAY_MS, MINUTE_MS } = require('../../../infrastructure/beijingClock');
const logger = require('../../../infrastructure/logger');
const { isBanActive } = require('../../accounts/services/userAccess');
const { allowsRooms, isPaused, blockedEitherWay, readRoom } = require('./roomAccess');
const { bondLevel, orderedUsers, readBond, readMeet } = require('./roomMeets');
const { readDay, generateDay, scheduleCutoff, outingMinutes } = require('./roomDay');
const { loadCorpus } = require('./roomCorpus');
const { readOutingPreference, slotWindow, tablePlacePicker, durationRange } = require('./roomOutings');
const { pairRooms } = require('./roomPairing');
const { createRng } = require('./roomRandom');
const { pickScript, pickBondScript, duration, stretchesMeal } = require('./roomScripts');
const { awakeWindow, DINNER_WINDOW } = require('./roomSimulator');

const START_MINUTE = 4 * 60 + 30;
const CHECK_INTERVAL_MS = 5 * MINUTE_MS;
const ACTIVE_MS = 14 * DAY_MS;
const REMOTE_WINDOW = [19 * 60, 22 * 60 + 30];
const LATE_MINUTES = 60;
const PICK_ATTEMPTS = 6;
const BATCH_SIZE = 20;
const pairKey = (a, b) => JSON.stringify(orderedUsers(a, b));

function enabled() {
    return ['admin', 'all'].includes(process.env.ROOMS_AUDIENCE)
        && String(process.env.ROOM_SCHEDULER).trim().toLowerCase() !== 'false';
}

function eligible(room, day, now) {
    return room?.enabled === 1 && room.named_day && room.named_day < day && allowsRooms(room)
        && Math.max(room.last_opened_at_ms ?? -Infinity, room.last_visited_at_ms ?? -Infinity) >= now - ACTIVE_MS
        && !isPaused(room.map_settings) && !isBanActive(room, new Date(now));
}

const canMeet = (room) => room.meets === 1 && room.visibility === 'residents' && room.discovery !== 0;

function scriptHistory(database, a, b, day) {
    const rows = database.prepare(`SELECT day, x_user, y_user, script_id FROM RoomMeet
        WHERE day >= ? AND day < ? AND (x_user IN (?, ?) OR y_user IN (?, ?))`)
        .all(daysBefore(day, 30), day, a, b, a, b);
    const history = { pair: new Set(), a: new Set(), b: new Set() };
    const week = daysBefore(day, 7);
    for (const row of rows) {
        const involvesA = row.x_user === a || row.y_user === a;
        const involvesB = row.x_user === b || row.y_user === b;
        if (involvesA && involvesB) history.pair.add(row.script_id);
        if (row.day >= week && involvesA) history.a.add(row.script_id);
        if (row.day >= week && involvesB) history.b.add(row.script_id);
    }
    return history;
}

function planMeet(database, { a, b, kind, day, clock, corpus }) {
    const minute = day === clock.day ? currentMinute(clock) : -1;
    const [one, two] = [a, b].map((room) => ({
        ...room,
        ...awakeWindow({ userId: room.userId, day, sheet: room.sheet }),
        cutoff: scheduleCutoff(database, room.userId, day, minute)
    }));
    const score = readBond(database, a.userId, b.userId) ?? 0;
    const history = scriptHistory(database, a.userId, b.userId, day);
    const seed = JSON.stringify([day, ...orderedUsers(a.userId, b.userId)]);
    const rng = createRng(seed, 'room-meet-plan-v1');
    const tags = { a: a.sheet.tags, b: b.sheet.tags };
    const bedtime = corpus.situations.find(({ anchor }) => anchor === 'bedtime');
    const bedtimeMinutes = bedtime ? Math.max(bedtime.minutes[1],
        ...bedtime.variants.map(({ minutes }) => minutes?.[1] ?? 0)) : 0;

    // 一段剧情放得下的时间：拼桌按饭点窗口，隔空按晚上；写着正在吃晚饭的隔空放进晚饭时段，问睡了没的放在睡前一小时内
    function timing(kind, window, script, length) {
        const table = kind === 'table';
        const dinner = !table && script.when === 'dinner';
        // 晚饭时段开始前已经定下来的事（比如已经吃过）不能再接“晚饭吃什么”
        if (dinner && Math.max(one.cutoff, two.cutoff) > DINNER_WINDOW[0]) return null;
        const late = !table && script.when === 'late';
        // 睡前那段跟着两边的作息走，夜猫子可以过零点
        const range = dinner ? DINNER_WINDOW : late ? [window[0], Infinity] : window;
        const lead = table ? outingMinutes(corpus, 'pick') + outingMinutes(corpus, 'leave') : 0;
        const back = table ? outingMinutes(corpus, 'back') : 0;
        let earliest = Math.max(range[0], Math.max(one.wake_min, two.wake_min) + (table ? 45 : 0),
            Math.max(one.cutoff, two.cutoff) + lead);
        const latest = Math.min(range[1] - (table ? 1 : length),
            Math.min(one.sleep_min, two.sleep_min) - length - back - bedtimeMinutes);
        if (late) earliest = Math.max(earliest, latest - LATE_MINUTES);
        const first = Math.ceil(earliest / 5);
        const last = Math.floor(latest / 5);
        return length && first <= last ? [first, last] : null;
    }

    function plan(kind, window, slot, place) {
        const table = kind === 'table';
        const exclude = new Set();
        const nextScore = score + (table ? 2 : 1);
        const level = bondLevel(nextScore);
        for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
            const choice = pickScript({ kind, bond: bondLevel(score), ...tags, axis: place?.axis,
                history, rng, corpus, allowRepeat: false, exclude });
            if (!choice) return null;
            const script = corpus.scripts.find(({ id }) => id === choice.script_id);
            const upgrade = level > bondLevel(score) ? pickBondScript({ level, ...tags, rng, corpus }) : null;
            const story = { script_id: choice.script_id, bond_script_id: upgrade?.script_id ?? null, seed };
            // 拼桌一顿饭和一个人出门吃一样长：剧本本身更短时，多出的时间加在吃饭那条上
            const natural = duration(story, corpus);
            const length = table && stretchesMeal(choice.script_id, corpus)
                ? Math.max(natural, createRng(seed, choice.script_id, 'room-meet-length-v1').int(...durationRange(place?.axis)))
                : natural;
            const range = timing(kind, window, script, length);
            if (!range) {
                exclude.add(choice.script_id);
                continue;
            }
            const start_min = rng.int(...range) * 5;
            return { ...story, kind, slot, place_id: place?.id ?? null, start_min, end_min: start_min + length,
                x_user: choice.x === 'a' ? a.userId : b.userId, y_user: choice.y === 'a' ? a.userId : b.userId,
                bond_swap: Number(Boolean(upgrade && upgrade.x !== choice.x)), score: nextScore };
        }
        return null;
    }

    if (kind === 'table') {
        const pickPlace = tablePlacePicker(database, a, b, day, rng);
        const weekday = new Date(day).getUTCDay();
        const slots = weekday === 0 || weekday === 6 ? ['lunch', 'tea', 'dinner'] : ['lunch', 'dinner'];
        if (pickPlace) {
            for (const slot of rng.shuffle(slots)) {
                const used = database.prepare(`SELECT 1 FROM RoomOuting WHERE user_id IN (?, ?) AND day = ? AND slot = ?
                    AND start_min < ?`).get(a.userId, b.userId, day, slot, Math.max(one.cutoff, two.cutoff));
                if (used) continue;
                const table = plan('table', slotWindow(slot), slot, pickPlace(slot));
                if (table) return table;
            }
            return null;
        }
    }
    return plan('remote', REMOTE_WINDOW, null, null);
}

function saveMeet(database, meet, day, now) {
    const { x_user, y_user, kind, script_id, bond_script_id, bond_swap, place_id, start_min, end_min, seed, slot, score } = meet;
    const { id } = database.prepare(`INSERT INTO RoomMeet (day, kind, x_user, y_user, script_id, bond_script_id, bond_swap,
        place_id, start_min, end_min, seed, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(day, kind, x_user, y_user, script_id, bond_script_id, bond_swap, place_id, start_min, end_min, seed, now);
    if (kind === 'table') {
        const remove = database.prepare("DELETE FROM RoomOuting WHERE user_id IN (?, ?) AND day = ? AND slot = ? AND reason IN ('solo', 'explore')");
        remove.run(x_user, y_user, day, slot);
        const insert = database.prepare(`INSERT INTO RoomOuting (user_id, day, slot, place_id, start_min, end_min, reason, meet_id)
            VALUES (?, ?, ?, ?, ?, ?, 'meet', ?)`);
        for (const userId of [x_user, y_user]) insert.run(userId, day, slot, place_id, start_min, end_min, id);
    }
    database.prepare(`INSERT INTO RoomBond (user_low, user_high, score, updated_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_low, user_high) DO UPDATE SET score = excluded.score, updated_at_ms = excluded.updated_at_ms`)
        .run(...orderedUsers(x_user, y_user), score, now);
}

async function runSchedule(database, { day, now = Date.now() } = {}) {
    if (!enabled()) return false;
    now = Number(now);
    const started = Date.now();
    const clock = beijingClock(new Date(now));
    day ??= clock.day;
    if (!database.prepare('INSERT OR IGNORE INTO RoomSchedulerRun (day, started_at_ms) VALUES (?, ?)').run(day, now).changes) return false;

    const rows = database.prepare(`SELECT r.*, u.map_settings, u.admin_level, u.is_banned, u.ban_expires, c.discovery
        FROM RoomProfile r JOIN User u ON u.id = r.user_id LEFT JOIN MapConsent c ON c.user_id = u.id
        WHERE r.enabled = 1 AND r.named_day < ? AND (r.last_opened_at_ms >= ? OR r.last_visited_at_ms >= ?)
        ORDER BY r.user_id`).all(day, now - ACTIVE_MS, now - ACTIVE_MS).filter((room) => eligible(room, day, now));
    const readPreference = database.prepare("SELECT * FROM UserPreference WHERE user_id = ? AND status = 'ready'");
    const rooms = rows.filter(canMeet).map(({ user_id, city }) => ({
        userId: user_id, city, vector: readOutingPreference(readPreference.get(user_id))?.vector
    }));
    const vectors = new Map(rooms.map(({ userId, vector }) => [userId, vector]));
    const unavailable = new Set(database.prepare('SELECT x_user, y_user FROM RoomMeet WHERE day = ?').all(day)
        .flatMap(({ x_user, y_user }) => [x_user, y_user]));
    const excludes = new Set([
        ...database.prepare('SELECT x_user AS a, y_user AS b FROM RoomMeet WHERE day = ?').all(daysBefore(day, 1)),
        ...database.prepare('SELECT user_id AS a, blocked_id AS b FROM UserBlock').all()
    ].map(({ a, b }) => pairKey(a, b)));
    const scores = new Map(database.prepare('SELECT user_low, user_high, score FROM RoomBond').all()
        .map(({ user_low, user_high, score }) => [pairKey(user_low, user_high), score]));
    const pairs = pairRooms({ rooms: rooms.filter(({ userId }) => !unavailable.has(userId)), day,
        eligible: (a, b) => !excludes.has(pairKey(a, b)), level: (a, b) => bondLevel(scores.get(pairKey(a, b))) });
    const corpus = loadCorpus();
    const consent = database.prepare('SELECT discovery FROM MapConsent WHERE user_id = ?');
    const currentRoom = (id) => {
        const room = readRoom(database, id);
        return eligible(room, day, now) ? { ...room, userId: id, sheet: JSON.parse(room.sheet),
            discovery: consent.get(id)?.discovery, vector: vectors.get(id) } : null;
    };
    const generate = (room) => generateDay(database, { userId: room.userId, day, profile: room, sheet: room.sheet,
        clock, now, corpus, stored: readDay(database, room.userId, day), scheduled: true });
    const paired = new Set();
    const processPair = database.transaction(({ a: aId, b: bId, kind }) => {
        const a = currentRoom(aId);
        const b = currentRoom(bId);
        if (!a || !b || !canMeet(a) || !canMeet(b) || blockedEitherWay(database, aId, bId)
            || readMeet(database, aId, day) || readMeet(database, bId, day)) return false;
        const meet = planMeet(database, { a, b, kind: kind === 'table' && a.city && a.city === b.city ? kind : 'remote', day, clock, corpus });
        if (!meet) return false;
        saveMeet(database, meet, day, now);
        generate(a);
        generate(b);
        return true;
    });
    const processSolo = database.transaction((userId) => {
        const room = currentRoom(userId);
        if (room) generate(room);
    });
    let batch = 0;
    for (const pair of pairs) {
        if (processPair.immediate(pair)) {
            paired.add(pair.a);
            paired.add(pair.b);
        }
        batch += 2;
        if (batch >= BATCH_SIZE) {
            batch -= BATCH_SIZE;
            await yieldTurn();
        }
    }
    for (const { user_id } of rows) {
        if (paired.has(user_id)) continue;
        processSolo.immediate(user_id);
        if (++batch === BATCH_SIZE) {
            batch = 0;
            await yieldTurn();
        }
    }
    database.prepare('UPDATE RoomSchedulerRun SET finished_at_ms = ? WHERE day = ?').run(now + Math.max(0, Date.now() - started), day);
    return true;
}

function startRoomScheduler(database) {
    const check = () => {
        const now = Date.now();
        const clock = beijingClock(new Date(now));
        if (currentMinute(clock) < START_MINUTE) return;
        runSchedule(database, { day: clock.day, now }).catch((error) => {
            logger.error('Room scheduling failed', { event: 'room.scheduler.failed', day: clock.day, error });
        });
    };
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    timer.unref();
    const initialCheck = setImmediate(check);
    return () => {
        clearImmediate(initialCheck);
        clearInterval(timer);
    };
}

module.exports = { runSchedule, startRoomScheduler };
