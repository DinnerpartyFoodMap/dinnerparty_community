// 观察屋的确定性随机、标签推断、默认小习惯和角色卡校验（RM-23）。
// 纯函数：不碰数据库，不用 Math.random / Date.now。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { createRng } = require('../../modules/rooms/services/roomRandom');
const { inferTagsFrom, defaultQuirks, normalizeSheet } = require('../../modules/rooms/services/roomTraits');

const corpus = loadCorpus();
const ALL_TAGS = corpus.tags.groups.flatMap((group) => group.tags);
const SERVICE_DIR = path.join(__dirname, '..', '..', 'modules', 'rooms', 'services');
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

const sequence = (rng, count) => Array.from({ length: count }, () => rng.next());
const fixedTags = ['甜品脑袋', '咖啡茶饮续命', '火锅烧烤党', '面食快餐派', '家常菜', '异国料理', '夜宵党', '选择困难', '先拍照', '眼大肚小'];

// ---------------------------------------------------------------------------
// roomRandom：确定性、边界和分布接口
// ---------------------------------------------------------------------------

test('roomRandom：同参数可复现，不同参数不同', () => {
    const a = createRng('resident-1', '2026-01-05', 'room-wake-v1');
    const b = createRng('resident-1', '2026-01-05', 'room-wake-v1');
    const c = createRng('resident-1', '2026-01-06', 'room-wake-v1');
    assert.deepEqual(sequence(a, 32), sequence(b, 32));
    assert.notDeepEqual(sequence(a, 32), sequence(c, 32));
});

test('roomRandom.next：落在 [0, 1)', () => {
    const rng = createRng('next');
    const values = sequence(rng, 10000);
    assert.ok(values.every((value) => Number.isFinite(value) && value >= 0 && value < 1));
    assert.ok(new Set(values).size > 9000);
});

test('roomRandom.int：包含上下界且只产生整数', () => {
    const rng = createRng('int');
    const values = Array.from({ length: 5000 }, () => rng.int(-3, 5));
    assert.ok(values.every((value) => Number.isInteger(value) && value >= -3 && value <= 5));
    assert.equal(Math.min(...values), -3);
    assert.equal(Math.max(...values), 5);
});

test('roomRandom.chance：0 和 1 是确定的', () => {
    const rng = createRng('chance');
    for (let i = 0; i < 100; i += 1) assert.equal(rng.chance(0), false);
    for (let i = 0; i < 100; i += 1) assert.equal(rng.chance(1), true);
    const values = Array.from({ length: 1000 }, () => rng.chance(0.5));
    assert.ok(values.includes(true));
    assert.ok(values.includes(false));
});

test('roomRandom.pick：空列表返回 undefined', () => {
    const rng = createRng('pick');
    const list = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i += 1) assert.ok(list.includes(rng.pick(list)));
    assert.equal(rng.pick([]), undefined);
});

test('roomRandom.weighted：忽略非正权重，全零返回 null', () => {
    const rng = createRng('weighted');
    const choices = Array.from({ length: 200 }, () => rng.weighted([
        { id: 'zero', weight: 0 },
        { id: 'negative', weight: -2 },
        { id: 'ok', weight: 3 }
    ], (item) => item.weight));
    assert.ok(choices.every((choice) => choice?.id === 'ok'));
    assert.equal(createRng('weighted-empty').weighted([], () => 1), null);
    assert.equal(createRng('weighted-zero').weighted([{ weight: 0 }], (item) => item.weight), null);
});

test('roomRandom.shuffle：不改原数组，元素不变且可复现', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const first = createRng('shuffle').shuffle(input);
    const second = createRng('shuffle').shuffle(input);
    assert.deepEqual(first, second);
    assert.deepEqual([...input].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...first].sort((a, b) => a - b), input);
    assert.notEqual(first, input);
});

test('服务模块源码不含 Math.random / Date.now', () => {
    for (const name of ['roomRandom', 'roomTraits', 'roomScripts', 'roomSimulator', 'roomOutings', 'roomPairing']) {
        const source = fs.readFileSync(path.join(SERVICE_DIR, `${name}.js`), 'utf8');
        assert.doesNotMatch(source, /Math\.random\s*\(/, `${name}.js 不应调用 Math.random`);
        assert.doesNotMatch(source, /Date\.now\s*\(/, `${name}.js 不应调用 Date.now`);
    }
});

test('require 纯函数模块时不打开数据库、不启动计时器', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-purity-'));
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const childCode = `
        const Module = require('node:module');
        const load = Module._load;
        Module._load = function(request) {
            if (request.includes('better-sqlite3') || request.includes('database')) {
                throw new Error('require blocked: ' + request);
            }
            return load.apply(this, arguments);
        };
        for (const key of ['setTimeout', 'setInterval', 'setImmediate']) {
            global[key] = () => { throw new Error('timer blocked: ' + key); };
        }
        Date.now = () => { throw new Error('Date.now blocked'); };
        Math.random = () => { throw new Error('Math.random blocked'); };
        for (const name of ['roomRandom', 'roomTraits', 'roomScripts', 'roomSimulator', 'roomOutings', 'roomPairing']) {
            require('./modules/rooms/services/' + name);
        }
        process.stdout.write('ok');
    `;
    let result;
    try {
        result = spawnSync(process.execPath, ['-e', childCode], {
            cwd: path.join(__dirname, '..', '..'),
            stdio: ['ignore', stdoutFd, stderrFd]
        });
    } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
    }
    const stdout = fs.readFileSync(stdoutPath, 'utf8');
    const stderr = fs.readFileSync(stderrPath, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, stderr || stdout);
    assert.equal(stdout, 'ok');
});

// ---------------------------------------------------------------------------
// inferTagsFrom：口味轴、行为作息阈值和互斥
// ---------------------------------------------------------------------------

const activity = (minutes) => minutes;
const allAt = (minute, count = 20) => Array.from({ length: count }, () => minute);

test('inferTagsFrom：口味轴达到 0.7 且有依据才推断', () => {
    const { tags, basis } = inferTagsFrom({
        axes: [
            { key: 'homestyle', value: 0.7, basis: '三次评价' },
            { key: 'noodles', value: 0.699, basis: '差一点' },
            { key: 'hotpotBbq', value: 0.9, basis: '' },
            { key: 'dessert', value: 1, basis: null },
            { key: 'drinks', value: 0.8, basis: '喜欢' },
            { key: 'foreign', value: 0.7, basis: '异国' },
            { key: 'night', value: 1, basis: '不是口味轴' },
            { key: 'not-an-axis', value: 1, basis: '未知' }
        ],
        activityMinutes: []
    });
    assert.deepEqual(new Set(tags), new Set(['家常菜', '咖啡茶饮续命', '异国料理']));
    assert.deepEqual(basis['家常菜'], { source: 'taste', axis: 'homestyle', value: 0.7 });
    assert.equal(basis['咖啡茶饮续命'].source, 'taste');
    assert.equal(basis['异国料理'].source, 'taste');
    assert.equal(basis['面食快餐派'], undefined);
    assert.equal(basis['火锅烧烤党'], undefined);
    assert.equal(basis['甜品脑袋'], undefined);
});

test('inferTagsFrom：20 条夜间事件且占比 30% 推断夜猫子', () => {
    const { tags, basis } = inferTagsFrom({
        axes: [],
        activityMinutes: [...Array(6).fill(1380), ...Array(14).fill(600)]
    });
    assert.deepEqual(tags, ['夜猫子']);
    assert.equal(basis['夜猫子'].source, 'activity');
    assert.equal(basis['夜猫子'].count, 20);
    assert.ok(Math.abs(basis['夜猫子'].share - 0.3) < 1e-12);
});

test('inferTagsFrom：条数不足 20 不推断作息', () => {
    assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: allAt(1380, 19) }).tags, []);
    assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: [] }).tags, []);
});

test('inferTagsFrom：夜间和清晨都够时只取占比高的', () => {
    const nightFirst = [...Array(8).fill(1380), ...Array(6).fill(330), ...Array(6).fill(600)];
    assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: nightFirst }).tags, ['夜猫子']);
    const morningFirst = [...Array(6).fill(1380), ...Array(8).fill(330), ...Array(6).fill(600)];
    assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: morningFirst }).tags, ['早起']);
    const tie = [...Array(6).fill(1380), ...Array(6).fill(330), ...Array(8).fill(600)];
    assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: tie }).tags, ['夜猫子'], '平手取夜猫子');
});

test('inferTagsFrom：23:00–03:00 与 05:30–08:30 的边界', () => {
    for (const minute of [1380, 1439, 0, 179]) {
        assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: allAt(minute) }).tags, ['夜猫子'], `${minute} 属于夜间`);
    }
    for (const minute of [180, 1379]) {
        assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: allAt(minute) }).tags, [], `${minute} 不属于夜间`);
    }
    for (const minute of [330, 509]) {
        assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: allAt(minute) }).tags, ['早起'], `${minute} 属于清晨`);
    }
    for (const minute of [329, 510]) {
        assert.deepEqual(inferTagsFrom({ axes: [], activityMinutes: allAt(minute) }).tags, [], `${minute} 不属于清晨`);
    }
});

test('inferTagsFrom：口味和作息可以同时推断', () => {
    const result = inferTagsFrom({
        axes: [{ key: 'dessert', value: 0.75, basis: '甜品' }],
        activityMinutes: allAt(1380)
    });
    assert.deepEqual(new Set(result.tags), new Set(['甜品脑袋', '夜猫子']));
    assert.equal(result.basis['甜品脑袋'].source, 'taste');
    assert.equal(result.basis['夜猫子'].source, 'activity');
});

// ---------------------------------------------------------------------------
// defaultQuirks
// ---------------------------------------------------------------------------

test('defaultQuirks：同一住民的 2 个不同小习惯固定', () => {
    const first = defaultQuirks('resident-1', ['爱操心', '迷糊'], corpus);
    const second = defaultQuirks('resident-1', ['爱操心', '迷糊'], corpus);
    const ids = new Set(corpus.quirks.map((quirk) => quirk.id));
    assert.deepEqual(first, second);
    assert.equal(first.length, 2);
    assert.equal(new Set(first).size, 2);
    assert.ok(first.every((id) => ids.has(id)));
});

test('defaultQuirks：不同住民不总是同一组', () => {
    const pairs = new Set(Array.from({ length: 30 }, (_, index) =>
        defaultQuirks(`resident-${index}`, ['爱操心', '迷糊', '宅'], corpus).join('|')));
    assert.ok(pairs.size > 1);
});

// ---------------------------------------------------------------------------
// normalizeSheet
// ---------------------------------------------------------------------------

test('normalizeSheet：空对象得到空角色卡', () => {
    const { sheet, errors } = normalizeSheet({}, corpus);
    assert.deepEqual(errors, []);
    assert.deepEqual(sheet, { name: '', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] });
    assert.deepEqual(Object.keys(sheet).sort(), ['answers', 'name', 'quirks', 'sayings', 'tags', 'untagged']);
});

test('normalizeSheet：合法角色卡原样归一化', () => {
    const { sheet, errors } = normalizeSheet({
        name: '  小火柴人  ',
        tags: ['社恐', '爱看书'],
        untagged: ['话多'],
        answers: { 'outing.order': 'fast', 'home.alarm': 'up' },
        quirks: ['soup-first', 'chopsticks'],
        sayings: [' 好耶 ', '随便']
    }, corpus);
    assert.deepEqual(errors, []);
    assert.equal(sheet.name, '小火柴人');
    assert.deepEqual(sheet.tags, ['社恐', '爱看书']);
    assert.deepEqual(sheet.untagged, ['话多']);
    assert.deepEqual(sheet.answers, { 'outing.order': 'fast', 'home.alarm': 'up' });
    assert.deepEqual(sheet.quirks, ['soup-first', 'chopsticks']);
    assert.deepEqual(sheet.sayings, ['好耶', '随便']);
});

test('normalizeSheet：名字可空，非空 1 到 12 字', () => {
    assert.deepEqual(normalizeSheet({ name: '' }, corpus).errors, []);
    assert.deepEqual(normalizeSheet({ name: null }, corpus).errors, []);
    assert.deepEqual(normalizeSheet({ name: '   ' }, corpus).errors, []);
    assert.deepEqual(normalizeSheet({ name: '一' }, corpus).errors, []);
    assert.deepEqual(normalizeSheet({ name: '一二三四五六七八九十一二' }, corpus).errors, []);
    assert.ok(normalizeSheet({ name: '一二三四五六七八九十一二三' }, corpus).errors.some((error) => error.includes('最多 12 字')));
    assert.ok(normalizeSheet({ name: 123 }, corpus).errors.length > 0);
});

test('normalizeSheet：标签最多 10 个、必须在表里且互斥', () => {
    assert.deepEqual(normalizeSheet({ tags: fixedTags }, corpus).errors, []);
    assert.ok(normalizeSheet({ tags: [...fixedTags, '光盘'] }, corpus).errors.some((error) => error.includes('最多 10')));
    assert.ok(normalizeSheet({ tags: ['不存在的标签'] }, corpus).errors.some((error) => error.includes('没有')));
    const duplicate = normalizeSheet({ tags: ['社恐', '社恐'] }, corpus);
    assert.deepEqual(duplicate.errors, []);
    assert.deepEqual(duplicate.sheet.tags, ['社恐']);
    assert.ok(normalizeSheet({ tags: ['能吃辣', '不吃辣'] }, corpus).errors.some((error) => error.includes('不能同时出现')));
});

test('normalizeSheet：untagged 在表里且不能和 tags 相交', () => {
    assert.deepEqual(normalizeSheet({ tags: ['社恐'], untagged: ['话多'] }, corpus).errors, []);
    assert.ok(normalizeSheet({ untagged: ['不存在'] }, corpus).errors.some((error) => error.includes('没有')));
    assert.ok(normalizeSheet({ tags: ['社恐'], untagged: ['社恐'] }, corpus).errors.some((error) => error.includes('不能同时保留和取消')));
    assert.ok(normalizeSheet({ untagged: '话多' }, corpus).errors.some((error) => error.includes('必须是数组')));
});

test('normalizeSheet：问答必须是已有问答情境和做法', () => {
    const valid = normalizeSheet({ answers: { 'outing.order': 'fast' } }, corpus);
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.sheet.answers, { 'outing.order': 'fast' });
    const badSituation = normalizeSheet({ answers: { 'home.read': 'chapters' } }, corpus);
    assert.ok(badSituation.errors.some((error) => error.includes('不是问答情境')));
    assert.deepEqual(badSituation.sheet.answers, {});
    const badVariant = normalizeSheet({ answers: { 'outing.order': 'not-a-variant' } }, corpus);
    assert.ok(badVariant.errors.some((error) => error.includes('没有做法')));
    assert.ok(normalizeSheet({ answers: [] }, corpus).errors.some((error) => error.includes('必须是对象')));
    const partial = normalizeSheet({ answers: { 'outing.order': 'fast', 'nope': 'x' } }, corpus);
    assert.deepEqual(partial.sheet.answers, { 'outing.order': 'fast' });
    assert.equal(partial.errors.length, 1);
});

test('normalizeSheet：小习惯必须存在且最多 3 个', () => {
    const firstFour = corpus.quirks.slice(0, 4).map((quirk) => quirk.id);
    assert.deepEqual(normalizeSheet({ quirks: firstFour.slice(0, 3) }, corpus).errors, []);
    assert.ok(normalizeSheet({ quirks: firstFour }, corpus).errors.some((error) => error.includes('最多 3 项')));
    assert.ok(normalizeSheet({ quirks: ['not-a-quirk'] }, corpus).errors.some((error) => error.includes('没有')));
    const duplicate = normalizeSheet({ quirks: [firstFour[0], firstFour[0]] }, corpus);
    assert.deepEqual(duplicate.errors, []);
    assert.deepEqual(duplicate.sheet.quirks, [firstFour[0]]);
});

test('normalizeSheet：口头禅最多 3 条、1 到 8 字且不含「」换行', () => {
    const valid = normalizeSheet({ sayings: [' 好耶 ', '随便', '走'] }, corpus);
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.sheet.sayings, ['好耶', '随便', '走']);
    assert.deepEqual(normalizeSheet({ sayings: ['一二三四五六七八'] }, corpus).errors, []);
    assert.ok(normalizeSheet({ sayings: ['一二三四五六七八九'] }, corpus).errors.some((error) => error.includes('1 到 8 字')));
    assert.ok(normalizeSheet({ sayings: ['', '   ', 'a\nb'] }, corpus).errors.length >= 3);
    assert.ok(normalizeSheet({ sayings: ['a「b」'] }, corpus).errors.length > 0);
    assert.ok(normalizeSheet({ sayings: ['a\rb'] }, corpus).errors.length > 0);
    assert.ok(normalizeSheet({ sayings: ['a\u2028b'] }, corpus).errors.length > 0);
    assert.ok(normalizeSheet({ sayings: ['好耶', '随便', '走', '嗨'] }, corpus).errors.some((error) => error.includes('最多 3 项')));
    assert.ok(normalizeSheet({ sayings: '好耶' }, corpus).errors.some((error) => error.includes('必须是数组')));
});

test('normalizeSheet：非对象输入也返回空角色卡和错误', () => {
    const { sheet, errors } = normalizeSheet(null, corpus);
    assert.ok(errors.includes('角色卡必须是对象'));
    assert.deepEqual(sheet, { name: '', tags: [], untagged: [], answers: {}, quirks: [], sayings: [] });
});

if (failures.length) {
    console.error(`\ntest_room_traits: ${failures.length} 个用例失败`);
    process.exitCode = 1;
} else {
    console.log('\ntest_room_traits: all passed');
}
