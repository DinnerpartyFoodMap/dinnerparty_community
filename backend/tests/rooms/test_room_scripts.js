// 观察屋剧本的筛选、站位、渲染和升级接续（RM-13）。
const assert = require('node:assert/strict');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { createRng } = require('../../modules/rooms/services/roomRandom');
const { pickScript, pickBondScript, renderMeet, duration, renderMeetText } = require('../../modules/rooms/services/roomScripts');

const corpus = loadCorpus();
const byId = new Map(corpus.scripts.map((script) => [script.id, script]));
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

function makeScript(id, kind, overrides = {}) {
    return {
        id,
        kind,
        bond: [0, 3],
        x: [],
        y: [],
        beats: [],
        ...overrides
    };
}

const custom = (scripts) => ({ ...corpus, scripts });
const emptyHistory = () => ({ pair: new Set(), a: new Set(), b: new Set() });

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

test('pickScript：真实语料的 kind / bond / axis 过滤', () => {
    const axes = [null, 'homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign'];
    for (const kind of ['table', 'remote']) {
        for (const bond of [0, 1, 2, 3]) {
            for (const axis of axes) {
                const picked = pickScript({
                    kind, bond, a: [], b: [], axis,
                    history: emptyHistory(),
                    rng: createRng('filter', kind, bond, axis ?? 'null'),
                    corpus
                });
                if (!picked) continue;
                const script = byId.get(picked.script_id);
                assert.ok(script, `${picked.script_id} 不在语料里`);
                assert.equal(script.kind, kind);
                assert.ok(script.bond[0] <= bond && bond <= script.bond[1], `${script.id} 不在熟悉度 ${bond}`);
                assert.ok(!script.axis || script.axis === axis, `${script.id} 的 axis 不符合 ${axis}`);
                assert.ok([picked.x, picked.y].sort().join('') === 'ab');
                assert.notEqual(picked.x, picked.y);
            }
        }
    }
});

test('pickScript：bond 范围、axis 和 kind 都必须匹配', () => {
    const scripts = [
        makeScript('table.homestyle', 'table', { axis: 'homestyle' }),
        makeScript('table.any', 'table'),
        makeScript('table.late', 'table', { bond: [2, 3] }),
        makeScript('remote.any', 'remote'),
        makeScript('bond.one', 'bond', { level: 1, bond: undefined })
    ];
    const corpusWithScripts = custom(scripts);
    const pick = (overrides) => pickScript({
        kind: 'table', bond: 1, a: [], b: [], axis: 'drinks',
        history: emptyHistory(), rng: createRng('pick', JSON.stringify(overrides)), corpus: corpusWithScripts,
        ...overrides
    });
    assert.equal(pick({}).script_id, 'table.any');
    assert.ok(['table.homestyle', 'table.any'].includes(pick({ axis: 'homestyle' }).script_id));
    assert.equal(pick({ bond: 2, axis: null }).script_id, 'table.late');
    assert.equal(pick({ kind: 'remote' }).script_id, 'remote.any');
    assert.equal(pick({ bond: 4 }), null);
    assert.equal(pick({ axis: 'noodles' }).script_id, 'table.any', '没有 axis 的脚本适用于任意店');
    const onlyHomestyle = custom([scripts[0]]);
    assert.equal(pickScript({
        kind: 'table', bond: 1, a: [], b: [], axis: 'homestyle',
        history: emptyHistory(), rng: createRng('axis-hit'), corpus: onlyHomestyle
    }).script_id, 'table.homestyle');
    assert.equal(pickScript({
        kind: 'table', bond: 1, a: [], b: [], axis: 'noodles',
        history: emptyHistory(), rng: createRng('axis-miss'), corpus: onlyHomestyle
    }), null);
});

test('pickScript：history 排除 pair / a / b 已演剧本，全被排除时回退', () => {
    const scripts = [
        makeScript('table.one', 'table'),
        makeScript('table.two', 'table'),
        makeScript('table.three', 'table')
    ];
    const c = custom(scripts);
    const base = { kind: 'table', bond: 1, a: [], b: [], axis: null, rng: createRng('history'), corpus: c };
    assert.equal(pickScript({ ...base, history: { pair: new Set(['table.one', 'table.two']), a: new Set(), b: new Set() } }).script_id, 'table.three');
    assert.equal(pickScript({ ...base, history: { pair: new Set(), a: new Set(['table.one']), b: new Set(['table.two']) } }).script_id, 'table.three');
    const fallback = pickScript({ ...base, history: { pair: new Set(scripts.map((script) => script.id)), a: new Set(), b: new Set() } });
    assert.ok(fallback !== null, '候选全被 history 排除时应忽略 history');
    assert.ok(scripts.some((script) => script.id === fallback.script_id));
    assert.equal(pickScript({ ...base, corpus: custom([]), history: emptyHistory() }), null);
});

test('pickScript：x 列了「自来熟」时由有该标签的一边演 x', () => {
    const c = custom([makeScript('table.friendly', 'table', { x: ['自来熟'], y: [] })]);
    const base = { kind: 'table', bond: 1, axis: null, history: emptyHistory(), corpus: c };
    const first = pickScript({ ...base, a: ['自来熟'], b: [], rng: createRng('role-a') });
    assert.deepEqual({ x: first.x, y: first.y }, { x: 'a', y: 'b' });
    const second = pickScript({ ...base, a: [], b: ['自来熟'], rng: createRng('role-b') });
    assert.deepEqual({ x: second.x, y: second.y }, { x: 'b', y: 'a' });
    const neutral = pickScript({ ...base, a: [], b: [], rng: createRng('role-neutral') });
    assert.ok(['a', 'b'].includes(neutral.x));
    assert.notEqual(neutral.x, neutral.y);
});

test('pickScript：相同输入和种子结果相同', () => {
    const input = {
        kind: 'table', bond: 1, a: ['爱操心'], b: ['迷糊'], axis: 'homestyle',
        history: emptyHistory(), rng: createRng('deterministic'), corpus
    };
    assert.deepEqual(pickScript(input), pickScript({ ...input, rng: createRng('deterministic') }));
});

// ---------------------------------------------------------------------------
// 升级剧情
// ---------------------------------------------------------------------------

test('pickBondScript：只挑目标熟悉度的升级剧情', () => {
    const c = custom([
        makeScript('bond.one', 'bond', { level: 1, bond: undefined }),
        makeScript('bond.two', 'bond', { level: 2, bond: undefined }),
        makeScript('bond.three', 'bond', { level: 3, bond: undefined }),
        makeScript('table.other', 'table')
    ]);
    for (const level of [1, 2, 3]) {
        const picked = pickBondScript({ level, a: [], b: [], rng: createRng('bond', level), corpus: c });
        assert.equal(byId.get(picked.script_id)?.kind ?? c.scripts.find((script) => script.id === picked.script_id).kind, 'bond');
        assert.equal(c.scripts.find((script) => script.id === picked.script_id).level, level);
    }
    assert.equal(pickBondScript({ level: 4, a: [], b: [], rng: createRng('bond', 4), corpus: c }), null);
    assert.deepEqual(
        pickBondScript({ level: 2, a: [], b: [], rng: createRng('bond'), corpus: c }),
        pickBondScript({ level: 2, a: [], b: [], rng: createRng('bond'), corpus: c })
    );
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('renderMeet：真实语料每段可复现、紧挨、正好一条 star、时长等于 duration', () => {
    for (const script of corpus.scripts) {
        const input = { script_id: script.id, seed: `seed-${script.id}`, start_min: 120 };
        const events = renderMeet(input, corpus);
        const again = renderMeet(input, corpus);
        assert.deepEqual(events, again, `${script.id} 两次渲染不同`);
        assert.equal(events.length, script.beats.length, `${script.id} 的 beat 数不同`);
        assert.equal(events[0].start_min, 120);
        for (const [index, event] of events.entries()) {
            assert.equal(event.type, 'meet');
            assert.equal(event.script_id, script.id);
            assert.equal(event.beat, index);
            assert.equal(event.who, script.beats[index].who);
            assert.ok(event.end_min > event.start_min, `${script.id}#${index} 时长不是正数`);
            assert.equal(event.start_min, index === 0 ? 120 : events[index - 1].end_min, `${script.id}#${index} 没有紧挨着`);
            assert.equal(event.icon, script.beats[index].icon);
            if (event.sound !== null) assert.ok((script.beats[index].sound || []).includes(event.sound));
            if (event.detail !== null) assert.ok((script.beats[index].detail || []).includes(event.detail));
        }
        const stars = events.filter((event) => event.star);
        assert.equal(stars.length, 1, `${script.id} 的 star 不是正好一条`);
        assert.equal(stars[0].beat, script.beats.findIndex((beat) => beat.star));
        assert.equal(duration({ ...input, start_min: 0 }, corpus), events.at(-1).end_min - 120);
    }
});

test('renderMeet：bond_script_id 接在最后，两段各自一条 star', () => {
    const base = corpus.scripts.find((script) => script.kind === 'table' && script.bond[0] === 0);
    const bond = corpus.scripts.find((script) => script.kind === 'bond' && script.level === 1);
    assert.ok(base && bond);
    const input = { script_id: base.id, seed: 'bond-seed', start_min: 300, bond_script_id: bond.id };
    const events = renderMeet(input, corpus);
    const meetEvents = events.filter((event) => event.type === 'meet');
    const bondEvents = events.filter((event) => event.type === 'bond');
    assert.equal(meetEvents.length, base.beats.length);
    assert.equal(bondEvents.length, bond.beats.length);
    assert.equal(bondEvents[0].start_min, meetEvents.at(-1).end_min);
    for (const [index, event] of events.entries()) {
        assert.equal(event.start_min, index === 0 ? 300 : events[index - 1].end_min);
        assert.ok(event.end_min > event.start_min);
    }
    assert.equal(meetEvents.filter((event) => event.star).length, 1);
    assert.equal(bondEvents.filter((event) => event.star).length, 1);
    assert.equal(duration({ ...input, start_min: 0 }, corpus), events.at(-1).end_min - 300);
    assert.deepEqual(renderMeet(input, corpus), events);
});

test('renderMeetText：填 x / y / 店名，缺省时保留占位符', () => {
    assert.deepEqual(
        renderMeetText({ action: '{x}给{y}看{place}', sound: '「{x}」', detail: '{y}点头' }, { x: '甲', y: '乙', place: '小店' }),
        { action: '甲给乙看小店', sound: '「甲」', detail: '乙点头' }
    );
    assert.deepEqual(
        renderMeetText({ action: '{x}和{place}', sound: null, detail: null }, { x: '甲' }),
        { action: '甲和{place}', sound: null, detail: null }
    );
    assert.deepEqual(renderMeetText({ action: null, sound: null, detail: null }, { x: '甲', y: '乙' }), { action: null, sound: null, detail: null });
});

if (failures.length) {
    console.error(`\ntest_room_scripts: ${failures.length} 个用例失败`);
    process.exitCode = 1;
} else {
    console.log('\ntest_room_scripts: all passed');
}
