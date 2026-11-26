const { inferred } = require('../corpus/tags.json');
const { beijingClock } = require('../../../infrastructure/beijingClock');
const { userTasteAxes } = require('../../preferences/services/tasteAxes');
const { createRng } = require('./roomRandom');
const { NAME_MAX, validateName } = require('./roomNames');

const SETTINGS = Object.freeze({
    tasteMinimum: 0.7,
    activityDays: 90,
    activityMinimum: 20,
    activityShare: 0.3,
    night: [1380, 180],
    morning: [330, 510],
    defaultQuirks: 2,
    matchingQuirkWeight: 3,
    tagMax: 10,
    quirkMax: 3,
    sayingMax: 3,
    sayingLength: 8
});

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;

function activityStats(activityMinutes) {
    const count = activityMinutes.length;
    const [nightStart, nightEnd] = SETTINGS.night;
    const [morningStart, morningEnd] = SETTINGS.morning;
    const night = activityMinutes.filter((minute) => minute >= nightStart || minute < nightEnd).length;
    const morning = activityMinutes.filter((minute) => minute >= morningStart && minute < morningEnd).length;
    return {
        count, enough: count >= SETTINGS.activityMinimum,
        night: count ? night / count : 0, morning: count ? morning / count : 0
    };
}

function inferTagsFrom({ axes, activityMinutes }) {
    const basis = {};
    for (const { key, value, basis: evidence } of axes) {
        if (Object.hasOwn(inferred, key) && key !== 'night' && key !== 'morning' && evidence && value >= SETTINGS.tasteMinimum) {
            basis[inferred[key]] = { source: 'taste', axis: key, value };
        }
    }
    const activity = activityStats(activityMinutes);
    const period = activity.night >= activity.morning ? 'night' : 'morning';
    if (activity.enough && activity[period] >= SETTINGS.activityShare) {
        basis[inferred[period]] = { source: 'activity', share: activity[period], count: activity.count };
    }
    return { tags: Object.keys(basis), basis };
}

function readActivityMinutes(database, userId, now) {
    return database.prepare(`SELECT occurred_at FROM UserBehaviorEvent
        WHERE user_id = ? AND occurred_at BETWEEN ? AND ?`)
        .all(userId, Number(now) - SETTINGS.activityDays * DAY_MS, Number(now))
        .map(({ occurred_at }) => Math.floor(beijingClock(new Date(occurred_at)).msOfDay / MINUTE_MS));
}

async function inferTags(database, userId, { now }) {
    const axes = await userTasteAxes(userId, database, { now: Number(now) });
    return inferTagsFrom({ axes, activityMinutes: readActivityMinutes(database, userId, now) });
}

function defaultQuirks(userId, tags, corpus) {
    const rng = createRng(userId, 'room-quirks-v1');
    const remaining = [...corpus.quirks];
    const quirks = [];
    while (quirks.length < SETTINGS.defaultQuirks && remaining.length) {
        const chosen = rng.weighted(remaining, (quirk) => quirk.fits.some((tag) => tags.includes(tag)) ? SETTINGS.matchingQuirkWeight : 1);
        quirks.push(chosen.id);
        remaining.splice(remaining.indexOf(chosen), 1);
    }
    return quirks;
}

function normalizeSheet(input, corpus, { defaultName } = {}) {
    const errors = [];
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isRecord(input)) {
        errors.push('角色卡必须是对象');
        input = {};
    }
    const allowedTags = new Set(corpus.tags.groups.flatMap(({ tags }) => tags));
    const allowedQuirks = new Set(corpus.quirks.map(({ id }) => id));
    const quizzes = new Map(corpus.situations.filter((situation) => situation.quiz != null).map((situation) => [situation.id, situation]));
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (defaultName !== undefined) {
        errors.push(...validateName(input.name, defaultName));
    } else if (input.name != null && typeof input.name !== 'string' || Array.from(name).length > NAME_MAX) {
        errors.push(`名字可留空，填写时最多 ${NAME_MAX} 字`);
    }

    function readList(key, label, limit) {
        const values = input[key] === undefined ? [] : input[key];
        if (!Array.isArray(values)) {
            errors.push(`${label}必须是数组`);
            return [];
        }
        if (values.length > limit) errors.push(`${label}最多 ${limit} 项`);
        return values;
    }

    function knownValues(key, label, allowed, limit) {
        return [...new Set(readList(key, label, limit).filter((value) => {
            if (allowed.has(value)) return true;
            errors.push(typeof value === 'string' ? `${label}里没有「${value}」` : `${label}必须填写名称`);
            return false;
        }))];
    }

    const tags = knownValues('tags', '标签', allowedTags, SETTINGS.tagMax);
    const untagged = knownValues('untagged', '取消的标签', allowedTags, Infinity);
    for (const [a, b] of corpus.tags.exclusive) {
        if (tags.includes(a) && tags.includes(b)) errors.push(`标签「${a}」和「${b}」不能同时出现`);
    }
    for (const tag of untagged) {
        if (tags.includes(tag)) errors.push(`标签「${tag}」不能同时保留和取消`);
    }

    const answers = {};
    if (input.answers !== undefined && !isRecord(input.answers)) errors.push('问答必须是对象');
    for (const [sid, vid] of Object.entries(isRecord(input.answers) ? input.answers : {})) {
        const situation = quizzes.get(sid);
        if (!situation) errors.push(`「${sid}」不是问答情境`);
        else if (typeof vid !== 'string') errors.push(`「${sid}」的做法必须填写编号`);
        else if (!situation.variants.some(({ id, rare }) => id === vid && !rare)) errors.push(`「${sid}」没有做法「${vid}」`);
        else answers[sid] = vid;
    }

    const quirks = knownValues('quirks', '小习惯', allowedQuirks, SETTINGS.quirkMax);
    const sayings = readList('sayings', '口头禅', SETTINGS.sayingMax).flatMap((value, index) => {
        const saying = typeof value === 'string' ? value.trim() : '';
        if (!saying || Array.from(saying).length > SETTINGS.sayingLength || /[「」\r\n\u2028\u2029]/u.test(value)) {
            errors.push(`第 ${index + 1} 条口头禅须为 1 到 ${SETTINGS.sayingLength} 字，且不能有「」或换行`);
            return [];
        }
        return [saying];
    });
    return { sheet: { name, tags, untagged, answers, quirks, sayings }, errors };
}

module.exports = { inferTagsFrom, inferTags, defaultQuirks, normalizeSheet, activityStats, readActivityMinutes };
