// 观察屋单日模拟：作息、时间线、出门、在家吃饭、权重、小习惯和星标（RM-03/04/05/20/21）。
const assert = require('node:assert/strict');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { awakeWindow, simulateDay, renderEvent } = require('../../modules/rooms/services/roomSimulator');

const corpus = loadCorpus();
const byId = new Map(corpus.situations.map((situation) => [situation.id, situation]));
const quirksById = new Map(corpus.quirks.map((quirk) => [quirk.id, quirk]));
const MEAL_IDS = new Set(['home.cook', 'home.delivery', 'home.meal', 'home.dishes', 'home.after-meal']);
const OUTING_STEPS = ['arrive', 'order', 'wait', 'serve', 'eat', 'spicy', 'full', 'pay'];
const MEAL_WINDOWS = [[690, 810], [1050, 1200]];
const WAKE_ID = corpus.situations.find((situation) => situation.anchor === 'wake').id;
const BEDTIME_ID = corpus.situations.find((situation) => situation.anchor === 'bedtime').id;
const SLEEP_ID = corpus.situations.find((situation) => situation.anchor === 'sleep').id;
const failures = [];

function test(name, fn) {
    try {
        fn();
        console.log(`ok ${name}`);
    } catch (error) {
        failures.push(name);
        console.error(`not ok ${name}\n${error.stack || error}`);
    }
}

const dayAt = (index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
const isWeekend = (day) => [0, 6].includes(new Date(day).getUTCDay());
const rangesOf = (window) => (window === null || window === undefined ? [] : (Array.isArray(window[0]) ? window : [window]));
const insideAny = (window, minute) => rangesOf(window).some(([start, end]) => minute >= start && minute < end);
const sheet = (overrides = {}) => ({
    name: '测试住民', tags: [], untagged: [], answers: {}, quirks: [], sayings: [],
    ...overrides
});

const sheets = [
    sheet(),
    sheet({
        tags: ['早起', '爱操心', '话多', '夜宵党'],
        answers: { 'outing.order': 'fast' },
        quirks: ['soup-first', 'chopsticks', 'many-alarms'],
        sayings: ['好耶', '随便']
    }),
    sheet({
        tags: ['夜猫子', '宅', '爱看书', '吃得慢'],
        untagged: ['迷糊'],
        answers: { 'home.tidy': 'shelf' },
        quirks: ['napkin-squares', 'phone-stand']
    }),
    sheet({
        tags: ['甜品脑袋', '自来熟', '嘴硬', '爱睡觉'],
        answers: { 'outing.pick': 'straight' },
        quirks: ['snack-drawer', 'water-first'],
        sayings: ['嗯', '走']
    })
];

function outingsFor(index) {
    const outings = [];
    if (index % 3 === 1) {
        outings.push({
            reason: 'solo', start_min: 720, end_min: 780,
            place: { id: `lunch-${index}`, axis: index % 2 ? 'homestyle' : 'drinks', spicy: false }
        });
    }
    if (index % 3 === 2) {
        outings.push({
            reason: 'explore', start_min: 1080, end_min: 1140,
            place: { id: `dinner-${index}`, axis: 'noodles', spicy: false }
        });
    }
    return outings;
}

function simulate(index, overrides = {}) {
    return simulateDay({
        userId: `resident-${index % 7}`,
        day: dayAt(index),
        sheet: sheets[index % 4],
        outings: outingsFor(index),
        meets: [],
        recent: [],
        corpus,
        ...overrides
    });
}

function commonViolations(events) {
    const problems = [];
    for (let index = 1; index < events.length; index += 1) {
        if (events[index - 1].end_min > events[index].start_min) {
            problems.push(`第 ${index - 1} 条和第 ${index} 条重叠（${events[index - 1].end_min} > ${events[index].start_min}）`);
        }
    }
    return problems;
}

function outingViolations(result, outing) {
    const problems = [];
    const events = result.events;
    const group = events.filter((event) => event.outing && String(event.outing.place.id) === String(outing.place.id));
    if (!group.length) return [`${outing.reason} ${outing.place.id} 没有事件`];
    const stepOf = (event) => byId.get(event.sid)?.step;
    const pick = group.find((event) => stepOf(event) === 'pick');
    const leave = group.find((event) => stepOf(event) === 'leave');
    const back = group.find((event) => stepOf(event) === 'back');
    if (!pick || !leave || !back) problems.push(`${outing.place.id} 缺少 pick / leave / back`);
    if (pick && leave && pick.end_min !== leave.start_min) problems.push(`${outing.place.id} pick 和 leave 没有接上`);
    if (leave && leave.end_min !== outing.start_min) problems.push(`${outing.place.id} leave 没有在 start_min 结束`);
    if (back && back.start_min !== outing.end_min) problems.push(`${outing.place.id} back 没有从 end_min 开始`);

    if (outing.reason === 'meet') {
        const meet = group.find((event) => event.type === 'meet');
        if (!meet) problems.push(`${outing.place.id} 缺少 type=meet 占位`);
        else if (meet.start_min !== outing.start_min || meet.end_min !== outing.end_min) problems.push(`${outing.place.id} 的 meet 占位时间不对`);
        const steps = group.filter((event) => event.sid).map(stepOf);
        if (steps.some((step) => !['pick', 'leave', 'back'].includes(step))) problems.push(`${outing.place.id} 的拼桌还排了 ${steps.join(',')}`);
        return problems;
    }

    const body = group.filter((event) => event.sid && OUTING_STEPS.includes(stepOf(event)))
        .sort((a, b) => a.start_min - b.start_min);
    if (!body.length) return [...problems, `${outing.place.id} 没有店内步骤`];
    if (body[0].start_min !== outing.start_min) problems.push(`${outing.place.id} 第一步没有从 start_min 开始`);
    if (body.at(-1).end_min !== outing.end_min) problems.push(`${outing.place.id} 最后一步没有在 end_min 结束`);
    for (let index = 1; index < body.length; index += 1) {
        if (body[index - 1].end_min !== body[index].start_min) problems.push(`${outing.place.id} 店内步骤之间有缝`);
    }
    const steps = body.map(stepOf);
    let last = -1;
    for (const step of steps) {
        const order = OUTING_STEPS.indexOf(step);
        if (order < last) problems.push(`${outing.place.id} 步骤顺序不对：${steps.join(',')}`);
        last = Math.max(last, order);
    }
    for (const event of body) {
        const situation = byId.get(event.sid);
        if (situation?.axes && !situation.axes.includes(outing.place.axis)) {
            problems.push(`${event.sid} 出现在不适用的店 ${outing.place.axis}`);
        }
    }
    if (outing.reason === 'explore' && !steps.includes('arrive')) problems.push(`${outing.place.id} 探索没有 arrive`);
    if (outing.reason !== 'explore' && steps.includes('arrive')) problems.push(`${outing.place.id} 非探索出现了 arrive`);
    if (!outing.place.spicy && steps.includes('spicy')) problems.push(`${outing.place.id} 不辣的店出现了 spicy`);
    const eat = body.find((event) => stepOf(event) === 'eat');
    if (!eat) problems.push(`${outing.place.id} 没有 eat`);
    else {
        const eatSituation = byId.get(eat.sid);
        if (outing.place.axis === null) {
            if (eat.sid !== 'outing.eat') problems.push(`${outing.place.id} 未分类店用了 ${eat.sid}`);
        } else if (eatSituation?.axis !== outing.place.axis) {
            problems.push(`${outing.place.id} 的 eat 轴 ${eatSituation?.axis} 不是 ${outing.place.axis}`);
        }
        if (outing.reason === 'explore' && eat.star !== 'explore') problems.push(`${outing.place.id} 探索的 eat 没有 star=explore`);
    }
    return problems;
}

function mealViolations(events) {
    const problems = [];
    const meals = events.filter((event) => event.sid === 'home.meal');
    for (const meal of meals) {
        const index = events.indexOf(meal);
        const prep = events[index - 1];
        if (!prep || !['home.cook', 'home.delivery'].includes(prep.sid)) problems.push(`${meal.start_min} 的饭前不是做饭或外卖`);
        const window = MEAL_WINDOWS.find(([start, end]) => meal.start_min >= start && meal.end_min <= end);
        if (!window) problems.push(`${meal.start_min}-${meal.end_min} 的饭不在午饭或晚饭窗口`);
        let cursor = meal.end_min;
        const cleanup = [];
        for (const event of events.slice(index + 1)) {
            if (event.start_min !== cursor || !['home.dishes', 'home.after-meal'].includes(event.sid)) break;
            cleanup.push(event.sid);
            cursor = event.end_min;
        }
        if (!cleanup.length) problems.push(`${meal.start_min} 的饭后没有洗碗或饭后活动`);
        if (cleanup.includes('home.dishes') && cleanup.includes('home.after-meal') && cleanup.indexOf('home.dishes') > cleanup.indexOf('home.after-meal')) {
            problems.push(`${meal.start_min} 的洗碗排在饭后活动后面`);
        }
        if (window) {
            for (const event of events.slice(index - 1, index + 1 + cleanup.length)) {
                if (event.start_min < window[0] || event.end_min > window[1]) problems.push(`${event.sid} 超出饭点窗口`);
            }
        }
    }
    for (const event of events.filter((entry) => ['home.cook', 'home.delivery'].includes(entry.sid))) {
        const index = events.indexOf(event);
        if (events[index + 1]?.sid !== 'home.meal') problems.push(`${event.start_min} 的做饭 / 外卖没有接上吃饭`);
    }
    for (const event of events.filter((entry) => ['home.dishes', 'home.after-meal'].includes(entry.sid))) {
        let index = events.indexOf(event) - 1;
        while (index >= 0 && ['home.dishes', 'home.after-meal'].includes(events[index].sid)) index -= 1;
        if (events[index]?.sid !== 'home.meal') problems.push(`${event.start_min} 的洗碗 / 饭后活动没有跟在吃饭后面`);
    }
    return problems;
}

// ---------------------------------------------------------------------------
// 作息
// ---------------------------------------------------------------------------

test('awakeWindow：三套作息都在基准前后 20 分钟内且可复现', () => {
    const cases = [
        { tags: [], base: [480, 1440] },
        { tags: ['早起'], base: [390, 1350] },
        { tags: ['夜猫子'], base: [630, 1590] }
    ];
    for (const { tags, base } of cases) {
        let jittered = false;
        for (let index = 0; index < 80; index += 1) {
            const input = { userId: 'awake-user', day: dayAt(index), sheet: sheet({ tags }) };
            const window = awakeWindow(input);
            assert.deepEqual(window, awakeWindow(input));
            assert.ok(window.wake_min >= base[0] - 20 && window.wake_min <= base[0] + 20, `${tags.join()} 起床 ${window.wake_min}`);
            assert.ok(window.sleep_min >= base[1] - 20 && window.sleep_min <= base[1] + 20, `${tags.join()} 睡觉 ${window.sleep_min}`);
            assert.ok(window.wake_min < window.sleep_min);
            jittered ||= window.wake_min !== base[0] || window.sleep_min !== base[1];
        }
        assert.ok(jittered, `${tags.join() || '默认'} 从来没有浮动`);
    }
});

// ---------------------------------------------------------------------------
// 时间线结构
// ---------------------------------------------------------------------------

test('simulateDay：第一条起床、睡前结束在 sleep_min、睡着后没有事件', () => {
    const result = simulate(0, { outings: [], meets: [] });
    const awake = awakeWindow({ userId: 'resident-0', day: dayAt(0), sheet: sheets[0] });
    assert.equal(result.day, dayAt(0));
    assert.equal(result.corpus_version, corpus.version);
    assert.equal(result.wake_min, awake.wake_min);
    assert.equal(result.sleep_min, awake.sleep_min);
    assert.deepEqual(commonViolations(result.events), []);
    const first = result.events[0];
    assert.equal(first.sid, WAKE_ID);
    assert.equal(first.start_min, result.wake_min);
    const bedtime = result.events.find((event) => event.sid === BEDTIME_ID);
    assert.ok(bedtime, '缺少睡前事件');
    assert.equal(bedtime.end_min, result.sleep_min);
    const sleep = result.events.find((event) => event.sid === SLEEP_ID);
    assert.ok(sleep, '缺少睡着事件');
    assert.equal(sleep.start_min, result.sleep_min);
    assert.equal(result.events.at(-1).sid, SLEEP_ID);
    assert.ok(result.events.every((event) => event.start_min <= result.sleep_min));
    assert.ok(result.events.every((event) => event.start_min < event.end_min));
});

test('simulateDay：同样的输入可复现，换日期会变化', () => {
    const first = simulate(3);
    const again = simulate(3);
    assert.deepEqual(first, again);
    let changed = false;
    for (let index = 1; index <= 5; index += 1) {
        changed ||= JSON.stringify(simulate(3, { day: dayAt(index) })) !== JSON.stringify(simulate(3, { day: dayAt(index + 1) }));
    }
    assert.ok(changed, '不同日期应该改变日程');
});

test('simulateDay：星标每天最多 2 条，used 记录当天的情境:做法', () => {
    for (let index = 0; index < 200; index += 1) {
        const result = simulate(index);
        assert.ok(result.events.filter((event) => event.star).length <= 2, `${result.day} 星标超过 2 条`);
        const keys = result.events.filter((event) => event.vid !== null).map((event) => `${event.sid}:${event.vid}`);
        assert.deepEqual(new Set(result.used), new Set(keys));
        assert.equal(result.used.length, new Set(result.used).size);
    }
});

// ---------------------------------------------------------------------------
// 出门和剧情占位
// ---------------------------------------------------------------------------

test('simulateDay：普通、探索、拼桌和隔空的外出结构', () => {
    const day = '2026-01-05';
    const outings = [
        { reason: 'solo', start_min: 720, end_min: 780, place: { id: 'solo-place', axis: 'homestyle', spicy: false } },
        { reason: 'meet', start_min: 900, end_min: 930, meet_id: 'table-1', place: { id: 'table-place', axis: 'homestyle', spicy: false } },
        { reason: 'explore', start_min: 1080, end_min: 1140, place: { id: 'explore-place', axis: 'noodles', spicy: false } }
    ];
    const result = simulateDay({
        userId: 'structure-user', day, sheet: sheet(), outings,
        meets: [{ id: 'remote-1', kind: 'remote', start_min: 1230, end_min: 1260 }],
        recent: [], corpus
    });
    assert.deepEqual(commonViolations(result.events), []);
    for (const outing of outings) assert.deepEqual(outingViolations(result, outing), []);

    const soloSteps = result.events.filter((event) => event.outing?.place.id === 'solo-place' && event.sid).map((event) => byId.get(event.sid).step);
    assert.ok(!soloSteps.includes('arrive'));
    assert.ok(!soloSteps.includes('spicy'));
    const exploreSteps = result.events
        .filter((event) => event.outing?.place.id === 'explore-place' && event.sid && event.start_min >= 1080)
        .map((event) => byId.get(event.sid).step);
    assert.equal(exploreSteps[0], 'arrive');

    const tableEvents = result.events.filter((event) => event.outing?.place.id === 'table-place');
    assert.equal(tableEvents.filter((event) => event.type === 'meet').length, 1);
    assert.deepEqual(
        tableEvents.filter((event) => event.sid).map((event) => byId.get(event.sid).step).sort(),
        ['back', 'leave', 'pick']
    );
    const remote = result.events.filter((event) => event.meet_id === 'remote-1');
    assert.equal(remote.length, 1);
    assert.equal(remote[0].type, 'meet');
    assert.equal(remote[0].outing, null);
    assert.equal(remote[0].start_min, 1230);
    assert.equal(remote[0].end_min, 1260);
    assert.ok(result.events.every((event) => event.sid !== 'home.meal'), '午饭和晚饭都被出门占用时不应在家吃饭');
});

test('simulateDay：出门的条件、类别和步骤顺序（多种店类别）', () => {
    const axes = ['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign', null];
    for (let index = 0; index < 121; index += 1) {
        const axis = axes[index % axes.length];
        const outing = {
            reason: index % 2 ? 'explore' : 'solo',
            start_min: 690, end_min: 810,
            place: { id: `condition-${index}`, axis, spicy: index % 4 === 0 }
        };
        const result = simulate(index, { outings: [outing] });
        assert.deepEqual(outingViolations(result, outing), [], `${result.day} ${axis}`);
        const group = result.events.filter((event) => event.outing?.place.id === outing.place.id);
        for (const event of group) {
            const situation = byId.get(event.sid);
            if (situation?.axes) assert.ok(situation.axes.includes(axis), `${situation.id} 不能出现在 ${axis}`);
        }
    }
});

test('simulateDay：拼桌和隔空占位不写入步骤；隔空只有一条', () => {
    const table = { reason: 'meet', start_min: 720, end_min: 750, meet_id: 'table-2', place: { id: 'table-2-place', axis: 'noodles', spicy: false } };
    const tableResult = simulate(0, { outings: [table] });
    assert.deepEqual(outingViolations(tableResult, table), []);
    assert.equal(tableResult.events.filter((event) => event.meet_id === 'table-2' && event.type === 'meet').length, 1);
    assert.equal(tableResult.events.filter((event) => event.meet_id === 'table-2' && event.sid).length, 3);

    const remote = { id: 'remote-2', kind: 'remote', start_min: 1260, end_min: 1290 };
    const remoteResult = simulate(0, { meets: [remote] });
    const remoteEvents = remoteResult.events.filter((event) => event.meet_id === 'remote-2');
    assert.equal(remoteEvents.length, 1);
    assert.equal(remoteEvents[0].type, 'meet');
    assert.equal(remoteEvents[0].sid, null);
    assert.equal(remoteEvents[0].start_min, 1260);
    assert.equal(remoteEvents[0].end_min, 1290);
});

// ---------------------------------------------------------------------------
// 在家吃饭
// ---------------------------------------------------------------------------

test('simulateDay：午饭和晚饭整套在家吃，洗碗 / 饭后只跟在吃饭后面', () => {
    const result = simulate(0, { outings: [], meets: [] });
    const meals = result.events.filter((event) => event.sid === 'home.meal');
    assert.ok(meals.some((event) => event.start_min >= 690 && event.end_min <= 810), '缺少午饭');
    assert.ok(meals.some((event) => event.start_min >= 1050 && event.end_min <= 1200), '缺少晚饭');
    assert.deepEqual(mealViolations(result.events), []);
});

test('simulateDay：外出或整段剧情占满饭点时不在家吃饭', () => {
    const solo = simulate(0, {
        outings: [{ reason: 'solo', start_min: 690, end_min: 810, place: { id: 'lunch-block', axis: 'homestyle', spicy: false } }]
    });
    assert.ok(!solo.events.some((event) => event.sid === 'home.meal' && event.start_min < 810 && event.end_min > 690), '外出占满午饭时仍在家吃饭');

    const table = simulate(0, {
        outings: [{ reason: 'meet', start_min: 720, end_min: 750, meet_id: 'table-lunch', place: { id: 'table-lunch-place', axis: 'homestyle', spicy: false } }]
    });
    assert.ok(!table.events.some((event) => event.sid === 'home.meal' && event.start_min < 810 && event.end_min > 690), '拼桌占满午饭时仍在家吃饭');

    const remoteFull = simulate(0, {
        meets: [{ id: 'remote-full', kind: 'remote', start_min: 690, end_min: 810 }]
    });
    assert.ok(!remoteFull.events.some((event) => event.sid === 'home.meal' && event.start_min < 810 && event.end_min > 690), '整段剧情占满午饭时仍在家吃饭');

    const remoteGap = simulate(0, {
        meets: [{ id: 'remote-gap', kind: 'remote', start_min: 690, end_min: 800 }]
    });
    assert.ok(!remoteGap.events.some((event) => event.sid === 'home.meal' && event.start_min < 810 && event.end_min > 690), '空档不足时仍在家吃饭');
});

// 2026-11-26 起只有写着正在吃晚饭的隔空剧情（when: dinner）算一顿饭；别的隔空剧情只占它自己那几分钟
test('simulateDay：一般的隔空剧情不顶掉在家吃饭，饭也不和剧情重叠', () => {
    const meet = { id: 'remote-partial', kind: 'remote', script_id: 'remote.wrong-window', start_min: 705, end_min: 720 };
    for (let index = 0; index < 20; index += 1) {
        const result = simulate(index, { meets: [meet] });
        const overlapping = result.events.filter((event) => MEAL_IDS.has(event.sid)
            && event.start_min < meet.end_min && event.end_min > meet.start_min);
        assert.deepEqual(overlapping, [], `饭和隔空剧情重叠：${overlapping.map((event) => `${event.sid} ${event.start_min}-${event.end_min}`).join(', ')}`);
    }
});

test('simulateDay：写着正在吃晚饭的隔空剧情就是这天的晚饭，在家不再另吃', () => {
    const script = corpus.scripts.find(({ when }) => when === 'dinner');
    assert.ok(script, '语料里要有 when: dinner 的隔空剧情');
    const meet = { id: 'remote-dinner', kind: 'remote', script_id: script.id, start_min: 1095, end_min: 1105 };
    for (let index = 0; index < 20; index += 1) {
        // 排程时这天不再安排出门吃晚饭（roomDay 把 dinner 饭点记为已占）
        const result = simulate(index, { meets: [meet], outings: outingsFor(index).filter(({ start_min }) => start_min < 1050) });
        const dinners = result.events.filter((event) => MEAL_IDS.has(event.sid) && event.start_min < 1200 && event.end_min > 1050);
        assert.deepEqual(dinners, [], `晚饭时段有隔空晚饭，却仍然安排了 ${dinners.map((event) => `${event.sid} ${event.start_min}-${event.end_min}`).join(', ')}`);
        assert.ok(result.events.some((event) => event.type === 'meet' && event.meal === true), '隔空晚饭的占位要标 meal');
    }
});

// ---------------------------------------------------------------------------
// 统计：每天条数中位数
// ---------------------------------------------------------------------------

// 2026-11-25 规则改为“醒着时空闲不超过 120 分钟，再补到目标条数”，中位数上限放到 22（RM-21）
test('simulateDay：200 个住民日（不含剧情）每天条数中位数在 15 到 22 之间，九成的天不超过 26 条', () => {
    const counts = [];
    for (let index = 0; index < 200; index += 1) {
        const result = simulate(index, { meets: [] });
        counts.push(result.events.filter((event) => event.type !== 'meet').length);
    }
    counts.sort((a, b) => a - b);
    const median = (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
    console.log(`  住民日条数中位数 ${median}（最小 ${counts[0]}，最大 ${counts.at(-1)}）`);
    assert.ok(median >= 15 && median <= 22, `中位数 ${median} 不在 15 到 22 之间`);
    assert.ok(counts.filter((count) => count <= 26).length >= 180, '超过一成的天多于 26 条');
});

test('simulateDay：醒着时相邻两条之间的空闲，95% 以上不超过 120 分钟', () => {
    let gaps = 0;
    let long = 0;
    for (let index = 0; index < 200; index += 1) {
        const result = simulate(index, { meets: [] });
        const awake = result.events.filter((event) => event.start_min < result.sleep_min).sort((a, b) => a.start_min - b.start_min);
        for (let i = 1; i < awake.length; i += 1) {
            gaps += 1;
            if (awake[i].start_min - awake[i - 1].end_min > 120) long += 1;
        }
    }
    console.log(`  空闲超过 120 分钟 ${long} / ${gaps}`);
    assert.ok(long <= gaps * 0.05, `空闲超过 120 分钟的有 ${long} / ${gaps}`);
});

// ---------------------------------------------------------------------------
// 做法权重
// ---------------------------------------------------------------------------

function tinyCorpus(variants) {
    return {
        ...corpus,
        situations: [
            ...corpus.situations.filter((situation) => situation.anchor),
            { id: 'home.test', scene: 'home', icon: 'book', minutes: [5, 10], window: [400, 1500], variants }
        ],
        scripts: [],
        version: 'test-weights'
    };
}

const plain = { id: 'plain', fits: [], action: '{a}发呆', sound: [], detail: [] };
const answer = { id: 'answer', fits: [], action: '{a}读书', sound: [], detail: [] };
const tagged = { id: 'tagged', fits: ['社恐'], action: '{a}缩着', sound: [], detail: [] };
const rare = { id: 'rare', fits: ['爱睡觉'], rare: true, action: '{a}打盹', sound: [], detail: [] };

function drawCounts(variants, sheetValue, days = 2000) {
    const testCorpus = tinyCorpus(variants);
    const counts = {};
    for (let index = 0; index < days; index += 1) {
        const result = simulateDay({
            userId: 'weight-user', day: dayAt(index), sheet: sheet(sheetValue),
            outings: [], meets: [], recent: [], corpus: testCorpus
        });
        const event = result.events.find((entry) => entry.sid === 'home.test');
        assert.ok(event, `${result.day} 没有抽到 home.test`);
        const key = event.vid ?? `quirk:${event.quirk}`;
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

test('做法权重：答过的做法在 2000 次抽取里占 65% 到 75%', () => {
    const counts = drawCounts([answer, plain], { answers: { 'home.test': 'answer' } });
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const share = (counts.answer || 0) / total;
    console.log(`  答过做法占比 ${(share * 100).toFixed(1)}%`);
    assert.ok(share >= 0.65 && share <= 0.75, `答过做法占比 ${share}`);
});

test('做法权重：fits 全被取消的做法抽不到，其余都抽得到', () => {
    const excluded = drawCounts([tagged, plain], { untagged: ['社恐'] });
    assert.equal(excluded.tagged, undefined);
    assert.ok(excluded.plain > 0);
    const all = drawCounts([answer, plain, tagged], {});
    assert.ok(all.answer > 0 && all.plain > 0 && all.tagged > 0, JSON.stringify(all));
});

test('做法权重：rare 比同情境的普通做法少见', () => {
    const counts = drawCounts([rare, plain], { tags: ['爱睡觉'] });
    assert.ok(counts.rare > 0 && counts.plain > 0);
    assert.ok(counts.rare < counts.plain, `rare ${counts.rare} 不应多于 plain ${counts.plain}`);
});

// ---------------------------------------------------------------------------
// 小习惯、口头禅和星标
// ---------------------------------------------------------------------------

function quirkCorpus() {
    const targets = ['home.t1', 'home.t2', 'home.t3', 'home.t4'].map((id) => ({
        id, scene: 'home', icon: 'book', minutes: [5, 10], window: [400, 1500],
        variants: [{ id: 'plain', fits: [], action: '{a}做自己的事', sound: [], detail: [] }]
    }));
    const quirk = {
        id: 'test-quirk', name: '测试习惯', fits: [],
        hooks: targets.slice(0, 3).map(({ id }) => ({ situation: id, action: '{a}做了测试动作', sound: [], detail: [] }))
    };
    return { ...corpus, situations: [...corpus.situations.filter((situation) => situation.anchor), ...targets], scripts: [], quirks: [quirk], version: 'test-quirks' };
}

test('小习惯：每天最多一次，只出现在 hooks 的情境里，剧情里没有', () => {
    const testCorpus = quirkCorpus();
    let seen = 0;
    for (let index = 0; index < 500; index += 1) {
        const result = simulateDay({
            userId: 'quirk-user', day: dayAt(index), sheet: sheet({ quirks: ['test-quirk'] }),
            outings: [], meets: [], recent: [], corpus: testCorpus
        });
        const quirkEvents = result.events.filter((event) => event.quirk);
        assert.ok(quirkEvents.length <= 1, `${result.day} 同一个小习惯出现多次`);
        for (const event of quirkEvents) {
            seen += 1;
            assert.equal(event.quirk, 'test-quirk');
            assert.equal(event.vid, null);
            assert.ok(['home.t1', 'home.t2', 'home.t3'].includes(event.sid), `小习惯出现在未挂钩的 ${event.sid}`);
            assert.equal(event.action, '{a}做了测试动作');
            assert.equal(event.saying, false);
        }
    }
    assert.ok(seen > 0, '500 天里应该出现小习惯');
});

test('口头禅：只出现在 say 做法上，没有口头禅时不出现', () => {
    const testCorpus = tinyCorpus([
        { id: 'say', fits: [], say: true, action: '{a}说了一句', sound: [], detail: [] },
        plain
    ]);
    let seen = 0;
    for (let index = 0; index < 500; index += 1) {
        const result = simulateDay({
            userId: 'saying-user', day: dayAt(index), sheet: sheet({ sayings: ['好耶', '走'] }),
            outings: [], meets: [], recent: [], corpus: testCorpus
        });
        for (const event of result.events.filter((entry) => entry.saying)) {
            seen += 1;
            assert.equal(event.vid, 'say');
            assert.equal(event.quirk, null);
            assert.ok(['「好耶」', '「走」'].includes(event.sound), event.sound);
            assert.equal(event.action, '{a}说了一句');
        }
    }
    assert.ok(seen > 0, '500 天里应该出现口头禅');
    for (let index = 0; index < 200; index += 1) {
        const result = simulateDay({
            userId: 'saying-empty', day: dayAt(index), sheet: sheet({ sayings: [] }),
            outings: [], meets: [], recent: [], corpus: testCorpus
        });
        assert.ok(result.events.every((event) => event.saying === false));
    }
});

test('星标：稀有做法标 rare，探索 eat 标 explore，合计不超过 2 条', () => {
    const rareCorpus = tinyCorpus([rare, plain]);
    for (let index = 0; index < 500; index += 1) {
        const result = simulateDay({
            userId: 'rare-star', day: dayAt(index), sheet: sheet({ tags: ['爱睡觉'] }),
            outings: [], meets: [], recent: [], corpus: rareCorpus
        });
        const event = result.events.find((entry) => entry.sid === 'home.test');
        if (event.vid === 'rare') assert.equal(event.star, 'rare');
        else assert.equal(event.star, null);
    }
    const outings = [
        { reason: 'explore', start_min: 600, end_min: 660, place: { id: 'star-1', axis: 'homestyle', spicy: false } },
        { reason: 'explore', start_min: 780, end_min: 840, place: { id: 'star-2', axis: 'noodles', spicy: false } },
        { reason: 'explore', start_min: 1080, end_min: 1140, place: { id: 'star-3', axis: 'foreign', spicy: false } }
    ];
    const result = simulateDay({
        userId: 'explore-star', day: '2026-01-05', sheet: sheet(), outings, meets: [], recent: [], corpus
    });
    const stars = result.events.filter((event) => event.star);
    assert.equal(stars.length, 2);
    assert.ok(stars.every((event) => event.star === 'explore'));
    assert.equal(result.events.filter((event) => event.sid?.startsWith('outing.eat') && event.outing?.reason === 'explore').length, 3);
});

// ---------------------------------------------------------------------------
// 200 个住民日的规则抽查
// ---------------------------------------------------------------------------

test('200 个住民日：window、minutes、周末、axes、去重、小习惯和星标都不越界', () => {
    const problems = [];
    for (let index = 0; index < 200; index += 1) {
        const result = simulate(index);
        const events = result.events;
        const awake = awakeWindow({ userId: `resident-${index % 7}`, day: dayAt(index), sheet: sheets[index % 4] });
        const weekend = isWeekend(result.day);
        problems.push(...commonViolations(events));
        if (events[0]?.sid !== WAKE_ID || events[0]?.start_min !== awake.wake_min) {
            problems.push(`${result.day} 第一条不是 wake_min 的起床`);
        }
        const sleepEvent = events.find((event) => event.sid === SLEEP_ID);
        if (sleepEvent?.start_min !== awake.sleep_min) problems.push(`${result.day} 睡着没有从 sleep_min 开始`);
        const bedtimeEvent = events.find((event) => event.sid === BEDTIME_ID);
        if (bedtimeEvent?.end_min !== awake.sleep_min) problems.push(`${result.day} 睡前没有结束在 sleep_min`);
        if (events.at(-1)?.sid !== SLEEP_ID) problems.push(`${result.day} 睡着之后还有事件`);

        const seenVariants = new Set();
        const seenHome = new Map();
        const seenQuirks = new Set();
        for (const event of events) {
            const situation = byId.get(event.sid);
            if (situation) {
                if (situation.window && !insideAny(situation.window, event.start_min)) {
                    problems.push(`${result.day} ${event.sid} 的开始 ${event.start_min} 不在 window`);
                }
                if (situation.days && (situation.days === 'weekend') !== weekend) {
                    problems.push(`${result.day} ${event.sid} 的 days=${situation.days}`);
                }
                if (situation.axes && event.outing && !situation.axes.includes(event.outing.place.axis)) {
                    problems.push(`${result.day} ${event.sid} 不适用于 ${event.outing.place.axis}`);
                }
                if (event.vid !== null) {
                    const variant = situation.variants.find((entry) => entry.id === event.vid);
                    if (variant?.window && !insideAny(variant.window, event.start_min)) {
                        problems.push(`${result.day} ${event.sid}:${event.vid} 的开始不在做法 window`);
                    }
                    if (variant?.axes && event.outing && !variant.axes.includes(event.outing.place.axis)) {
                        problems.push(`${result.day} ${event.sid}:${event.vid} 不适用于 ${event.outing.place.axis}`);
                    }
                    if (!(event.type === 'outing' && situation.step === 'eat')) {
                        const [min, max] = variant?.minutes || situation.minutes || [];
                        const length = event.end_min - event.start_min;
                        if (min !== undefined && (length < min || length > max)) {
                            problems.push(`${result.day} ${event.sid}:${event.vid} 时长 ${length} 不在 ${min}-${max}`);
                        }
                    }
                    const key = `${event.sid}:${event.vid}`;
                    if (seenVariants.has(key) && !MEAL_IDS.has(event.sid)) problems.push(`${result.day} 重复出现 ${key}`);
                    seenVariants.add(key);
                }
                if (!MEAL_IDS.has(event.sid)) {
                    seenHome.set(event.sid, (seenHome.get(event.sid) || 0) + 1);
                    if (seenHome.get(event.sid) > 1) problems.push(`${result.day} 屋里情境 ${event.sid} 出现两次`);
                }
            }
            if (event.quirk) {
                const quirk = quirksById.get(event.quirk);
                if (!quirk?.hooks.some((hook) => hook.situation === event.sid)) problems.push(`${result.day} 小习惯 ${event.quirk} 出现在 ${event.sid}`);
                if (seenQuirks.has(event.quirk)) problems.push(`${result.day} 小习惯 ${event.quirk} 出现两次`);
                seenQuirks.add(event.quirk);
                if (event.vid !== null) problems.push(`${result.day} 小习惯事件仍有 vid`);
            }
            if (event.saying) {
                const variant = situation?.variants.find((entry) => entry.id === event.vid);
                if (!variant?.say) problems.push(`${result.day} 口头禅出现在非 say 做法 ${event.sid}:${event.vid}`);
                if (event.quirk) problems.push(`${result.day} 口头禅和小习惯同时出现`);
                const sayings = sheets[index % 4].sayings;
                if (!sayings.some((saying) => event.sound === `「${saying}」`)) problems.push(`${result.day} 口头禅内容不在角色卡里`);
            }
            if (event.star === 'rare' && !situation?.variants.find((entry) => entry.id === event.vid)?.rare) {
                problems.push(`${result.day} 非 rare 做法标了 rare`);
            }
            if (event.star === 'explore' && (event.outing?.reason !== 'explore' || byId.get(event.sid)?.step !== 'eat')) {
                problems.push(`${result.day} 非探索 eat 标了 explore`);
            }
        }
        if (events.filter((event) => event.star).length > 2) problems.push(`${result.day} 星标超过 2 条`);
        for (const outing of outingsFor(index)) problems.push(...outingViolations(result, outing).map((problem) => `${result.day} ${problem}`));
        problems.push(...mealViolations(events).map((problem) => `${result.day} ${problem}`));
    }
    assert.deepEqual(problems.slice(0, 10), [], `${problems.length} 处问题，前几处：\n${problems.slice(0, 10).join('\n')}`);
});

// ---------------------------------------------------------------------------
// 填充文本
// ---------------------------------------------------------------------------

test('renderEvent：替换名字和店名，缺省时保留占位符', () => {
    const event = { action: '{a}去了{place}', sound: '「{a}」', detail: '{place}在门口', place_id: 'p1' };
    assert.deepEqual(
        renderEvent(event, { name: '小A', places: new Map([['p1', '小店']]) }),
        { action: '小A去了小店', sound: '「小A」', detail: '小店在门口' }
    );
    assert.deepEqual(
        renderEvent(event, { name: '小A', places: { p1: '小店' } }),
        { action: '小A去了小店', sound: '「小A」', detail: '小店在门口' }
    );
    assert.deepEqual(
        renderEvent({ action: '{a}去{place}', sound: null, detail: null, place_id: 'unknown' }, { name: '小A', places: new Map() }),
        { action: '小A去{place}', sound: null, detail: null }
    );
});

if (failures.length) {
    console.error(`\ntest_room_simulator: ${failures.length} 个用例失败`);
    process.exitCode = 1;
} else {
    console.log('\ntest_room_simulator: all passed');
}
