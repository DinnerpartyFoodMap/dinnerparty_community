// 小伙伴剧情的时间：拼桌时长、隔空晚饭、睡前隔空（RM-28 / RM-29 / RM-30）。
// 只通过排程、RoomMeet / RoomOuting / RoomDay 和剧本渲染公开的接口观察，不修改业务代码。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-meet-timing-'));
const filename = path.join(temp, 'rooms.sqlite');
Object.assign(process.env, {
    DB_FILE: filename,
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    ROOMS_AUDIENCE: 'all',
    ROOM_SCHEDULER: 'true',
    ROOM_TEXT_CHECK: 'false'
});

const { db, init } = require('../../infrastructure/database');
const { daysBefore } = require('../../infrastructure/beijingClock');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { runSchedule } = require('../../modules/rooms/services/roomScheduler');
const { renderMeet, duration, mealBeat } = require('../../modules/rooms/services/roomScripts');
const { durationRange } = require('../../modules/rooms/services/roomOutings');
const { getDay, scheduleCutoff } = require('../../modules/rooms/services/roomDay');
const { DINNER_WINDOW } = require('../../modules/rooms/services/roomSimulator');
const { pairRooms } = require('../../modules/rooms/services/roomPairing');
const { syncTexts } = require('../../modules/rooms/services/roomTextCheck');
const { storedClasses, resolvePlaceAxes } = require('../../modules/preferences/services/tasteAxes');

const sql = db._raw;
const corpus = loadCorpus();
const byId = new Map(corpus.scripts.map((script) => [script.id, script]));
const MEAL_IDS = new Set(['home.cook', 'home.delivery', 'home.meal', 'home.dishes', 'home.after-meal']);
const BEDTIME_ID = corpus.situations.find((situation) => situation.anchor === 'bedtime')?.id;
const FORBIDDEN_ALREADY_EATEN = /一个人|独自|吃完|吃空|吃光|见底|干净|剩下|最后一口|一扫而空/;
const failures = [];
const usedDays = new Set();
let placeSeq = 0;

const at = (day, time) => Date.parse(`${day}T${time}:00+08:00`);
const nextDay = (day) => daysBefore(day, -1);
const orderedUsers = (a, b) => a < b ? [a, b] : [b, a];
const sheet = (name, tags = []) => ({ name, tags, untagged: [], answers: {}, quirks: [], sayings: [] });
const readEvents = (userId, day) => JSON.parse(sql.prepare('SELECT events FROM RoomDay WHERE user_id = ? AND day = ?')
    .get(userId, day)?.events ?? '[]');
const readMeet = (day) => sql.prepare('SELECT * FROM RoomMeet WHERE day = ? ORDER BY id').get(day);
const overlaps = (a, b) => a.start_min < b.end_min && b.start_min < a.end_min;
const storyFields = ({ type, start_min, end_min, action, sound, detail }) => ({ type, start_min, end_min, action, sound, detail });

function test(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        console.log(`ok ${name}`);
    }, (error) => {
        failures.push(name);
        console.error(`not ok ${name}\n${error.stack || error}`);
    });
}

function addPlaces(city, count, category) {
    const ids = [];
    for (let index = 0; index < count; index += 1) {
        placeSeq += 1;
        const { id } = sql.prepare(`INSERT INTO Place (name, latitude, longitude, category, moderation_status)
            VALUES (?, 30, 120, ?, 'visible') RETURNING id`).get(`${city}小馆${placeSeq}`, category);
        sql.prepare("INSERT INTO PlaceRegion (place_id, city, checked_at) VALUES (?, ?, 0)").run(id, city);
        ids.push(id);
    }
    return ids;
}

function prepareResident(id, { day, city, name, tags }) {
    const card = sheet(name, tags);
    sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(id, `住民${id}`, 'unused');
    sql.prepare(`INSERT INTO RoomProfile (user_id, enabled, named_day, sheet, city, last_opened_at_ms, updated_at_ms)
        VALUES (?, 1, ?, ?, ?, ?, 0)`).run(id, daysBefore(day, 2), JSON.stringify(card), city, at(day, '03:00'));
    syncTexts(sql, id, card, at(day, '03:00'));
}

function nextPairDay({ a, b, cityA, cityB }) {
    // 用配对函数先确认这一天两个人会被排到一起，避免概率把测试变成空跑。
    const rooms = [{ userId: a, city: cityA }, { userId: b, city: cityB }];
    for (let offset = 0; offset < 150; offset += 1) {
        const day = daysBefore('2026-09-01', -offset);
        if (usedDays.has(day)) continue;
        if (pairRooms({ day, rooms }).length === 1) {
            usedDays.add(day);
            return day;
        }
    }
    throw new Error(`找不到 ${a} / ${b} 能配对的日子`);
}

function setupPair({ a, b, cityA = '测试城', cityB = cityA, tagsA = [], tagsB = [], bond = 0,
    placeCount = 6, placeCategory = '家常菜' }) {
    const day = nextPairDay({ a, b, cityA, cityB });
    sql.prepare('UPDATE RoomProfile SET enabled = 0').run();
    prepareResident(a, { day, city: cityA, name: '阿豆', tags: tagsA });
    prepareResident(b, { day, city: cityB, name: '糯米', tags: tagsB });
    sql.prepare(`INSERT INTO RoomBond (user_low, user_high, score, updated_at_ms)
        VALUES (?, ?, ?, 0)`).run(...orderedUsers(a, b), bond);
    if (placeCount > 0) {
        addPlaces(cityA, placeCount, placeCategory);
        if (cityB !== cityA) addPlaces(cityB, placeCount, placeCategory);
    }
    return { day, a, b };
}

// 用 30 天内的旧剧情把某类剧本全部排除，只留下要观察的剧本。
function forceScripts({ a, b, day, kind, keep }) {
    const keepIds = new Set(Array.isArray(keep) ? keep : [keep]);
    const insert = sql.prepare(`INSERT INTO RoomMeet (day, kind, x_user, y_user, script_id, bond_script_id,
        bond_swap, place_id, start_min, end_min, seed, created_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, 600, 620, ?, 0)`);
    for (const script of corpus.scripts.filter((entry) => entry.kind === kind && !keepIds.has(entry.id))) {
        insert.run(daysBefore(day, 2), kind, a, b, script.id, `force:${day}:${script.id}`);
    }
}

const schedule = (day, now = at(day, '04:31')) => runSchedule(sql, { day, now });
const scriptOf = (meet) => byId.get(meet.script_id);
const naturalDuration = (meet) => duration({
    script_id: meet.script_id,
    bond_script_id: meet.bond_script_id,
    seed: meet.seed
}, corpus);

function placeAxis(placeId) {
    const place = sql.prepare('SELECT id, name, category, description FROM Place WHERE id = ?').get(placeId);
    return place ? resolvePlaceAxes(place, storedClasses(sql).get(place.id)).axes[0] ?? null : null;
}

async function main() {
    init();

    // RM-28：随机排出的拼桌必须不短于剧本；有 mealBeat 时长度受店的主类限制，meal: false 不拉长。
    await test('RM-28 排出的拼桌不短于剧本，meal 时长落在店类范围或等于剧本', async () => {
        const meets = [];
        for (let index = 0; index < 5; index += 1) {
            // 最后一对让拼桌跨过熟悉度门槛，顺带覆盖带升级剧情的 duration(meet)。
            const pair = setupPair({ a: `r28rand${index}a`, b: `r28rand${index}b`, bond: index === 4 ? 3 : 0 });
            assert.equal(await schedule(pair.day), true, `${pair.day} 没有执行排程`);
            const meet = readMeet(pair.day);
            assert.ok(meet, `${pair.day} 没有排出剧情`);
            assert.equal(meet.kind, 'table', `${pair.day} 同城应排拼桌`);
            meets.push(meet);
        }
        assert.equal(meets.length, 5);
        for (const meet of meets) {
            const natural = naturalDuration(meet);
            const length = meet.end_min - meet.start_min;
            const script = scriptOf(meet);
            const meal = mealBeat(script);
            assert.ok(length >= natural, `${meet.day}/${meet.script_id} 时长 ${length} < 剧本 ${natural}`);
            if (meal == null) {
                assert.equal(length, natural, `${meet.day}/${meet.script_id} meal: false 却被拉长`);
            } else {
                const range = durationRange(placeAxis(meet.place_id));
                assert.ok((length >= range[0] && length <= range[1]) || length === natural,
                    `${meet.day}/${meet.script_id} 时长 ${length} 不在 ${range.join('-')} 也不等于剧本 ${natural}`);
            }
        }
    });

    // RM-28：mealBeat 是序号时，只有那条变长，前面不动，后面整体顺延。
    await test('RM-28 mealBeat 为序号时只有吃饭那条变长、后面顺延', async () => {
        const pair = setupPair({ a: 'r28beat-a', b: 'r28beat-b', bond: 0 });
        forceScripts({ ...pair, kind: 'table', keep: 'table.empty-seat' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出拼桌');
        assert.equal(meet.script_id, 'table.empty-seat');
        const meal = mealBeat(scriptOf(meet));
        assert.ok(Number.isInteger(meal) && meal >= 0, `mealBeat=${meal}，应为序号`);
        const base = renderMeet({ ...meet, end_min: undefined }, corpus);
        const rendered = renderMeet(meet, corpus);
        const extra = meet.end_min - base.at(-1).end_min;
        assert.ok(extra > 0, `剧本没有被拉长（extra=${extra}）`);
        assert.equal(rendered.length, base.length);
        assert.equal(rendered.at(-1).end_min, meet.end_min, '最后一条没有在 end_min 结束');
        for (const [index, beat] of rendered.entries()) {
            assert.equal(beat.start_min, index === 0 ? meet.start_min : rendered[index - 1].end_min,
                `第 ${index} 条没有紧挨着上一条`);
            if (index < meal) {
                assert.deepEqual([beat.start_min, beat.end_min], [base[index].start_min, base[index].end_min],
                    `mealBeat 之前的第 ${index} 条不应变化`);
            } else if (index === meal) {
                assert.deepEqual([beat.start_min, beat.end_min], [base[index].start_min, base[index].end_min + extra],
                    `mealBeat 第 ${index} 条应只延长 end_min`);
            } else {
                assert.deepEqual([beat.start_min, beat.end_min],
                    [base[index].start_min + extra, base[index].end_min + extra],
                    `mealBeat 之后的第 ${index} 条应整体顺延 ${extra} 分钟`);
            }
        }
    });

    // RM-28：meal: false 的剧本不拉长，时段就等于剧本本身。
    await test('RM-28 meal: false 的拼桌时长等于剧本本身', async () => {
        const pair = setupPair({ a: 'r28false-a', b: 'r28false-b', bond: 4 });
        forceScripts({ ...pair, kind: 'table', keep: 'table.napkin' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出拼桌');
        assert.equal(meet.script_id, 'table.napkin');
        const script = scriptOf(meet);
        assert.equal(mealBeat(script), null);
        const natural = naturalDuration(meet);
        assert.equal(meet.end_min - meet.start_min, natural, 'meal: false 不应被拉长');
        assert.ok(natural < durationRange(placeAxis(meet.place_id))[0], '这个用例应短于店类时长范围');
        assert.deepEqual(renderMeet(meet, corpus), renderMeet({ ...meet, end_min: undefined }, corpus));
        assert.equal(renderMeet(meet, corpus).at(-1).end_min, meet.end_min);
    });

    // RM-28：剧本本身比店类时长更长时，用剧本的长度。
    await test('RM-28 剧本更长时用剧本本身时长', async () => {
        const pair = setupPair({ a: 'r28long-a', b: 'r28long-b', cityA: '长桌城', cityB: '长桌城',
            bond: 12, placeCategory: '咖啡' });
        forceScripts({ ...pair, kind: 'table', keep: 'table.usual-drink' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出拼桌');
        assert.equal(meet.script_id, 'table.usual-drink');
        const axis = placeAxis(meet.place_id);
        const range = durationRange(axis);
        const natural = naturalDuration(meet);
        assert.ok(natural > range[1], `剧本 ${natural} 应长于 ${axis} 的 ${range.join('-')}`);
        assert.equal(meet.end_min - meet.start_min, natural, '剧本更长时应等于剧本时长');
        assert.notEqual(mealBeat(scriptOf(meet)), null);
        const rendered = renderMeet(meet, corpus);
        assert.equal(rendered[0].start_min, meet.start_min);
        assert.equal(rendered.at(-1).end_min, meet.end_min);
    });

    // RM-28：meal: before 时整段顺延，前面补主人自己的点单和吃饭；两边剧本逐字相同。
    await test('RM-28 meal: before 整段在末尾，getDay 前面补点单吃饭且两边一致', async () => {
        const pair = setupPair({ a: 'r28before-a', b: 'r28before-b', bond: 12 });
        forceScripts({ ...pair, kind: 'table', keep: 'table.last-spoon' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出拼桌');
        assert.equal(meet.script_id, 'table.last-spoon');
        const script = scriptOf(meet);
        assert.equal(mealBeat(script), 'before');
        const base = renderMeet({ ...meet, end_min: undefined }, corpus);
        const rendered = renderMeet(meet, corpus);
        const extra = meet.end_min - base.at(-1).end_min;
        assert.ok(extra > 0, `before 没有多出时间（extra=${extra}）`);
        assert.ok(rendered[0].start_min > meet.start_min, 'before 的第一条应晚于 start_min');
        for (const [index, beat] of rendered.entries()) {
            assert.deepEqual([beat.start_min, beat.end_min],
                [base[index].start_min + extra, base[index].end_min + extra],
                `before 的第 ${index} 条应整体顺延 ${extra} 分钟`);
            assert.equal(beat.start_min, index === 0 ? meet.start_min + extra : rendered[index - 1].end_min);
        }
        assert.equal(rendered.at(-1).end_min, meet.end_min);
        const range = durationRange(placeAxis(meet.place_id));
        assert.ok(meet.end_min - meet.start_min >= range[0] && meet.end_min - meet.start_min <= range[1],
            `before 的拼桌时长 ${meet.end_min - meet.start_min} 不在 ${range.join('-')}`);

        const now = at(nextDay(pair.day), '10:00');
        const first = getDay(sql, { viewerId: pair.a, ownerId: pair.a, day: pair.day, now });
        const second = getDay(sql, { viewerId: pair.b, ownerId: pair.b, day: pair.day, now });
        const stories = (response) => response.events.filter(({ type }) => type === 'meet' || type === 'bond');
        const firstStory = stories(first);
        const secondStory = stories(second);
        assert.ok(firstStory.length > 0, '没有展开剧本');
        assert.equal(firstStory[0].start_min, meet.start_min + extra, '剧本第一条没有落在整段末尾');
        assert.deepEqual(firstStory.map(storyFields), secondStory.map(storyFields), '两边剧本的时刻或句子不同');
        const fallback = first.events.filter((event) => event.start_min >= meet.start_min
            && event.start_min < firstStory[0].start_min && event.group?.kind === 'table'
            && event.group.id === meet.id);
        // getDay 展开后不返回 sid，用情境的句子认出点单和吃饭这两步。
        const fill = (line) => line?.replace(/\{a\}/g, first.owner.name)
            .replace(/\{place\}/g, firstStory[0].place?.name ?? '');
        const linesOf = (situations) => new Set(situations.flatMap(({ variants }) => variants.map(({ action }) => fill(action))));
        const orderLines = linesOf([corpus.situations.find(({ id }) => id === 'outing.order')]);
        const eatLines = linesOf(corpus.situations.filter(({ step }) => step === 'eat'));
        const order = fallback.find(({ action }) => orderLines.has(action));
        const eat = fallback.find(({ action }) => eatLines.has(action));
        assert.ok(order, '拼桌开始到剧本第一条之间没有点单');
        assert.ok(eat, '拼桌开始到剧本第一条之间没有吃饭');
        for (const event of fallback) {
            for (const line of [event.action, event.sound, event.detail]) {
                assert.ok(!line || !FORBIDDEN_ALREADY_EATEN.test(line), `补的点单 / 吃饭写了已吃完：${line}`);
            }
        }
    });

    // RM-29：when: dinner 的隔空占用晚饭时段，两边都不再出门吃或在家吃这顿。
    await test('RM-29 when: dinner 的隔空落在晚饭时段并算作两边晚饭', async () => {
        const pair = setupPair({ a: 'r29dinner-a', b: 'r29dinner-b', cityA: '甲城', cityB: '乙城', bond: 0 });
        forceScripts({ ...pair, kind: 'remote', keep: 'remote.one-word' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出隔空');
        assert.equal(meet.kind, 'remote');
        assert.equal(meet.script_id, 'remote.one-word');
        assert.ok(meet.start_min >= DINNER_WINDOW[0], `开始 ${meet.start_min} 早于晚饭时段`);
        assert.ok(meet.end_min <= DINNER_WINDOW[1], `结束 ${meet.end_min} 晚于晚饭时段`);
        for (const userId of [pair.a, pair.b]) {
            const dinnerOutings = sql.prepare("SELECT * FROM RoomOuting WHERE user_id = ? AND day = ? AND slot = 'dinner'")
                .all(userId, pair.day);
            assert.deepEqual(dinnerOutings, [], `${userId} 仍在晚饭时段出门`);
            const events = readEvents(userId, pair.day);
            const homeDinners = events.filter(({ sid, start_min, end_min }) => MEAL_IDS.has(sid)
                && start_min < DINNER_WINDOW[1] && end_min > DINNER_WINDOW[0]);
            assert.deepEqual(homeDinners, [], `${userId} 仍在晚饭时段在家吃饭`);
            const placeholder = events.filter(({ type, meet_id }) => type === 'meet' && meet_id === meet.id);
            assert.equal(placeholder.length, 1, `${userId} 的隔空占位不是一条`);
            assert.equal(placeholder[0].meal, true, `${userId} 的隔空占位没有 meal: true`);
            assert.deepEqual([placeholder[0].start_min, placeholder[0].end_min], [meet.start_min, meet.end_min]);
        }
    });

    // RM-29：一边当天已有事延伸到晚饭时段之后时，不再选 when: dinner 的剧本。
    await test('RM-29 当天已有事进入晚饭时段之后时不选 dinner 剧本', async () => {
        const pair = setupPair({ a: 'r29cutoff-a', b: 'r29cutoff-b', cityA: '甲城', cityB: '乙城', bond: 0 });
        forceScripts({ ...pair, kind: 'remote', keep: ['remote.one-word', 'remote.wrong-window'] });
        const evening = at(pair.day, '19:30');
        getDay(sql, { viewerId: pair.a, ownerId: pair.a, day: pair.day, now: evening });
        assert.ok(scheduleCutoff(sql, pair.a, pair.day, 19 * 60 + 30) > DINNER_WINDOW[0],
            '预先生成的日程没有越过晚饭时段');
        assert.equal(await schedule(pair.day, evening + 60_000), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '应改选其他隔空剧本');
        assert.notEqual(meet.script_id, 'remote.one-word', '已有晚饭安排时仍选了 when: dinner');
        assert.notEqual(scriptOf(meet).when, 'dinner');
    });

    // RM-29：普通隔空的日子，两边晚饭照常吃，而且不和隔空重叠。
    await test('RM-29 普通隔空日照常吃晚饭且饭不压着隔空', async () => {
        const pair = setupPair({ a: 'r29normal-a', b: 'r29normal-b', cityA: '甲城', cityB: '乙城', bond: 0 });
        forceScripts({ ...pair, kind: 'remote', keep: 'remote.wrong-window' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出隔空');
        assert.equal(meet.script_id, 'remote.wrong-window');
        assert.notEqual(scriptOf(meet).when, 'dinner');
        for (const userId of [pair.a, pair.b]) {
            const events = readEvents(userId, pair.day);
            const dinnerOuting = sql.prepare("SELECT * FROM RoomOuting WHERE user_id = ? AND day = ? AND slot = 'dinner'")
                .get(userId, pair.day);
            const homeDinner = events.find(({ sid, start_min, end_min }) => sid === 'home.meal'
                && start_min >= DINNER_WINDOW[0] && end_min <= DINNER_WINDOW[1]);
            assert.ok(dinnerOuting || homeDinner, `${userId} 这天没有晚饭`);
            if (dinnerOuting) {
                assert.ok(dinnerOuting.start_min >= DINNER_WINDOW[0] && dinnerOuting.start_min < DINNER_WINDOW[1],
                    `${userId} 的晚饭外出不在晚饭时段`);
                assert.ok(!overlaps(dinnerOuting, meet), `${userId} 的晚饭外出和隔空重叠`);
            }
            for (const event of events) {
                if (MEAL_IDS.has(event.sid)) assert.ok(!overlaps(event, meet), `${userId} 的在家吃饭和隔空重叠`);
            }
        }
    });

    // RM-30：夜猫子两边都晚睡时，睡前隔空可以晚于 22:30，但仍要在较早睡前 3 小时内。
    await test('RM-30 late 隔空在较早睡前 3 小时内，夜猫子可以晚于 22:30', async () => {
        const pair = setupPair({ a: 'r30owl-a', b: 'r30owl-b', cityA: '甲城', cityB: '乙城',
            bond: 4, tagsA: ['夜猫子'], tagsB: ['夜猫子'] });
        forceScripts({ ...pair, kind: 'remote', keep: 'remote.brushed-teeth' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出隔空');
        assert.equal(meet.kind, 'remote');
        assert.equal(meet.script_id, 'remote.brushed-teeth');
        assert.equal(scriptOf(meet).when, 'late');
        const sleeps = [pair.a, pair.b].map((userId) => sql.prepare('SELECT sleep_min FROM RoomDay WHERE user_id = ? AND day = ?')
            .get(userId, pair.day).sleep_min);
        const earlier = Math.min(...sleeps);
        assert.ok(meet.start_min > 19 * 60, `开始 ${meet.start_min} 不晚于 19:00`);
        assert.ok(meet.start_min < earlier, `开始 ${meet.start_min} 不早于较早的睡前 ${earlier}`);
        assert.ok(meet.start_min >= earlier - 180, `开始 ${meet.start_min} 距较早的睡前 ${earlier} 超过 3 小时`);
        assert.ok(meet.start_min > 22 * 60 + 30, `夜猫子用例的开始 ${meet.start_min} 没有晚于 22:30`);
        for (const userId of [pair.a, pair.b]) {
            const events = readEvents(userId, pair.day);
            const bedtime = events.find(({ sid }) => sid === BEDTIME_ID);
            assert.ok(bedtime, `${userId} 没有睡前那条`);
            assert.ok(meet.end_min <= bedtime.start_min,
                `${userId} 的隔空结束 ${meet.end_min} 晚于睡前 ${bedtime.start_min}`);
        }
    });

    // RM-30：两边作息不同时，以较早睡着的那位为准。
    await test('RM-30 late 隔空按两边较早睡着的那位', async () => {
        const pair = setupPair({ a: 'r30early-a', b: 'r30early-b', cityA: '甲城', cityB: '乙城',
            bond: 4, tagsA: ['夜猫子'], tagsB: ['早起'] });
        forceScripts({ ...pair, kind: 'remote', keep: 'remote.brushed-teeth' });
        assert.equal(await schedule(pair.day), true);
        const meet = readMeet(pair.day);
        assert.ok(meet, '没有排出隔空');
        assert.equal(meet.script_id, 'remote.brushed-teeth');
        const sleepA = sql.prepare('SELECT sleep_min FROM RoomDay WHERE user_id = ? AND day = ?').get(pair.a, pair.day).sleep_min;
        const sleepB = sql.prepare('SELECT sleep_min FROM RoomDay WHERE user_id = ? AND day = ?').get(pair.b, pair.day).sleep_min;
        const earlier = Math.min(sleepA, sleepB);
        assert.ok(sleepB < sleepA, `早起的一方应更早睡着（${sleepA} / ${sleepB}）`);
        assert.ok(meet.start_min > 19 * 60, `开始 ${meet.start_min} 不晚于 19:00`);
        assert.ok(meet.start_min < earlier, `开始 ${meet.start_min} 不早于较早的睡前 ${earlier}`);
        assert.ok(meet.start_min >= earlier - 180, `开始 ${meet.start_min} 距较早的睡前 ${earlier} 超过 3 小时`);
        for (const userId of [pair.a, pair.b]) {
            const events = readEvents(userId, pair.day);
            const bedtime = events.find(({ sid }) => sid === BEDTIME_ID);
            assert.ok(bedtime, `${userId} 没有睡前那条`);
            assert.ok(meet.end_min <= bedtime.start_min,
                `${userId} 的隔空结束 ${meet.end_min} 晚于睡前 ${bedtime.start_min}`);
        }
    });

    // 排程开关、重复排程和并发排程：一天最多一次，剧情不重复。
    await test('排程开关、重复排程和并发排程', async () => {
        const pair = setupPair({ a: 'rgate-a', b: 'rgate-b', cityA: '甲城', cityB: '乙城', bond: 0 });
        forceScripts({ ...pair, kind: 'remote', keep: 'remote.wrong-window' });
        const now = at(pair.day, '04:31');
        const audience = process.env.ROOMS_AUDIENCE;
        const scheduler = process.env.ROOM_SCHEDULER;
        try {
            process.env.ROOM_SCHEDULER = 'false';
            assert.equal(await runSchedule(sql, { day: pair.day, now }), false);
            assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomSchedulerRun WHERE day = ?').get(pair.day).n, 0);
            process.env.ROOM_SCHEDULER = 'true';
            process.env.ROOMS_AUDIENCE = 'off';
            assert.equal(await runSchedule(sql, { day: pair.day, now }), false);
            assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomSchedulerRun WHERE day = ?').get(pair.day).n, 0);
            process.env.ROOMS_AUDIENCE = 'all';
            const results = await Promise.all([
                runSchedule(sql, { day: pair.day, now }),
                runSchedule(sql, { day: pair.day, now })
            ]);
            assert.equal(results.filter(Boolean).length, 1, `并发排程成功 ${results.filter(Boolean).length} 次`);
            assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE day = ?').get(pair.day).n, 1);
            assert.equal(await runSchedule(sql, { day: pair.day, now }), false);
            assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM RoomMeet WHERE day = ?').get(pair.day).n, 1);
        } finally {
            if (audience === undefined) delete process.env.ROOMS_AUDIENCE;
            else process.env.ROOMS_AUDIENCE = audience;
            if (scheduler === undefined) delete process.env.ROOM_SCHEDULER;
            else process.env.ROOM_SCHEDULER = scheduler;
        }
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    if (failures.length) {
        console.error(`\ntest_room_meet_timing: ${failures.length} 个用例失败`);
        process.exitCode = 1;
    } else {
        console.log('\ntest_room_meet_timing: all passed');
    }
    sql.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(filename + suffix, { force: true });
    fs.rmdirSync(temp);
});
