const { createRng } = require('./roomRandom');
const { isDinnerMeet } = require('./roomScripts');

const SETTINGS = Object.freeze({
    awake: { default: [480, 1440], early: [390, 1350], night: [630, 1590] },
    awakeJitter: 20,
    mealWindows: [[690, 810], [1050, 1200]],
    bothAfterMeal: 0.3,
    eventTarget: [15, 20],
    maxIdle: 120,
    fillSearchStep: 10,
    fillExpectedDuration: 25,
    answerWeight: 0.7,
    fittingWeight: 3,
    rareWeight: 0.25,
    weightFloor: 0.08,
    recentWeight: 0.05,
    soundChance: 0.5,
    detailChance: 0.7,
    sayingChance: 0.25,
    quirkChance: 0.35,
    starLimit: 2
});

const MEAL_SITUATIONS = new Set(['home.cook', 'home.delivery', 'home.meal', 'home.dishes', 'home.after-meal']);
const BODY_STEPS = ['arrive', 'order', 'wait', 'serve', 'eat', 'spicy', 'full', 'pay'];
const OPTIONAL_DROP_ORDER = ['pay', 'full', 'serve', 'wait'];
const DAY_MS = 86_400_000;
const DAY_MINUTES = 1440;

function awakeWindow({ userId, day, sheet }) {
    const rng = createRng(userId, day, 'room-wake-v1');
    const window = sheet.tags.includes('早起') ? SETTINGS.awake.early
        : sheet.tags.includes('夜猫子') ? SETTINGS.awake.night : SETTINGS.awake.default;
    const jitter = () => rng.int(-SETTINGS.awakeJitter, SETTINGS.awakeJitter);
    return { wake_min: window[0] + jitter(), sleep_min: window[1] + jitter() };
}

const variantKey = (situation, variant) => `${situation.id}:${variant.id}`;
const intersects = (a, b) => a.start_min < b.end_min && b.start_min < a.end_min;
const dayOrder = (a, b) => a.start_min - b.start_min;
const sequence = (start, end) => Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);

function windowEnd(window, start) {
    if (!window) return Infinity;
    const ranges = Array.isArray(window[0]) ? window : [window];
    return ranges.reduce((end, [lo, hi]) => lo <= start && start < hi ? Math.max(end, hi) : end, -Infinity);
}

function availableVariants(state, situation, place) {
    return situation.variants.filter((variant) => (!variant.fits?.length
        || !variant.fits.every((tag) => state.sheet.untagged.includes(tag)))
        && (!variant.axes || variant.axes.includes(place?.axis)));
}

function timingOptions(state, situation, start, until, { place, wholeWindow, exact, stretch } = {}) {
    const situationEnd = windowEnd(situation.window, start);
    if (situationEnd <= start) return [];
    const limit = wholeWindow ? Math.min(until, situationEnd) : until;
    return availableVariants(state, situation, place).flatMap((variant) => {
        if (windowEnd(variant.window, start) <= start) return [];
        let [min, max] = variant.minutes || situation.minutes;
        if (exact !== undefined) {
            if (exact < min || exact > max && (variant.minutes || !stretch)) return [];
            min = max = exact;
        }
        max = Math.min(max, limit - start);
        return min <= max ? [{ variant, min, max }] : [];
    });
}

function pickVariant(state, situation, options) {
    if (!options.length) return null;
    const { sheet, used, recent, rng } = state;
    const unused = options.filter(({ variant }) => !used.has(variantKey(situation, variant)));
    const allowed = unused.length ? unused : options;
    const answer = allowed.find(({ variant }) => variant.id === sheet.answers[situation.id]);
    const weights = allowed.map((option) => {
        if (answer) return option === answer ? SETTINGS.answerWeight : (1 - SETTINGS.answerWeight) / (allowed.length - 1);
        const { variant } = option;
        const fits = variant.fits?.some((tag) => sheet.tags.includes(tag));
        return (fits ? SETTINGS.fittingWeight : 1) * (variant.rare ? SETTINGS.rareWeight : 1);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    // Floor the normalized weights before applying the recent-history penalty.
    const distribution = allowed.map((option, index) => {
        const base = answer ? weights[index] : Math.max(SETTINGS.weightFloor, weights[index] / total);
        const cooldown = option !== answer && recent.has(variantKey(situation, option.variant));
        return { option, weight: base * (cooldown ? SETTINGS.recentWeight : 1) };
    });
    return rng.weighted(distribution, ({ weight }) => weight).option;
}

function placement({ type, start, end, outing = null, meetId = null }) {
    return {
        type, start_min: start, end_min: end, sid: null, vid: null, quirk: null, icon: null, action: null,
        sound: null, detail: null, saying: false, star: null, outing, place_id: outing?.place.id ?? null, meet_id: meetId
    };
}

function addEvent(state, situation, option, start, end, outing = null) {
    const { variant } = option;
    const { rng, sheet } = state;
    const habit = state.quirks.find(({ quirk, hooks }) => !state.usedQuirks.has(quirk.id)
        && hooks.has(situation.id) && rng.chance(SETTINGS.quirkChance));
    const line = habit ? habit.hooks.get(situation.id) : variant;
    const sample = (choices, chance) => choices?.length && rng.chance(chance) ? rng.pick(choices) : null;
    const saying = !habit && !!variant.say && sheet.sayings.length > 0 && rng.chance(SETTINGS.sayingChance);
    const star = outing?.reason === 'explore' && situation.step === 'eat' ? 'explore'
        : !habit && variant.rare ? 'rare' : null;
    if (habit) state.usedQuirks.add(habit.quirk.id);
    else state.used.add(variantKey(situation, variant));
    state.events.push({
        ...placement({ type: outing ? 'outing' : 'home', start, end, outing, meetId: outing?.meet_id ?? null }),
        sid: situation.id, vid: habit ? null : variant.id, quirk: habit?.quirk.id ?? null,
        icon: line.icon ?? situation.icon, action: line.action,
        sound: saying ? `「${rng.pick(sheet.sayings)}」` : sample(line.sound, SETTINGS.soundChance),
        detail: sample(line.detail, SETTINGS.detailChance), saying, star
    });
}

function addAnchors(state, situations, wake, sleep, nextWake) {
    for (const [anchor, time] of [['wake', wake], ['bedtime', sleep], ['sleep', sleep]]) {
        const situation = situations.find((entry) => entry.anchor === anchor);
        if (!situation || state.events.some(({ sid }) => sid === situation.id)) continue;
        if (anchor === 'wake' && time < state.fromMin) continue;
        if (anchor === 'bedtime') {
            const earliest = Math.max(wake, state.occupiedUntil, ...state.events.map(({ end_min }) => end_min));
            const options = availableVariants(state, situation).flatMap((variant) => {
                const lengths = sequence(...(variant.minutes || situation.minutes)).filter((length) =>
                    time - length >= earliest
                    && windowEnd(situation.window, time - length) > time - length
                    && windowEnd(variant.window, time - length) > time - length);
                return lengths.length ? [{ variant, lengths }] : [];
            });
            const option = pickVariant(state, situation, options);
            if (option) addEvent(state, situation, option, time - state.rng.pick(option.lengths), time);
        } else {
            let options = timingOptions(state, situation, time, anchor === 'wake' ? sleep : nextWake);
            if (!options.length && anchor === 'sleep') options = timingOptions(state, situation, time, Infinity);
            const option = pickVariant(state, situation, options);
            if (option) addEvent(state, situation, option, time, time + state.rng.int(option.min, option.max));
        }
    }
}

function applies(situation, weekend, outing) {
    return (!situation.days || situation.days === (weekend ? 'weekend' : 'weekday'))
        && (!situation.axes || situation.axes.includes(outing?.place.axis))
        && (!situation.when || (situation.when === 'explore' && outing?.reason === 'explore')
            || (situation.when === 'spicy' && outing?.place.spicy));
}

function outingSteps(state, outing, situations, before, after, weekend) {
    const { start_min: start, end_min: end, place } = outing;
    const table = outing.reason === 'meet';
    const steps = new Map(situations.filter((situation) => situation.scene === 'outing'
        && (situation.step !== 'eat' || (situation.axis ?? null) === (place.axis ?? null))
        && (situation.step !== 'arrive' || outing.reason === 'explore')
        && (situation.step !== 'spicy' || place.spicy)
        && applies(situation, weekend, outing)).map((situation) => [situation.step, situation]));
    const make = (step) => {
        const situation = steps.get(step);
        if (!situation || situation.chance != null && !state.rng.chance(situation.chance)) return null;
        const variants = availableVariants(state, situation, place);
        if (!variants.length) return null;
        const min = Math.min(...variants.map((variant) => (variant.minutes || situation.minutes)[0]));
        return { situation, min, length: state.rng.int(...situation.minutes) };
    };

    const pick = make('pick');
    const leave = make('leave');
    const back = make('back');
    if (!pick || !leave || !back || pick.min + leave.min > start - before || back.min > after - end) return null;
    if (pick.length + leave.length > start - before) {
        pick.length = pick.min;
        leave.length = leave.min;
    }
    back.length = Math.min(back.length, after - end);
    pick.start = start - leave.length - pick.length;
    leave.start = start - leave.length;
    back.start = end;

    const body = table ? [] : BODY_STEPS.map(make).filter(Boolean);
    const eat = body.find(({ situation }) => situation.step === 'eat');
    if (!table && !eat) return null;
    if (eat) {
        const length = () => body.reduce((sum, step) => sum + step.length, 0);
        for (const step of OPTIONAL_DROP_ORDER) {
            if (length() <= end - start) break;
            const index = body.findIndex(({ situation }) => situation.step === step && situation.chance != null);
            if (index >= 0) body.splice(index, 1);
        }
        if (length() > end - start) for (const step of body) step.length = step.min;
        if (length() > end - start) return null;
        eat.length += end - start - length();
        let cursor = start;
        for (const step of body) {
            step.start = cursor;
            cursor += step.length;
        }
    }

    const result = [pick, leave, ...body, back].map(({ situation, start, length }) => ({
        situation, start, end: start + length,
        options: timingOptions(state, situation, start, start + length, {
            place, exact: length, stretch: situation.step === 'eat'
        })
    }));
    return result.every(({ options }) => options.length) ? result : null;
}

function addContinuingOutings(state, situations, continuing) {
    for (const { event, outing } of continuing) {
        const { sid, vid, start_min: start, end_min: end, quirk } = event;
        const situation = situations.find(({ id }) => id === sid);
        const options = situation && outing ? timingOptions(state, situation, start, end, {
            place: outing.place, exact: end - start, stretch: situation.step === 'eat'
        }) : [];
        const option = pickVariant(state, situation, options);
        if (option) {
            addEvent(state, situation, option, start, end, outing);
        } else {
            // Keep the step if its old timing no longer has a matching variant.
            state.events.push({ ...event, actor_name: state.sheet.name });
            if (vid != null) state.used.add(`${sid}:${vid}`);
            if (quirk) state.usedQuirks.add(quirk);
        }
    }
}

function addOutingsAndMeets(state, corpus, outings, meets, wake, sleep, weekend) {
    const { situations } = corpus;
    const tableIds = new Set(outings.filter(({ reason, meet_id }) => reason === 'meet' && meet_id != null).map(({ meet_id }) => meet_id));
    const cores = [
        ...outings.map((outing) => ({ ...outing, outing })),
        ...meets.filter(({ id, kind }) => kind === 'remote' || !tableIds.has(id))
            .map((meet) => ({ ...meet, meet_id: meet.id }))
    ].sort(dayOrder);
    const fixed = [...state.events];
    const open = [];
    for (const core of cores) {
        if (core.start_min >= wake && core.end_min <= sleep && core.end_min > core.start_min
            && !fixed.some((event) => intersects(core, event))
            && (!open.length || core.start_min >= open.at(-1).end_min)) open.push(core);
    }
    for (const [index, core] of open.entries()) {
        const { start_min: start, end_min: end, outing, meet_id: meetId } = core;
        const meet = !outing || outing.reason === 'meet';
        if (outing) {
            const before = state.events.reduce((latest, event) => event.end_min <= start ? Math.max(latest, event.end_min) : latest,
                Math.max(wake, state.fromMin));
            const after = fixed.reduce((earliest, event) => event.start_min >= end ? Math.min(earliest, event.start_min) : earliest,
                open[index + 1]?.start_min ?? sleep);
            const steps = outingSteps(state, outing, situations, before, after, weekend);
            if (!steps && !meet) continue;
            for (const step of steps ?? []) {
                const option = pickVariant(state, step.situation, step.options);
                addEvent(state, step.situation, option, step.start, step.end, outing);
            }
        }
        if (meet) {
            const event = placement({ type: 'meet', start, end, outing, meetId: meetId ?? null });
            // 写着正在吃晚饭的隔空剧情就是这天的晚饭，在家不再另吃一顿
            const meal = !outing && isDinnerMeet(core, corpus);
            state.events.push({ ...event, place_id: event.place_id ?? core.place_id ?? null, ...(meal ? { meal } : {}) });
        }
    }
}

function freeRanges(events, start, end) {
    let cursor = start;
    const gaps = [];
    for (const event of [...events].sort(dayOrder)) {
        if (event.start_min >= end) break;
        if (event.start_min > cursor) gaps.push([cursor, event.start_min]);
        cursor = Math.max(cursor, event.end_min);
    }
    if (cursor < end) gaps.push([cursor, end]);
    return gaps;
}

const gapLength = ([start, end]) => end - start;

function longestIdle(events, wake, sleep) {
    return Math.max(0, ...freeRanges(events, wake, sleep).map(gapLength));
}

function mealPlan(state, ordered, start, end, allowUsed) {
    const memo = ordered.map(() => new Map());
    function optionsFor(index, minute) {
        if (memo[index].has(minute)) return memo[index].get(minute);
        const options = timingOptions(state, ordered[index], minute, end, { wholeWindow: true }).flatMap((option) => {
            if (!allowUsed && state.used.has(variantKey(ordered[index], option.variant))) return [];
            const lengths = sequence(option.min, option.max).filter((length) =>
                index + 1 === ordered.length || optionsFor(index + 1, minute + length).length);
            return lengths.length ? [{ ...option, lengths }] : [];
        });
        memo[index].set(minute, options);
        return options;
    }
    const starts = sequence(start, end - 1).filter((minute) => optionsFor(0, minute).length);
    return starts.length ? { starts, optionsFor } : null;
}

function chooseMealPlan(state, ranges, sequences) {
    for (const allowUsed of [false, true]) {
        for (const ordered of sequences) {
            const plans = ranges.map(([lo, hi]) => mealPlan(state, ordered, lo, hi, allowUsed)).filter(Boolean);
            if (plans.length) return { ordered, plan: state.rng.weighted(plans, ({ starts }) => starts.length) };
        }
    }
    return null;
}

function addHomeMeals(state, home, wake, sleep) {
    const byId = new Map(home.map((situation) => [situation.id, situation]));
    for (const [start, end] of SETTINGS.mealWindows) {
        // 出门吃、拼桌、算作晚饭的隔空剧情占了饭点就不在家吃；别的隔空剧情只占它自己那几分钟
        if (state.events.some((event) => (event.type === 'outing' || event.type === 'meet' && (event.outing || event.meal)
            || MEAL_SITUATIONS.has(event.sid)) && intersects(event, { start_min: start, end_min: end }))) continue;
        const ranges = freeRanges(state.events, Math.max(wake, start, state.fromMin), Math.min(sleep, end));
        const prep = state.rng.shuffle(['home.cook', 'home.delivery']);
        const cleanup = state.rng.shuffle([['home.dishes'], ['home.after-meal']]);
        if (state.rng.chance(SETTINGS.bothAfterMeal)) cleanup.unshift(['home.dishes', 'home.after-meal']);
        const sequences = cleanup.flatMap((afterMeal) => prep.map((prepId) => [prepId, 'home.meal', ...afterMeal].map((id) => byId.get(id))))
            .filter((ordered) => ordered.every(Boolean));
        const choice = chooseMealPlan(state, ranges, sequences);
        if (!choice) continue;
        const { ordered, plan } = choice;
        let minute = state.rng.pick(plan.starts);
        for (const [index, situation] of ordered.entries()) {
            const option = pickVariant(state, situation, plan.optionsFor(index, minute));
            const length = state.rng.pick(option.lengths);
            addEvent(state, situation, option, minute, minute + length);
            minute += length;
        }
    }
}

function fillGap(state, available, [start, end], at) {
    const { rng } = state;
    const tryAt = (minute) => {
        const possible = available.flatMap((situation) => {
            const options = timingOptions(state, situation, minute, end);
            return options.length ? [{ situation, options }] : [];
        });
        const chosen = rng.weighted(possible, ({ situation }) => situation.weight ?? 1);
        if (!chosen) return null;
        const { situation, options } = chosen;
        const option = pickVariant(state, situation, options);
        const next = minute + rng.int(option.min, option.max);
        addEvent(state, situation, option, minute, next);
        available.splice(available.indexOf(situation), 1);
        return [minute, next];
    };
    const step = SETTINGS.fillSearchStep;
    for (let offset = 0; at + offset < end || at - offset >= start; offset += step) {
        const placed = (at + offset < end && tryAt(at + offset))
            || (offset > 0 && at - offset >= start && tryAt(at - offset));
        if (placed) return placed;
    }
    // A narrow window can fall between two search steps.
    for (let minute = start; minute < end; minute += 1) {
        if ((minute - at) % step === 0) continue;
        const placed = tryAt(minute);
        if (placed) return placed;
    }
    return null;
}

function fillHome(state, home, wake, sleep) {
    const { rng, events } = state;
    const { maxIdle, fillExpectedDuration, fillSearchStep } = SETTINGS;
    const target = rng.int(...SETTINGS.eventTarget);
    let count = events.filter(({ type }) => type !== 'meet').length;
    const gaps = freeRanges(events, Math.max(wake, state.fromMin), sleep);
    const alreadyPlaced = new Set(events.map(({ sid }) => sid));
    const available = home.filter(({ id }) => !MEAL_SITUATIONS.has(id) && !alreadyPlaced.has(id));
    while (available.length && gaps.length) {
        gaps.sort((a, b) => gapLength(b) - gapLength(a));
        const [start, end] = gaps.shift();
        const length = end - start;
        // Close long gaps first, then keep filling the longest gap up to the daily target.
        if (length <= maxIdle && count >= target) break;
        const duration = Math.min(fillExpectedDuration, length);
        const slots = Math.max(1, Math.ceil((length - maxIdle) / (maxIdle + duration)));
        const spacing = (length + duration) / (slots + 1);
        const pivot = start + spacing * Math.ceil(slots / 2) - duration;
        const jitter = rng.int(-fillSearchStep, fillSearchStep);
        const at = Math.max(start, Math.min(end - 1, Math.round(pivot) + jitter));
        const placed = fillGap(state, available, [start, end], at);
        if (!placed) continue;
        const [first, last] = placed;
        // Recheck the remaining gaps using the actual position and duration.
        if (first > start) gaps.push([start, first]);
        if (last < end) gaps.push([last, end]);
        count += 1;
    }
}

function simulateDay({ userId, day, sheet, outings = [], meets = [], recent = [], corpus, locked = [], continuing = [], fromMin = 0 }) {
    const window = awakeWindow({ userId, day, sheet });
    const anchor = (name) => {
        const id = corpus.situations.find((situation) => situation.anchor === name)?.id;
        return locked.find(({ sid }) => sid === id);
    };
    const wakeLength = corpus.situations.find(({ anchor }) => anchor === 'wake')?.minutes[1] ?? 0;
    const lastWake = Math.min(...continuing.map(({ event }) => event.start_min)) - wakeLength;
    const wake_min = anchor('wake')?.start_min ?? Math.min(window.wake_min, lastWake);
    const bedtimeMin = corpus.situations.find(({ anchor }) => anchor === 'bedtime')?.minutes[0] ?? 0;
    const occupiedUntil = Math.max(fromMin, ...locked.map(({ end_min }) => end_min), ...continuing.map(({ event }) => event.end_min));
    const sleep_min = anchor('sleep')?.start_min ?? anchor('bedtime')?.end_min
        ?? Math.max(window.sleep_min, occupiedUntil + bedtimeMin);
    const weekday = new Date(day).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const rng = createRng(userId, day, 'room-v1');
    const quirks = sheet.quirks.flatMap((id) => {
        const quirk = corpus.quirks.find((entry) => entry.id === id);
        return quirk ? [{ quirk, hooks: new Map(quirk.hooks.map((hook) => [hook.situation, hook])) }] : [];
    });
    const usedKeys = (events) => events.filter(({ vid }) => vid != null).map(({ sid, vid }) => `${sid}:${vid}`);
    const state = { rng, sheet, fromMin, occupiedUntil, recent: new Set(recent), quirks, events: [...locked],
        used: new Set(usedKeys(locked)), usedQuirks: new Set(locked.map(({ quirk }) => quirk).filter(Boolean)) };
    const nextDay = new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);
    const nextWake = DAY_MINUTES + awakeWindow({ userId, day: nextDay, sheet }).wake_min;
    addAnchors(state, corpus.situations, wake_min, sleep_min, nextWake);
    addContinuingOutings(state, corpus.situations, continuing);
    addOutingsAndMeets(state, corpus, outings, meets, wake_min, sleep_min, weekend);
    const home = corpus.situations.filter((situation) => situation.scene === 'home' && !situation.anchor
        && applies(situation, weekend) && (situation.chance == null || rng.chance(situation.chance)));
    addHomeMeals(state, home, wake_min, sleep_min);
    fillHome(state, home, wake_min, sleep_min);
    const events = state.events.sort(dayOrder);
    const preserved = new Set(locked);
    const newEvents = events.filter((event) => !preserved.has(event));
    const stars = [...newEvents.filter(({ star }) => star === 'explore'), ...newEvents.filter(({ star }) => star === 'rare')];
    const remainingStars = Math.max(0, SETTINGS.starLimit - locked.filter(({ star }) => star).length);
    for (const event of stars.slice(remainingStars)) event.star = null;
    const used = [...new Set(usedKeys(events))];
    return { day, corpus_version: corpus.version, wake_min, sleep_min, events, used };
}

function renderEvent(event, { name, places }) {
    const place = places instanceof Map ? places.get(event.place_id) : places?.[event.place_id];
    const replace = (line) => line?.replace(/\{(a|place)\}/g, (token, key) => (key === 'a' ? name : place) ?? token) ?? null;
    return { action: replace(event.action), sound: replace(event.sound), detail: replace(event.detail) };
}

/**
 * 拼桌里自己点单、吃饭的那段（剧本写的是饭后或最后几口时补在剧本前面）：对面坐着人、饭也还没吃完，
 * 不用写“一个人”或已经吃完的做法；筛完一种都不剩时用全部。
 */
const SHARED_TABLE_SKIP = /一个人|独自|吃完|吃空|吃光|见底|干净|剩下|最后一口|一扫而空/;

function forSharedTable(situation) {
    const variants = situation.variants.filter((variant) => !SHARED_TABLE_SKIP.test(
        [variant.action, ...(variant.sound || []), ...(variant.detail || [])].join(' ')));
    return variants.length ? { ...situation, variants } : situation;
}

function soloMeal({ userId, day, sheet, event, place, corpus, shared = false }) {
    const { start_min: start, end_min: end } = event;
    const state = { rng: createRng(userId, day, start, 'room-table-fallback-v1'), sheet, quirks: [],
        used: new Set(), recent: new Set(), events: [] };
    const adapt = shared ? forSharedTable : (situation) => situation;
    const order = adapt(corpus.situations.find(({ step }) => step === 'order'));
    const eat = adapt(corpus.situations.find(({ step, axis }) => step === 'eat' && (axis ?? null) === place.axis));
    const outing = { id: event.outing?.id ?? event.meet_id, reason: 'solo', place };
    const orderOptions = timingOptions(state, order, start, end - 1, { place });
    const orderChoice = pickVariant(state, order, orderOptions);
    const split = start + (orderChoice ? state.rng.int(orderChoice.min, orderChoice.max) : Math.min(1, end - start));
    for (const [situation, lo, hi] of [[order, start, split], [eat, split, end]]) {
        if (hi <= lo) continue;
        const options = timingOptions(state, situation, lo, hi, { place, exact: hi - lo, stretch: true });
        const option = pickVariant(state, situation, options.length ? options : availableVariants(state, situation, place).map((variant) => ({ variant })));
        if (option) addEvent(state, situation, option, lo, hi, outing);
    }
    return state.events.map((event) => ({ ...event, star: null }));
}

/** 在家吃晚饭的时段：写着正在吃晚饭的隔空剧情排在这里，当天的晚饭就是这段 */
const DINNER_WINDOW = Object.freeze([...SETTINGS.mealWindows[1]]);

module.exports = { awakeWindow, simulateDay, renderEvent, longestIdle, soloMeal, DINNER_WINDOW };
