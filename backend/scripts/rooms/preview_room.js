const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { beijingClock } = require('../../infrastructure/beijingClock');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { createRng } = require('../../modules/rooms/services/roomRandom');
const { inferTags, defaultQuirks, normalizeSheet } = require('../../modules/rooms/services/roomTraits');
const { awakeWindow, simulateDay, renderEvent, longestIdle } = require('../../modules/rooms/services/roomSimulator');
const { planSoloOutings, loadOutingContext, drawOutingPlace, readOutingPreference } = require('../../modules/rooms/services/roomOutings');
const { pickScript, pickBondScript, renderMeet, renderMeetText } = require('../../modules/rooms/services/roomScripts');
const { pairRooms } = require('../../modules/rooms/services/roomPairing');
const { openSnapshot } = require('./roomPreviewDatabase');

const SETTINGS = Object.freeze({
    days: 3, times: 5, bondLevels: [0, 1, 2, 3],
    tableWindows: [[690, 810], [1050, 1200]], remoteWindow: [1140, 1350], sceneGrid: 5,
    reportDays: 28, sampleMinPlaces: 5, placeHistory: 5, variantHistory: 3
});
const MINUTES_PER_DAY = 1440;
const KINDS = { table: '拼桌', remote: '隔空', bond: '熟悉度升级' };
const USAGE = `npm run room:preview -- [--db <file>] --user <id 或用户名> [--user ...] [--days 3] [--from YYYY-MM-DD] [--sheet <json>] [--city <城市>] [--out <md>]
npm run room:preview -- [--db <file>] --sample 10 [--days 3] [--out <md>]
npm run room:preview -- [--db <file>] --meet <住民A> <住民B> [--kind table|remote] [--bond 0-3] [--times 5] [--out <md>]
npm run room:preview -- [--db <file>] --pairs 5 [--out <md>]
npm run room:preview -- [--db <file>] --city-report`;

function parseOptions(args) {
    const strings = ['db', 'user', 'days', 'from', 'sheet', 'city', 'out', 'sample', 'meet', 'kind', 'bond', 'times', 'pairs'];
    const options = Object.fromEntries(strings.map((key) => [key, { type: 'string', multiple: key === 'user' }]));
    const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { ...options, 'city-report': { type: 'boolean' }, help: { type: 'boolean' } }
    });
    if (values.help) return values;
    const modes = ['user', 'sample', 'meet', 'pairs', 'city-report'].filter((key) => values[key] !== undefined);
    if (modes.length !== 1) throw new Error('请选一个预览模式。用 --help 查看用法。');
    const [mode] = modes;
    if (positionals.length !== (mode === 'meet' ? 1 : 0)) throw new Error('只有 --meet 接受两个住民参数');
    const modeOptions = {
        user: ['days', 'from', 'sheet', 'city', 'out'], sample: ['days', 'out'], meet: ['kind', 'bond', 'times', 'out'],
        pairs: ['out'], 'city-report': []
    };
    for (const key of Object.keys(values)) {
        if (key !== 'db' && key !== mode && !modeOptions[mode].includes(key)) throw new Error(`--${mode} 不接受 --${key}`);
    }
    for (const key of ['days', 'sample', 'pairs', 'times', 'bond']) {
        if (values[key] === undefined) continue;
        const n = Number(values[key]);
        if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(n) || (key === 'bond' ? !SETTINGS.bondLevels.includes(n) : n < 1)) {
            throw new Error(`--${key} 的数值无效`);
        }
        values[key] = n;
    }
    if (values.kind !== undefined && !['table', 'remote'].includes(values.kind)) throw new Error('--kind 必须是 table 或 remote');
    if (values.from !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(values.from) || !Number.isFinite(Date.parse(values.from))
        || addDays(values.from, 0) !== values.from)) throw new Error('--from 必须是有效的 YYYY-MM-DD');
    return { ...values, mode, second: positionals[0] };
}

function addDays(day, count) {
    const date = new Date(day);
    date.setUTCDate(date.getUTCDate() + count);
    return date.toISOString().slice(0, 10);
}

function minuteText(minute) {
    const minutes = minute % MINUTES_PER_DAY;
    const pad = (value) => String(value).padStart(2, '0');
    return `${minute >= MINUTES_PER_DAY ? '次日 ' : ''}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function lineFor(event, text, note = '', indent = '') {
    const { start_min: start, end_min: end } = event;
    return `${indent}${minuteText(start)}（${end - start} 分钟） [${event.icon ?? 'chat'}] ${[text.action, text.sound, text.detail]
        .filter(Boolean).join(' · ')}${note}${event.star ? ' ★' : ''}  `;
}

function resident(database, token) {
    const user = database.prepare('SELECT id, username FROM User WHERE id = ? OR username = ? ORDER BY id = ? DESC LIMIT 1').get(token, token, token);
    if (!user) throw new Error(`找不到住民「${token}」`);
    return user;
}

function vectorResidents(database) {
    const rows = database.prepare(`SELECT p.*, u.id, u.username, l.city
        FROM UserPreference p JOIN User u ON u.id = p.user_id JOIN UserLastLocation l ON l.user_id = u.id
        WHERE p.status = 'ready' AND l.city IS NOT NULL AND trim(l.city) != '' ORDER BY u.id`).all();
    return rows.flatMap((row) => {
        const preference = readOutingPreference(row);
        return preference ? [{ id: row.id, userId: row.id, username: row.username, city: row.city, vector: preference.vector }] : [];
    });
}

async function inferPreviewTags(database, users) {
    const now = database.prepare('SELECT MAX(occurred_at) AS latest FROM UserBehaviorEvent').get().latest ?? 0;
    const pool = [];
    for (const user of users) {
        const { tags } = await inferTags(database, user.id, { now });
        pool.push({ ...user, tags });
    }
    return pool;
}

async function sampleResidents(database, count) {
    const shuffled = createRng('room-sample-v1').shuffle(vectorResidents(database));
    const pool = await inferPreviewTags(database, shuffled);
    const covered = new Set();
    const chosen = [];
    while (chosen.length < count && pool.length) {
        const gain = ({ tags }) => tags.filter((tag) => !covered.has(tag)).length;
        pool.sort((a, b) => gain(b) - gain(a));
        const user = pool.shift();
        const context = loadOutingContext(database, user.id);
        if (context.candidates.length < SETTINGS.sampleMinPlaces) continue;
        chosen.push({ ...user, context });
        for (const tag of user.tags) covered.add(tag);
    }
    return chosen;
}

async function dailyPreview(database, options, corpus, now) {
    const start = options.from ?? beijingClock(now).day;
    const extra = options.sheet ? JSON.parse(fs.readFileSync(options.sheet, 'utf8').replace(/^\uFEFF/, '')) : {};
    if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('角色卡必须是对象');
    const users = options.sample
        ? await sampleResidents(database, options.sample)
        : options.user.map((token) => resident(database, token));
    const lines = ['# 观察屋时间线', ''];
    if (options.sample && users.length < options.sample) lines.push(`符合条件的住民共 ${users.length} 位。`, '');
    for (const user of users) {
        const inferred = user.tags ?? (await inferTags(database, user.id, { now })).tags;
        const tags = Array.isArray(extra.untagged) && extra.tags === undefined
            ? inferred.filter((tag) => !extra.untagged.includes(tag)) : inferred;
        const { sheet, errors } = normalizeSheet({ tags, quirks: defaultQuirks(user.id, tags, corpus), ...extra }, corpus);
        if (errors.length) throw new Error(`${user.username}的角色卡有误\n${errors.join('\n')}`);
        const { city, candidates, personalize } = user.context ?? loadOutingContext(database, user.id, { city: options.city });
        const name = sheet.name || user.username;
        const visits = [];
        const variants = [];
        const places = new Map(candidates.map(({ id, name }) => [id, name]));
        for (let i = 0; i < (options.days ?? SETTINGS.days); i += 1) {
            const day = addDays(start, i);
            const params = { userId: user.id, day, sheet };
            const awake = awakeWindow(params);
            const outings = planSoloOutings({ ...params, ...awake, candidates, personalize,
                recentPlaceIds: visits.slice(-SETTINGS.placeHistory).flat() });
            const { events, used } = simulateDay({ ...params, outings, corpus, recent: variants.slice(-SETTINGS.variantHistory).flat() });
            visits.push([...new Set(events.filter(({ type }) => type === 'outing').map(({ place_id }) => place_id))]);
            variants.push(used);
            lines.push(`## ${name} · ${day}`,
                `标签 ${sheet.tags.join('、') || '无'} ｜ 小习惯 ${sheet.quirks.map((id) => corpus.quirks.find((q) => q.id === id).name).join('、') || '无'} ｜ 城市 ${city ?? '未知'} ｜ 起床 ${minuteText(awake.wake_min)} ｜ 睡觉 ${minuteText(awake.sleep_min)}`,
                `条数 ${events.filter(({ type }) => type !== 'meet').length} ｜ 最长空闲 ${longestIdle(events, awake.wake_min, awake.sleep_min)} 分钟`, '');
            for (const event of events) {
                const notes = [
                    event.saying ? '〔口头禅〕' : '',
                    event.quirk ? `〔小习惯：${corpus.quirks.find(({ id }) => id === event.quirk).name}〕` : ''
                ].join('');
                lines.push(lineFor(event, renderEvent(event, { name, places }), notes, event.type === 'outing' ? '  ' : ''));
            }
            lines.push('');
        }
    }
    return lines.join('\n');
}

function sceneLines(choice, a, b, place, level, kind, seed, start, corpus) {
    const names = [a.username, b.username];
    const x = names[choice.x === 'a' ? 0 : 1];
    const y = names[choice.y === 'a' ? 0 : 1];
    const title = `### ${KINDS[kind]} · 熟悉度 ${level} · ${choice.script_id}`;
    const beats = renderMeet({ script_id: choice.script_id, seed, start_min: start }, corpus);
    return [title, `x 由 ${x} 演，y 由 ${y} 演 ｜ 店名 ${place?.name ?? '—'}`, '',
        ...beats.map((event) => lineFor(event, renderMeetText(event, { x, y, place: place?.name }))), ''];
}

function sceneStart(kind, rng) {
    const [start, end] = kind === 'table' ? rng.pick(SETTINGS.tableWindows) : SETTINGS.remoteWindow;
    return start + SETTINGS.sceneGrid * rng.int(0, (end - start) / SETTINGS.sceneGrid - 1);
}

function meetPreview(database, a, b, options, corpus) {
    const tagsA = a.tags;
    const tagsB = b.tags;
    const roles = { a: tagsA, b: tagsB, corpus };
    const seed = createRng(a.id, b.id, 'room-preview-meet-v1');
    const clock = createRng(a.id, b.id, 'room-preview-meet-time-v1');
    const kinds = options.kind ? [options.kind] : ['table', 'remote'];
    const levels = options.bond === undefined ? SETTINGS.bondLevels : [options.bond];
    const count = options.times ?? SETTINGS.times;
    const context = kinds.includes('table') ? loadOutingContext(database, a.id) : null;
    const history = { pair: new Set(), a: new Set(), b: new Set() };
    const lines = [`## ${a.username} × ${b.username}`, `${a.username} ${tagsA.join('、') || '无标签'} ｜ ${b.username} ${tagsB.join('、') || '无标签'}`, ''];
    for (const kind of kinds) {
        const scenes = new Map(levels.map((level) => [level, []]));
        for (let i = 0; i < count; i += 1) {
            let selected = false;
            for (const level of levels) {
                const scripts = corpus.scripts.filter((script) => script.kind === kind && script.bond[0] <= level
                    && level <= script.bond[1] && !history.pair.has(script.id));
                if (!scripts.length) continue;
                const place = kind === 'table' ? drawOutingPlace(context.candidates, 'dinner', seed, context.personalize,
                    (candidate) => scripts.some((script) => !script.axis || script.axis === candidate.axis)) : null;
                if (kind === 'table' && !place) continue;
                const choice = pickScript({ ...roles, kind, bond: level, axis: place?.axis, history, rng: seed });
                if (!choice || history.pair.has(choice.script_id)) continue;
                history.pair.add(choice.script_id);
                selected = true;
                scenes.get(level).push(sceneLines(choice, a, b, place, level, kind, seed.next(), sceneStart(kind, clock), corpus));
            }
            if (!selected) break;
        }
        for (const [level, group] of scenes) {
            lines.push(...group.flat());
            if (group.length < count) {
                const reason = kind === 'table' && !context.candidates.length ? '住民 A 没有同城候选店' : '可用且未演过的剧本不足';
                lines.push(`熟悉度 ${level} 的${KINDS[kind]}演出 ${group.length}/${count} 段（${reason}）。`, '');
            }
        }
    }
    for (const level of SETTINGS.bondLevels.slice(1)) {
        const choice = pickBondScript({ ...roles, level, rng: seed });
        if (choice) lines.push(...sceneLines(choice, a, b, null, level, 'bond', seed.next(), sceneStart('bond', clock), corpus));
    }
    return lines.join('\n');
}

function groupCities(rooms) {
    const cities = new Map();
    for (const room of rooms) {
        if (!cities.has(room.city)) cities.set(room.city, []);
        cities.get(room.city).push(room);
    }
    return cities;
}

function adjacentPairs(rooms) {
    const pairs = [];
    for (let i = 0; i + 1 < rooms.length; i += 2) pairs.push([rooms[i], rooms[i + 1]]);
    return pairs;
}

async function pairsPreview(database, options, corpus) {
    const rng = createRng('room-preview-pairs-v1');
    const cities = groupCities(await inferPreviewTags(database, rng.shuffle(vectorResidents(database))));
    const preferred = [];
    const tagged = [];
    const untagged = [];
    for (const rooms of cities.values()) {
        const rich = rooms.filter(({ tags }) => tags.length >= 2);
        const preferredCount = rich.length - rich.length % 2;
        preferred.push(...adjacentPairs(rich.slice(0, preferredCount)));
        const withTags = [...rich.slice(preferredCount), ...rooms.filter(({ tags }) => tags.length === 1)];
        const withoutTags = rooms.filter(({ tags }) => !tags.length);
        // Use one tagged resident per pair where possible before using two.
        const mixed = Math.min(withTags.length, withoutTags.length);
        for (let i = 0; i < mixed; i += 1) {
            const pair = [withTags[i], withoutTags[i]];
            tagged.push(rng.chance(0.5) ? pair : pair.reverse());
        }
        tagged.push(...adjacentPairs(withTags.slice(mixed)));
        untagged.push(...adjacentPairs(withoutTags.slice(mixed)));
    }
    const pairs = [preferred, tagged, untagged].flatMap((group) => rng.shuffle(group));
    const lines = ['# 观察屋同城剧情', ''];
    if (pairs.length < options.pairs) lines.push(`符合条件的同城组合共 ${pairs.length} 对。`, '');
    for (const [a, b] of pairs.slice(0, options.pairs)) {
        lines.push(meetPreview(database, a, b, options, corpus));
    }
    return lines.join('\n');
}

function cityReport(database, start) {
    const rooms = vectorResidents(database);
    const byId = new Map(rooms.map((room) => [room.userId, room]));
    const cities = [...groupCities(rooms)];
    cities.sort(([a, groupA], [b, groupB]) => groupB.length - groupA.length || a.localeCompare(b, 'zh-CN'));
    const stats = new Map(cities.map(([city, group]) => [city, { count: group.length, table: 0, remote: 0, active: 0 }]));
    for (let i = 0; i < SETTINGS.reportDays; i += 1) {
        for (const { a, b, kind } of pairRooms({ rooms, day: addDays(start, i) })) {
            const first = stats.get(byId.get(a).city);
            const second = stats.get(byId.get(b).city);
            first[kind] += 1;
            if (first !== second) second[kind] += 1;
            first.active += 1;
            second.active += 1;
        }
    }
    const average = (total) => (total / SETTINGS.reportDays).toFixed(2);
    return ['# 观察屋城市统计', '',
        `${start} 至 ${addDays(start, SETTINGS.reportDays - 1)} · ${rooms.length} 位住民 · ${cities.length} 座城市`, '',
        '| 城市 | 住民 | 日均拼桌 | 日均隔空 | 日均有剧情 |', '| --- | ---: | ---: | ---: | ---: |',
        ...[...stats].map(([city, { count, table, remote, active }]) =>
            `| ${city} | ${count} | ${average(table)} | ${average(remote)} | ${(100 * active / (SETTINGS.reportDays * count)).toFixed(1)}% |`), ''].join('\n');
}

function writePreview(file, databaseFile, markdown) {
    const target = path.resolve(file);
    const resolvedDb = fs.realpathSync(databaseFile);
    const existing = fs.existsSync(target) ? fs.realpathSync(target) : target;
    const comparable = (name) => process.platform === 'win32' ? name.toLowerCase() : name;
    if (['', '-wal', '-shm', '-journal'].some((suffix) => comparable(existing) === comparable(resolvedDb + suffix))) {
        throw new Error('--out 不能指向快照或其附属文件');
    }
    if (fs.existsSync(target)) {
        const fd = fs.openSync(target, 'r');
        try {
            const header = Buffer.alloc(16);
            fs.readSync(fd, header, 0, header.length, 0);
            if (header.toString('ascii') === 'SQLite format 3\0' || [0x377f0682, 0x377f0683].includes(header.readUInt32BE(0))) {
                throw new Error('--out 不能覆盖 SQLite 文件');
            }
        } finally {
            fs.closeSync(fd);
        }
    }
    fs.writeFileSync(target, markdown, 'utf8');
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) return console.log(USAGE);
    const now = new Date();
    const database = openSnapshot(options.db);
    try {
        let markdown;
        if (options.mode === 'city-report') {
            markdown = cityReport(database, beijingClock(now).day);
        } else {
            const corpus = loadCorpus();
            if (options.mode === 'meet') {
                const a = resident(database, options.meet);
                const b = resident(database, options.second);
                if (a.id === b.id) throw new Error('请指定两位不同的住民');
                const [first, second] = await inferPreviewTags(database, [a, b]);
                markdown = `# 观察屋剧情\n\n${meetPreview(database, first, second, options, corpus)}`;
            } else if (options.mode === 'pairs') markdown = await pairsPreview(database, options, corpus);
            else markdown = await dailyPreview(database, options, corpus, now);
        }
        if (options.out) writePreview(options.out, database.name, markdown);
        process.stdout.write(markdown);
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
