// 观察屋单独出门：候选门槛、饭点、间隔、探索资格、近期去重和确定性（RM-22）。
const assert = require('node:assert/strict');
const { planSoloOutings } = require('../../modules/rooms/services/roomOutings');
const { pairRooms } = require('../../modules/rooms/services/roomPairing');
const { createRng } = require('../../modules/rooms/services/roomRandom');

const AXES = ['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign', null];
const SLOT_WINDOWS = {
    breakfast: [420, 570],
    lunch: [690, 810],
    tea: [870, 990],
    dinner: [1050, 1200],
    night: [1290, 1440]
};
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

function candidates(count, overrides = () => ({})) {
    return Array.from({ length: count }, (_, index) => ({
        id: `place-${index}`,
        name: `店${index}`,
        category: '中餐',
        description: '一家普通的店',
        per_person_cost: 50,
        rating_count: 5,
        rating_average: 4,
        rating_negative_count: 0,
        favorite_count: index % 3,
        axis: AXES[index % AXES.length],
        spicy: index % 2 === 0,
        rated: false,
        favorited: false,
        ...overrides(index)
    }));
}

const sheet = (tags = []) => ({ name: '测试', tags, untagged: [], answers: {}, quirks: [], sayings: [] });
const dayAt = (index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);

function plan(overrides = {}) {
    return planSoloOutings({
        userId: 'resident-outing',
        day: '2026-01-05',
        sheet: sheet(),
        wake_min: 480,
        sleep_min: 1440,
        candidates: candidates(12),
        recentPlaceIds: [],
        takenSlots: [],
        personalize: null,
        ...overrides
    });
}

test('planSoloOutings：候选少于 5 家返回空', () => {
    for (let count = 0; count < 5; count += 1) {
        assert.deepEqual(plan({ candidates: candidates(count) }), [], `${count} 家候选不应安排出门`);
    }
    let sawOuting = false;
    for (let index = 0; index < 50; index += 1) {
        const outings = plan({ day: dayAt(index), candidates: candidates(5) });
        assert.ok(Array.isArray(outings));
        sawOuting ||= outings.length > 0;
    }
    assert.ok(sawOuting, '5 家候选应该有机会安排出门');
});

test('planSoloOutings：同样的输入和日期结果相同', () => {
    const input = {
        day: '2026-01-05',
        candidates: candidates(12),
        recentPlaceIds: ['place-0'],
        takenSlots: ['tea']
    };
    assert.deepEqual(plan(input), plan(input));
});

test('planSoloOutings：外出在醒着的边界内，两次之间至少 60 分钟', () => {
    let total = 0;
    for (let index = 0; index < 500; index += 1) {
        const wake = 450 + (index % 51);
        const sleep = 1400 + (index % 41);
        const outings = plan({
            day: dayAt(index),
            wake_min: wake,
            sleep_min: sleep,
            candidates: candidates(12)
        });
        total += outings.length;
        let previous = null;
        for (const outing of outings) {
            if (previous) assert.ok(outing.start_min >= previous.start_min, '应按开始时间排序');
            assert.ok(Number.isInteger(outing.start_min) && Number.isInteger(outing.end_min));
            assert.ok(outing.start_min >= wake + 45, `${outing.start_min} 早于 wake+45`);
            assert.ok(outing.end_min <= sleep - 45, `${outing.end_min} 晚于 sleep-45`);
            assert.ok(outing.end_min > outing.start_min);
            if (previous) assert.ok(outing.start_min >= previous.end_min + 60, '两次外出之间至少 60 分钟');
            previous = outing;
        }
    }
    assert.ok(total > 0);
});

test('planSoloOutings：breakfast 只有「早起」会有', () => {
    let withoutEarly = 0;
    let withEarly = 0;
    for (let index = 0; index < 300; index += 1) {
        const day = dayAt(index);
        for (const outing of plan({ day, sheet: sheet() })) {
            assert.notEqual(outing.slot, 'breakfast', '没有早起标签不应安排早餐');
            withoutEarly += 1;
        }
        for (const outing of plan({ day, sheet: sheet(['早起']) })) {
            if (outing.slot === 'breakfast') withEarly += 1;
        }
    }
    assert.ok(withoutEarly > 0);
    assert.ok(withEarly > 0, '有早起标签时应有机会安排早餐');
});

test('planSoloOutings：探索只去没评过也没收藏过的店', () => {
    const mixed = candidates(12, (index) => ({
        rated: index < 4,
        favorited: index === 5 || index === 10
    }));
    let explores = 0;
    for (let index = 0; index < 500; index += 1) {
        for (const outing of plan({ day: dayAt(index), candidates: mixed })) {
            if (outing.reason !== 'explore') continue;
            explores += 1;
            assert.equal(outing.place.rated, false, '探索不应选评过的店');
            assert.equal(outing.place.favorited, false, '探索不应选收藏过的店');
        }
    }
    assert.ok(explores > 0, '应该有机会产生探索');
    const allVisited = candidates(12, () => ({ rated: true, favorited: true }));
    for (let index = 0; index < 100; index += 1) {
        assert.ok(plan({ day: dayAt(index), candidates: allVisited }).every((outing) => outing.reason !== 'explore'));
    }
});

test('planSoloOutings：不选 recentPlaceIds 里的店（数字和字符串都算）', () => {
    let outings = 0;
    for (let index = 0; index < 200; index += 1) {
        const result = plan({
            day: dayAt(index),
            recentPlaceIds: ['place-0', 'place-1', 2, 3]
        });
        for (const outing of result) {
            outings += 1;
            assert.ok(!['place-0', 'place-1', '2', '3'].includes(String(outing.place.id)), `选了近期去过的 ${outing.place.id}`);
        }
    }
    assert.ok(outings > 0);
    assert.deepEqual(plan({ recentPlaceIds: candidates(12).map((place) => place.id) }), []);
    const numeric = candidates(12).map((place, index) => ({ ...place, id: index }));
    let numericOutings = 0;
    for (let index = 0; index < 100; index += 1) {
        for (const outing of plan({ day: dayAt(index), candidates: numeric, recentPlaceIds: [0, 1] })) {
            numericOutings += 1;
            assert.ok(![0, 1].includes(outing.place.id));
        }
    }
    assert.ok(numericOutings > 0);
});

test('planSoloOutings：宅标签的平均次数更少', () => {
    let normal = 0;
    let homebody = 0;
    for (let index = 0; index < 500; index += 1) {
        const day = dayAt(index);
        normal += plan({ day }).length;
        homebody += plan({ day, sheet: sheet(['宅']) }).length;
    }
    assert.ok(normal > 0);
    assert.ok(homebody < normal, `宅平均 ${homebody / 500} 应少于普通 ${normal / 500}`);
});

test('planSoloOutings：takenSlots 里的饭点不重复安排', () => {
    let outings = 0;
    for (let index = 0; index < 200; index += 1) {
        const result = plan({ day: dayAt(index), takenSlots: ['lunch'] });
        const slots = new Set();
        for (const outing of result) {
            outings += 1;
            assert.notEqual(outing.slot, 'lunch');
            assert.ok(!slots.has(outing.slot), '同一天同一个饭点只安排一次');
            slots.add(outing.slot);
        }
    }
    assert.ok(outings > 0);
    assert.deepEqual(plan({ takenSlots: ['breakfast', 'lunch', 'tea', 'dinner', 'night'] }), []);
});

test('planSoloOutings：饭点、时长和 place 字段都在约定范围', () => {
    const allCandidates = candidates(12);
    let seen = 0;
    for (let index = 0; index < 300; index += 1) {
        const result = plan({ day: dayAt(index), candidates: allCandidates });
        const slots = new Set();
        for (const outing of result) {
            seen += 1;
            assert.ok(Object.hasOwn(SLOT_WINDOWS, outing.slot));
            assert.ok(['solo', 'explore'].includes(outing.reason));
            assert.ok(allCandidates.includes(outing.place));
            assert.ok(!slots.has(outing.slot));
            slots.add(outing.slot);
            const [start, end] = SLOT_WINDOWS[outing.slot];
            assert.ok(outing.start_min >= start && outing.start_min < end, `${outing.slot} 开始时间 ${outing.start_min} 不在 ${start}-${end}`);
            const range = outing.place.axis === 'drinks' || outing.place.axis === 'dessert' ? [30, 60]
                : outing.place.axis === 'hotpotBbq' ? [80, 120]
                    : [40, 80];
            const length = outing.end_min - outing.start_min;
            assert.ok(length >= range[0] && length <= range[1], `${outing.place.axis} 时长 ${length} 不在 ${range.join('-')}`);
        }
    }
    assert.ok(seen > 0);
});

test('pairRooms：一只一天最多一段，重复调用结果相同', () => {
    const rooms = [
        { userId: 'a', city: '广州', vector: [1, 0] },
        { userId: 'b', city: '广州', vector: [0.9, 0.1] },
        { userId: 'c', city: '成都', vector: [0, 1] },
        { userId: 'd', city: '成都', vector: [0.2, 0.8] },
        { userId: 'e', city: '上海', vector: [1, 1] },
        { userId: 'f', city: '上海', vector: [1, 0.5] },
        { userId: 'g', city: '北京', vector: [0.4, 0.6] }
    ];
    const first = pairRooms({ rooms, day: '2026-01-05' });
    const second = pairRooms({ rooms, day: '2026-01-05' });
    assert.deepEqual(first, second);
    const paired = first.flatMap((pair) => [pair.a, pair.b]);
    assert.equal(paired.length, new Set(paired).size, '同一只不应一天配两次');
    assert.ok(first.every((pair) => ['table', 'remote'].includes(pair.kind)));
    assert.ok(paired.every((id) => rooms.some((room) => room.userId === id)));
});

test('pairRooms：同城能配上时拼桌，否则隔空', () => {
    const alwaysWilling = {
        shuffle: (list) => [...list],
        chance: () => true,
        weighted: (list) => list[0]
    };
    const sameCity = pairRooms({
        rooms: [
            { userId: 'a', city: '广州', vector: [1, 0] },
            { userId: 'b', city: '广州', vector: [1, 0] },
            { userId: 'c', city: '成都', vector: [0, 1] },
            { userId: 'd', city: '成都', vector: [0, 1] }
        ],
        day: '2026-01-05',
        rng: alwaysWilling
    });
    assert.deepEqual(sameCity, [
        { a: 'a', b: 'b', kind: 'table' },
        { a: 'c', b: 'd', kind: 'table' }
    ]);
    const remote = pairRooms({
        rooms: [
            { userId: 'a', city: '广州', vector: [1, 0] },
            { userId: 'b', city: '成都', vector: [0, 1] },
            { userId: 'c', city: '上海', vector: [0.5, 0.5] }
        ],
        day: '2026-01-05',
        rng: alwaysWilling
    });
    assert.deepEqual(remote, [{ a: 'a', b: 'b', kind: 'remote' }]);
});

test('pairRooms：同一种子的不同日期可以不同', () => {
    const rooms = Array.from({ length: 8 }, (_, index) => ({
        userId: `resident-${index}`,
        city: index % 2 ? '广州' : `城市-${index}`,
        vector: [index + 1, 1]
    }));
    const weekday = pairRooms({ rooms, day: '2026-01-05', rng: createRng('same-day') });
    const weekend = pairRooms({ rooms, day: '2026-01-10', rng: createRng('same-day') });
    assert.deepEqual(weekday, pairRooms({ rooms, day: '2026-01-05', rng: createRng('same-day') }));
    assert.notDeepEqual(weekday, weekend);
});

if (failures.length) {
    console.error(`\ntest_room_outings: ${failures.length} 个用例失败`);
    process.exitCode = 1;
} else {
    console.log('\ntest_room_outings: all passed');
}
