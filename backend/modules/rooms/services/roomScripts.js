const { createRng } = require('./roomRandom');

const SETTINGS = Object.freeze({ roleTagWeight: 2 });

function pickRoles(scripts, a, b, rng) {
    const score = (fits, tags) => 1 + SETTINGS.roleTagWeight * new Set(fits.filter((tag) => tags.includes(tag))).size;
    const choices = scripts.map((script) => {
        const forward = score(script.x, a) * score(script.y, b);
        const reverse = score(script.x, b) * score(script.y, a);
        const x = forward === reverse ? rng.pick(['a', 'b']) : forward > reverse ? 'a' : 'b';
        return {
            weight: (script.weight ?? 1) * Math.max(forward, reverse),
            result: { script_id: script.id, x, y: x === 'a' ? 'b' : 'a' }
        };
    });
    return rng.weighted(choices, ({ weight }) => weight)?.result ?? null;
}

function pickScript({ kind, bond, a, b, axis, history, rng, corpus, allowRepeat = true, exclude = null }) {
    const matching = corpus.scripts.filter((script) => script.kind === kind
        && script.bond && script.bond[0] <= bond && bond <= script.bond[1]
        && (!script.axis || script.axis === axis) && !exclude?.has(script.id));
    const unused = matching.filter(({ id }) => !history?.pair?.has(id) && !history?.a?.has(id) && !history?.b?.has(id));
    return pickRoles(unused.length || !allowRepeat ? unused : matching, a, b, rng);
}

function pickBondScript({ level, a, b, rng, corpus }) {
    return pickRoles(corpus.scripts.filter((script) => script.kind === 'bond' && script.level === level), a, b, rng);
}

/**
 * 拼桌剧本里“吃饭那一段”：多出来的饭点时间加在这一条上。
 * 语料可写 meal：条目序号、'before'（剧本写的是饭后或最后几口，时间放在剧本前面，前面补自己点单吃饭）
 * 或 false（不拉长）。没写时取可伸缩（时长不是定数）且最长 ≥ 10 分钟的一条，没有就是 'before'。
 */
function mealBeat(script) {
    if (!script || script.kind !== 'table') return null;
    if (script.meal === false) return null;
    if (script.meal === 'before' || Number.isInteger(script.meal)) return script.meal;
    let best = null;
    script.beats.forEach(({ minutes: [min, max] }, index) => {
        if (min !== max && max >= 10 && (best == null || max > script.beats[best].minutes[1])) best = index;
    });
    return best ?? 'before';
}

/**
 * 一段剧情的各条（含升级剧情）。拼桌的 end_min 比剧本本身长时，多出的时间按 mealBeat 加进去，
 * 最后一条正好在 end_min 结束；放在前面时第一条晚于 start_min 开始，前面由读一天时补上自己的点单和吃饭。
 */
function renderMeet({ script_id, seed, start_min, end_min, bond_script_id }, corpus) {
    const rng = createRng(seed, 'room-meet-v1');
    let start = start_min;
    function render(id, type) {
        const script = corpus.scripts.find((entry) => entry.id === id);
        if (!script) return [];
        return script.beats.map((beat, index) => {
            const end = start + rng.int(...beat.minutes);
            const event = {
                type, script_id: id, beat: index, who: beat.who, start_min: start, end_min: end,
                icon: beat.icon, action: beat.action, sound: rng.pick(beat.sound ?? []) ?? null,
                detail: rng.pick(beat.detail ?? []) ?? null, star: !!beat.star
            };
            start = end;
            return event;
        });
    }
    const beats = [...render(script_id, 'meet'), ...render(bond_script_id, 'bond')];
    const extra = Number.isFinite(end_min) && beats.length ? end_min - beats.at(-1).end_min : 0;
    const meal = extra > 0 ? mealBeat(corpus.scripts.find(({ id }) => id === script_id)) : null;
    if (meal == null) return beats;
    const from = meal === 'before' ? 0 : meal;
    return beats.map((beat, index) => {
        if (beat.type !== 'meet' || index > from) return { ...beat, start_min: beat.start_min + extra, end_min: beat.end_min + extra };
        if (index === from) return { ...beat, start_min: beat.start_min + (meal === 'before' ? extra : 0), end_min: beat.end_min + extra };
        return beat;
    });
}

/** 隔空剧情写的是正在吃晚饭、问晚饭吃什么：这段就是两边当天的晚饭 */
function isDinnerMeet({ kind, script_id }, corpus) {
    return kind === 'remote' && corpus.scripts.some(({ id, when }) => id === script_id && when === 'dinner');
}

/** 拼桌一顿饭的时长能不能拉长到和一个人出门吃一样 */
function stretchesMeal(scriptId, corpus) {
    return mealBeat(corpus.scripts.find(({ id }) => id === scriptId)) != null;
}

function duration(input, corpus) {
    return renderMeet({ ...input, start_min: 0, end_min: undefined }, corpus).at(-1)?.end_min ?? 0;
}

function renderMeetText(event, { x, y, place }) {
    const names = { x, y, place };
    const replace = (line) => line?.replace(/\{(x|y|place)\}/g, (token, key) => names[key] ?? token) ?? null;
    return { action: replace(event.action), sound: replace(event.sound), detail: replace(event.detail) };
}

module.exports = { pickScript, pickBondScript, renderMeet, duration, renderMeetText, mealBeat, stretchesMeal, isDinnerMeet };
