'use strict';

// Independent acceptance tests for the place chain-tag worker.
//
// This file deliberately uses a tiny home-grown runner instead of node:test so it
// stays independent from the implementer's test file. It only uses a temporary
// SQLite database (DB_FILE), never backend/data.sqlite or backend/snapshot.sqlite,
// and every model call is a fake injected through the documented `complete` seam.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-chain-tags-independent-'));
const file = path.join(temp, 'test.sqlite');
const REPORT_PRELOAD = path.join(temp, 'report-fake-model.js');

const envDefaults = {
    DB_FILE: file,
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_MODEL: 'fake-deepseek',
    SILICONFLOW_API_KEY: '',
    AMAP_WEB_SERVICE_KEY: '',
    PLACE_MODERATION_ENABLED: 'false',
    PLACE_CHAIN_TAG_MODE: 'observe',
    PLACE_CHAIN_TAG_MIN_CONFIDENCE: '0.8',
    PLACE_CHAIN_TAG_MODEL: '',
    RATING_ESTIMATE_MODE: 'off',
    RATING_PREDICTION_MODE: 'off',
    RATING_LIST_RANK_MODE: 'off',
    RATING_RANDOM_RANK_MODE: 'off',
    NUMERIC_ALGORITHM_SERVICE_URL: '',
    NUMERIC_ALGORITHM_SERVICE_TOKEN: '',
    LOG_TO_CONSOLE: 'false',
    LOG_TO_FILE: 'false'
};

function resetEnv() {
    for (const [key, value] of Object.entries(envDefaults)) process.env[key] = value;
    delete process.env.PLACE_REGION_WORKER;
}

resetEnv();
// The worker consults Redis only through this module; the chain service itself does
// not need a live Redis instance.
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
init();
sql.prepare("INSERT INTO User(id, username, password, admin_level) VALUES ('owner', 'owner', 'x', NULL)").run();

const chain = require('../../modules/places/services/placeChainTags');
const ai = require('../../infrastructure/aiClients');
const numeric = require('../../infrastructure/numericAlgorithmClient');
const {
    CHAIN_TAG, CHAIN_SYSTEM_PROMPT, chainNameKey, hasChainTag, stripChainTag,
    classifyPlaces, applyPendingTags, runPlaceChainRound, selectPendingPlaces,
    pendingTagCategory, readChainTagConfig
} = chain;

const NOW = Date.now();
const old = new Date(NOW - 31 * 60_000).toISOString();
const chainResult = (id, extra = {}) => ({ id, verdict: 'chain', brand: '示例品牌', scope: 'national', confidence: 0.9, ...extra });
const allChain = async ({ user }) => ({ results: JSON.parse(user).map(({ id }) => chainResult(id)) });
const noModel = async () => { throw new Error('the model must not be called'); };
const clock = (database = sql) => database.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision;
const row = (id) => sql.prepare('SELECT * FROM Place WHERE id=?').get(id);
const check = (id) => sql.prepare('SELECT * FROM PlaceChainCheck WHERE place_id=?').get(id);
const setCategory = (id, category) => sql.prepare('UPDATE Place SET category=? WHERE id=?').run(category, id);
const pickIds = (options = {}) => selectPendingPlaces({ database: sql, now: NOW, ...options }).map(({ id }) => id);

function place(name, {
    category = '面馆', status = 'visible', date = old,
    description = '这里有真材实料的手工面条和每日现熬的浓郁牛肉汤。',
    updatedBy = 'owner', updatedTime = '2026-01-01 00:00:00', hasVector = 1
} = {}) {
    const insert = sql.prepare(`INSERT INTO Place(name, category, description, moderation_status, created_time,
        creator_id, updated_by, updated_time, has_vector, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?, 23.1, 113.2)`);
    return Number(insert.run(name, category, description, status, date, updatedBy, updatedTime, hasVector).lastInsertRowid);
}

function region(id, city = null) {
    sql.prepare('INSERT INTO PlaceRegion(place_id, city, checked_at) VALUES (?, ?, 0)').run(id, city);
}

function round(complete, extra = {}) {
    return runPlaceChainRound({ database: sql, complete, now: NOW, ...extra });
}

function tracker(handler) {
    const calls = [];
    return { calls, complete: async (input) => { calls.push(input); return handler(input); } };
}

function patch(object, key, value) {
    const had = Object.prototype.hasOwnProperty.call(object, key);
    const previous = object[key];
    object[key] = value;
    return () => { if (had) object[key] = previous; else delete object[key]; };
}

let childOutputSeq = 0;
function runChild(args, env, timeout = 20_000) {
    // This sandbox forbids piped child stdio, so capture stdout/stderr through
    // regular temporary files instead. This also works in normal environments.
    const stdoutFile = path.join(temp, `child-${++childOutputSeq}.out`);
    const stderrFile = path.join(temp, `child-${childOutputSeq}.err`);
    const stdoutFd = fs.openSync(stdoutFile, 'w');
    const stderrFd = fs.openSync(stderrFile, 'w');
    let result;
    try {
        result = spawnSync(process.execPath, args, { timeout, env, stdio: ['ignore', stdoutFd, stderrFd] });
    } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
    }
    const stdout = fs.readFileSync(stdoutFile, 'utf8');
    const stderr = fs.readFileSync(stderrFile, 'utf8');
    fs.rmSync(stdoutFile, { force: true });
    fs.rmSync(stderrFile, { force: true });
    return { ...result, stdout, stderr };
}

function childFailure(result) {
    return JSON.stringify({
        status: result.status, signal: result.signal,
        error: result.error && { code: result.error.code, message: result.error.message },
        stdout: result.stdout, stderr: result.stderr
    });
}

function fakeTimers() {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const calls = [];
    global.setTimeout = (fn, delay, ...args) => {
        const timer = { fn: () => fn(...args), delay, args, unref() {} };
        calls.push(timer);
        return timer;
    };
    global.clearTimeout = () => {};
    return {
        calls,
        restore() {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    };
}

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------

const outcomes = [];
async function test(name, fn) {
    resetEnv();
    try {
        sql.exec('DELETE FROM Place');
    } catch (error) {
        outcomes.push({ name, ok: false, error });
        console.error(`FAIL ${name}\n  setup: ${error.stack || error}`);
        return;
    }
    try {
        await fn();
        outcomes.push({ name, ok: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        outcomes.push({ name, ok: false, error });
        console.error(`FAIL ${name}\n  ${(error && error.stack) || error}`);
    }
}

function categoryTags(prefix, count, width) {
    return Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(2, '0')}${'x'.repeat(width - prefix.length - 2)}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
    await test('config defaults, mode normalization, confidence fallback and model override', () => {
        delete process.env.PLACE_CHAIN_TAG_MODE;
        delete process.env.PLACE_CHAIN_TAG_MIN_CONFIDENCE;
        delete process.env.PLACE_CHAIN_TAG_MODEL;
        let config = readChainTagConfig();
        assert.deepEqual(config, { mode: 'observe', minConfidence: 0.8, model: 'fake-deepseek' });

        process.env.PLACE_CHAIN_TAG_MODE = '  APPLY ';
        assert.equal(readChainTagConfig().mode, 'apply');
        process.env.PLACE_CHAIN_TAG_MODE = 'unexpected';
        assert.equal(readChainTagConfig().mode, 'observe');
        process.env.PLACE_CHAIN_TAG_MODE = 'off';
        assert.equal(readChainTagConfig().mode, 'off');

        for (const [value, expected] of [['0', 0], ['0.65', 0.65], ['1', 1], ['', 0.8],
            ['nope', 0.8], ['-0.1', 0.8], ['1.1', 0.8]]) {
            process.env.PLACE_CHAIN_TAG_MIN_CONFIDENCE = value;
            assert.equal(readChainTagConfig().minConfidence, expected, `threshold ${JSON.stringify(value)}`);
        }

        process.env.PLACE_CHAIN_TAG_MODEL = '  custom-model ';
        assert.equal(readChainTagConfig().model, 'custom-model');
        process.env.PLACE_CHAIN_TAG_MODEL = '';
        process.env.DEEPSEEK_MODEL = '';
        assert.equal(readChainTagConfig().model, 'deepseek-flash');
    });

    await test('name keys normalize width/brackets/branch suffixes; tag matching uses exact boundaries', () => {
        for (const [input, expected] of [
            [' ＭＡＮＮＥＲ（北京） (其它)【区】 [a(b)]「店」 ', 'manner'],
            ['麦当劳 人民广场店', '麦当劳'],
            ['麦当劳-人民广场店', '麦当劳'],
            ['麦当劳 — 人民广场店（南门）', '麦当劳'],
            ['麦当劳·人民广场店', '麦当劳'],
            ['Shake Shack 人民广场店', 'shakeshack'],
            ['正宗 兰州拉面', '正宗兰州拉面'],
            ['麦当劳人民广场店', '麦当劳人民广场店'],
            ['咖啡-小馆', '咖啡-小馆']
        ]) assert.equal(chainNameKey(input), expected, input);

        for (const [category, expected] of [
            [null, false], ['面馆,非连锁店,连锁店铺', false], ['主打连锁店面馆', false],
            ['连锁店', true], ['连锁店， 面馆', true], ['面馆,  连锁店 \n', true],
            ['面馆 连锁店 非连锁店', true], ['面馆\u00a0连锁店\u3000小吃', true],
            ['面馆|连锁店|小吃', true], ['连锁店铺，非连锁店', false]
        ]) assert.equal(hasChainTag(category), expected, JSON.stringify(category));

        assert.equal(stripChainTag('连锁店，面馆, 连锁店, Fresh Pasta, 非连锁店'), '面馆, Fresh Pasta, 非连锁店');
        assert.equal(stripChainTag('面馆  连锁店'), '面馆');
        assert.equal(stripChainTag('连锁店'), '');
        assert.equal(stripChainTag('面馆|连锁店|小吃'), '面馆|小吃');
        assert.equal(stripChainTag('非连锁店，连锁店铺'), '非连锁店，连锁店铺');
    });

    await test('SQL triggers suppress tag removal even without a check and clear on manual re-add', () => {
        const boundary = place('边界测试', { category: '非连锁店, 连锁店铺' });
        setCategory(boundary, '其他');
        assert.equal(check(boundary), undefined, '非连锁店 / 连锁店铺 must not count as a tag');

        const removal = place('删标签', { category: '面馆, 连锁店' });
        setCategory(removal, '面馆');
        assert.deepEqual(
            [check(removal).suppressed, check(removal).suppressed_name, check(removal).tag_applied, check(removal).verdict],
            [1, '删标签', 0, null]
        );

        const readd = place('先删再加', { category: '面馆, 连锁店' });
        setCategory(readd, '面馆');
        assert.equal(check(readd).suppressed, 1);
        setCategory(readd, '面馆, 连锁店');
        assert.deepEqual([check(readd).suppressed, check(readd).suppressed_name], [0, null]);

        const noCheck = place('没有记录', { category: '快餐, 连锁店' });
        assert.equal(check(noCheck), undefined);
        setCategory(noCheck, '快餐');
        assert.deepEqual([check(noCheck).suppressed, check(noCheck).suppressed_name], [1, '没有记录']);
        setCategory(noCheck, '快餐, 连锁店');
        assert.equal(check(noCheck).suppressed, 0);
        setCategory(noCheck, '快餐');
        assert.equal(check(noCheck).suppressed, 1);
    });

    await test('pendingTagCategory enforces verdict, threshold, visibility, name and existing tags', () => {
        const base = {
            verdict: 'chain', confidence: 0.8, tag_applied: 0, suppressed: 0,
            moderation_status: 'visible', name: '某店', name_key: '某店', category: '面馆'
        };
        assert.equal(pendingTagCategory({ ...base }, 0.8), '面馆, 连锁店');
        assert.equal(pendingTagCategory({ ...base, category: null }, 0.8), CHAIN_TAG);
        assert.equal(pendingTagCategory({ ...base, category: ' 面馆， 快餐 ' }, 0.8), '面馆, 快餐, 连锁店');
        assert.equal(pendingTagCategory({ ...base, category: '非连锁店' }, 0.8), '非连锁店, 连锁店');
        assert.equal(pendingTagCategory({ ...base, confidence: 0.799 }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, confidence: 0 }, 0), '面馆, 连锁店');
        assert.equal(pendingTagCategory({ ...base, confidence: null }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, verdict: 'independent' }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, tag_applied: 1 }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, suppressed: 1 }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, moderation_status: 'pending' }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, name_key: '旧名' }, 0.8), null);
        assert.equal(pendingTagCategory({ ...base, category: '连锁店, 面馆' }, 0.8), null);
    });

    await test('neverTag rules decide category_name without a model call, including stacked prefixes', async () => {
        const names = ['正宗兰州拉面', '老牌 沙县小吃', '风味重庆小面', '特色黄焖鸡米饭', '正宗 兰州拉面（人民广场店）'];
        const ids = names.map((name) => place(name));
        const model = tracker(noModel);
        const stats = await round(model.complete);
        assert.deepEqual([stats.selected, stats.rule, stats.model, stats.checked], [5, 5, 0, 5]);
        assert.equal(model.calls.length, 0);
        for (const id of ids) {
            const saved = check(id);
            assert.deepEqual([saved.verdict, saved.confidence, saved.source, saved.model, saved.status],
                ['category_name', 1, 'rule', null, 'done']);
        }

        const unknown = place('独立小店');
        const second = tracker(async ({ user }) => ({ results: JSON.parse(user).map(({ id }) => chainResult(id, { verdict: 'independent', brand: '', scope: null })) }));
        const mixed = await round(second.complete);
        assert.deepEqual([mixed.selected, mixed.rule, mixed.model], [1, 0, 1]);
        assert.equal(second.calls.length, 1);
        assert.deepEqual(JSON.parse(second.calls[0].user).map(({ id }) => id), [unknown]);
        assert.equal(check(unknown).verdict, 'independent');
    });

    await test('model input strips the tag, clamps description to 120 chars and carries same-name/city evidence', async () => {
        const one = place('麦当劳（人民广场店）', {
            category: '快餐, 连锁店, 非连锁店',
            description: `**牛肉**\n\n<a href="/a">汉堡</a>\n${'鲜'.repeat(130)}`
        });
        const two = place('麦当劳-渡口店');
        const three = place('麦当劳 人民大道店');
        place('陶陶居');
        const hidden = place('麦当劳·私有店', { status: 'pending' });
        region(one, '上海市');
        region(two, '深圳市');
        region(three, '深圳市');
        region(hidden, '北京市');

        let captured = null;
        const stats = await classifyPlaces([{ id: one }], {
            database: sql, now: NOW,
            complete: async (input) => {
                captured = input;
                return { results: [chainResult(one)] };
            }
        });
        assert.equal(stats.model, 1);
        assert.equal(captured.system, CHAIN_SYSTEM_PROMPT);
        assert.equal(captured.model, 'fake-deepseek');
        assert.equal(captured.temperature, 0);
        assert.ok(captured.maxTokens >= 1500);
        const [input] = JSON.parse(captured.user);
        assert.deepEqual(input, {
            id: one,
            name: '麦当劳（人民广场店）',
            category: '快餐, 非连锁店',
            city: '上海市',
            description: `牛肉 汉堡 ${'鲜'.repeat(114)}`,
            site_same_name: { places: 3, cities: 2 }
        });
        assert.equal(Array.from(input.description).length, 120);
        assert.equal(hasChainTag(input.category), false);
        assert.equal(JSON.parse(captured.user).some(({ id }) => id === hidden), false);
    });

    await test('malformed model rows accept only valid items and retry after 1m, 10m and 1h, then stop', async () => {
        const ids = ['good', 'unknown', 'missing', 'badVerdict', 'badConfidence', 'duplicate', 'missingScope', 'badBrand']
            .map((label) => ({ label, id: place(`样本 ${label}`) }));
        const byLabel = Object.fromEntries(ids.map(({ label, id }) => [label, id]));
        const stats = await round(async () => ({ results: [
            chainResult(byLabel.unknown, { verdict: 'unknown', confidence: 0.4, brand: '忽略', scope: 'regional' }),
            chainResult(999999),
            chainResult(byLabel.badVerdict, { verdict: 'maybe' }),
            chainResult(byLabel.badConfidence, { confidence: 1.1 }),
            chainResult(byLabel.duplicate),
            chainResult(byLabel.duplicate),
            chainResult(byLabel.missingScope, { brand: '某品牌', scope: undefined }),
            { id: byLabel.badBrand, verdict: 'chain', brand: 123, scope: 'national', confidence: 0.9 },
            chainResult(String(byLabel.good))
        ] }));
        assert.deepEqual([stats.requestStatus, stats.chain, stats.unknown, stats.error], ['ok', 1, 1, 6]);
        assert.equal(check(byLabel.good).verdict, 'chain');
        assert.deepEqual([check(byLabel.unknown).verdict, check(byLabel.unknown).brand, check(byLabel.unknown).scope],
            ['unknown', '', null]);

        const failed = ['missing', 'badVerdict', 'badConfidence', 'duplicate', 'missingScope', 'badBrand'].map((label) => byLabel[label]);
        const failureAt = (id, attempt, delay, at) => assert.deepEqual(
            [check(id).status, check(id).attempts, check(id).checked_at, check(id).next_retry_at, check(id).verdict],
            ['error', attempt, at, at + delay, null]
        );
        for (const id of failed) failureAt(id, 1, 60_000, NOW);
        assert.deepEqual(pickIds({ now: NOW + 59_999 }), []);

        const retry = async (at) => round(async () => ({ results: [] }), { now: at });
        await retry(NOW + 60_000);
        for (const id of failed) failureAt(id, 2, 600_000, NOW + 60_000);
        await retry(NOW + 660_000);
        for (const id of failed) failureAt(id, 3, 3_600_000, NOW + 660_000);
        assert.deepEqual(pickIds({ now: NOW + 4_259_999 }), []);
        assert.deepEqual(pickIds({ now: NOW + 4_260_000 }), []);

        sql.prepare('UPDATE PlaceChainCheck SET rule_version=0 WHERE place_id=?').run(byLabel.duplicate);
        sql.prepare('UPDATE Place SET name=? WHERE id=?').run('改名后的样本', byLabel.missing);
        assert.deepEqual(pickIds({ now: NOW + 4_260_000 }), [byLabel.missing, byLabel.duplicate]);
        await round(allChain, { now: NOW + 4_260_000 });
        assert.deepEqual([check(byLabel.duplicate).status, check(byLabel.duplicate).attempts, check(byLabel.duplicate).verdict],
            ['done', 1, 'chain']);
        assert.deepEqual([check(byLabel.missing).status, check(byLabel.missing).attempts, check(byLabel.missing).verdict],
            ['done', 1, 'chain']);
    });

    await test('whole-batch failures leave place state untouched and still save rule decisions', async () => {
        const renamed = place('批次失败旧名');
        await classifyPlaces([{ id: renamed }], { database: sql, complete: allChain, now: NOW });
        sql.prepare('UPDATE Place SET name=? WHERE id=?').run('批次失败新名', renamed);
        const saved = check(renamed);
        const fresh = place('批次失败新地点');
        const rule = place('沙县小吃');
        const before = [renamed, fresh, rule].map(row);
        const revision = clock();

        const thrown = await round(async () => { throw new Error('fixture provider outage'); });
        assert.equal(thrown.requestStatus, 'failed');
        assert.equal(thrown.error, 0);
        assert.deepEqual(check(renamed), saved);
        assert.equal(check(fresh), undefined);
        assert.deepEqual([check(rule).verdict, check(rule).source], ['category_name', 'rule']);
        assert.deepEqual([renamed, fresh, rule].map(row), before);
        assert.equal(clock(), revision);

        const missingResults = await round(async () => ({}), { now: NOW + 1000 });
        assert.equal(missingResults.requestStatus, 'failed');
        assert.equal(missingResults.checked, 0);
        assert.deepEqual(check(renamed), saved);
        assert.equal(check(fresh), undefined);
        assert.deepEqual([fresh, renamed].every((id) => row(id)), true);
        assert.equal(clock(), revision);
    });

    await test('observe writes only checks; apply appends once and preserves place metadata and revision', async () => {
        const normal = place('普通面馆', { category: '面馆' });
        const empty = place('原分类为空', { category: null });
        const threshold = place('刚好到门槛', { category: '小吃' });
        const low = place('低置信度', { category: '烧烤' });
        const manual = place('手工标签', { category: '连锁店, 快餐' });
        const hidden = place('隐藏地点', { status: 'pending' });
        const before = new Map([normal, empty, threshold, low, manual, hidden].map((id) => [id, row(id)]));
        const revision = clock();
        const confidences = new Map([[low, 0.79], [threshold, 0.8]]);
        const observed = await round(async ({ user }) => ({
            results: JSON.parse(user).map(({ id }) => chainResult(id, { confidence: confidences.get(id) ?? 0.9 }))
        }));
        assert.equal(observed.applied, 0);
        assert.equal(observed.selected, 5);
        for (const id of [normal, empty, threshold, low, manual]) assert.deepEqual(row(id), before.get(id));
        assert.equal(check(hidden), undefined);
        assert.equal(clock(), revision);
        assert.deepEqual([normal, empty, threshold, low, manual].map((id) => check(id).status),
            ['done', 'done', 'done', 'done', 'done']);

        const applied = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(applied.applied, 3);
        assert.deepEqual(row(normal), { ...before.get(normal), category: '面馆, 连锁店' });
        assert.deepEqual(row(empty), { ...before.get(empty), category: CHAIN_TAG });
        assert.deepEqual(row(threshold), { ...before.get(threshold), category: '小吃, 连锁店' });
        assert.deepEqual(row(low), before.get(low));
        assert.deepEqual(row(manual), before.get(manual));
        assert.equal(check(normal).tag_applied, 1);
        assert.ok(check(normal).applied_at);
        assert.equal(check(low).tag_applied, 0);
        assert.equal(check(manual).tag_applied, 0);
        assert.equal(clock(), revision + 3);
        const after = [normal, empty, threshold, low, manual].map(row);
        assert.equal(applyPendingTags({ database: sql }), 0);
        assert.deepEqual([normal, empty, threshold, low, manual].map(row), after);
        assert.equal(clock(), revision + 3);
    });

    await test('apply skips a category that would become longer than 240 characters', async () => {
        const base = categoryTags('t', 13, 16);
        const exactCategory = `${base.join(', ')}, z`;
        const overCategory = `${base.join(', ')}, zz`;
        assert.equal(exactCategory.length, 235);
        assert.equal(overCategory.length, 236);
        const exact = place('刚好240', { category: exactCategory });
        const over = place('超过240', { category: overCategory });

        await round(allChain);
        const stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(stats.applied, 1);
        assert.equal(row(exact).category.length, 240);
        assert.equal(row(exact).category.endsWith(`, ${CHAIN_TAG}`), true);
        assert.equal(row(over).category, overCategory);
        assert.equal(check(exact).tag_applied, 1);
        assert.equal(check(over).tag_applied, 0);
    });

    await test('apply skips renamed and hidden places and tags them once they are eligible again', async () => {
        const renamed = place('改名前的店名');
        await classifyPlaces([{ id: renamed }], { database: sql, complete: allChain, now: NOW });
        sql.prepare('UPDATE Place SET name=? WHERE id=?').run('改名后的店名', renamed);
        let stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(stats.applied, 0);
        assert.equal(row(renamed).category, '面馆');
        assert.equal(check(renamed).tag_applied, 0);
        stats = await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
        assert.equal(stats.applied, 1);
        assert.equal(row(renamed).category, '面馆, 连锁店');

        const hidden = place('隐藏但已判断', { status: 'pending' });
        sql.prepare(`INSERT INTO PlaceChainCheck(place_id, name_key, rule_version, verdict, brand, scope, confidence,
            source, model, status, attempts) VALUES (?, ?, 1, 'chain', '品牌', 'national', 0.99, 'model', 'fake', 'done', 1)`)
            .run(hidden, chainNameKey('隐藏但已判断'));
        stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(stats.applied, 0);
        assert.equal(row(hidden).category, '面馆');
        sql.prepare("UPDATE Place SET moderation_status='visible' WHERE id=?").run(hidden);
        stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(stats.applied, 1);
        assert.equal(row(hidden).category, '面馆, 连锁店');
    });

    await test('manual removals are never auto-restored; re-adding or renaming unlocks the place', async () => {
        const id = place('人工先标', { category: '快餐, 连锁店' });
        setCategory(id, '快餐');
        assert.equal(check(id).suppressed, 1);
        let stats = await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
        assert.equal(stats.applied, 0);
        assert.equal(row(id).category, '快餐');
        assert.equal(check(id).suppressed, 1);

        setCategory(id, '快餐, 连锁店');
        assert.equal(check(id).suppressed, 0);
        setCategory(id, '快餐');
        assert.equal(check(id).suppressed, 1);
        assert.equal(applyPendingTags({ database: sql }), 0);
        assert.equal(row(id).category, '快餐');

        sql.prepare('UPDATE Place SET name=? WHERE id=?').run('人工先标改过名', id);
        stats = await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
        assert.equal(stats.applied, 1);
        assert.equal(row(id).category, '快餐, 连锁店');
        assert.deepEqual([check(id).suppressed, check(id).tag_applied], [0, 1]);
    });

    await test('duplicate ids are classified once and concurrent classification refuses to double-write', async () => {
        const id = place('并发地点');
        const deferred = [];
        const complete = ({ user }) => new Promise((resolve) => {
            deferred.push(() => resolve({ results: JSON.parse(user).map(({ id: placeId }) => chainResult(placeId)) }));
        });
        const first = classifyPlaces([{ id }], { database: sql, complete, now: NOW });
        const second = classifyPlaces([{ id }, { id }], { database: sql, complete, now: NOW });
        assert.equal(deferred.length, 2);
        deferred[0]();
        const firstStats = await first;
        deferred[1]();
        const secondStats = await second;
        assert.deepEqual([firstStats.checked, firstStats.stale], [1, 0]);
        assert.deepEqual([secondStats.checked, secondStats.stale], [0, 1]);
        assert.equal(sql.prepare('SELECT count(*) AS n FROM PlaceChainCheck WHERE place_id=?').get(id).n, 1);
        assert.equal(check(id).status, 'done');
    });

    await test('a place renamed or deleted while the model runs is marked stale and re-judged later', async () => {
        const renamed = place('请求期间改名');
        const deleted = place('请求期间删除');
        const normal = place('请求期间正常');
        const stats = await round(async ({ user }) => {
            sql.prepare('UPDATE Place SET name=? WHERE id=?').run('请求期间新名', renamed);
            sql.prepare('DELETE FROM Place WHERE id=?').run(deleted);
            return { results: JSON.parse(user).map(({ id }) => chainResult(id)) };
        });
        assert.deepEqual([stats.checked, stats.stale], [1, 1 + 1]);
        assert.equal(check(renamed), undefined);
        assert.equal(check(deleted), undefined);
        assert.equal(check(normal).verdict, 'chain');
        const second = await round(allChain, { now: NOW + 1000 });
        assert.equal(second.checked, 1);
        assert.equal(check(renamed).status, 'done');
        assert.equal(row(renamed).category, '面馆');
    });

    await test('selectPendingPlaces waits for regions up to 30 minutes or when the region worker is off', () => {
        const recentReady = place('最近有地区', { date: new Date(NOW - 1000).toISOString() });
        const recentWaiting = place('最近无地区', { date: new Date(NOW - 1000).toISOString() });
        const oldWaiting = place('旧地点无地区');
        const justUnder = place('差一秒到30分', { date: new Date(NOW - (30 * 60_000 - 1000)).toISOString() });
        const justOver = place('刚过30分', { date: new Date(NOW - (30 * 60_000 + 1000)).toISOString() });
        const pending = place('审核中', { status: 'pending' });
        const checking = place('检查中', { status: 'checking' });
        const rejected = place('已驳回', { status: 'rejected' });
        region(recentReady, null);

        process.env.AMAP_WEB_SERVICE_KEY = 'fixture-key';
        assert.deepEqual(pickIds(), [recentReady, oldWaiting, justOver]);

        process.env.PLACE_REGION_WORKER = 'false';
        assert.deepEqual(pickIds(), [recentReady, recentWaiting, oldWaiting, justUnder, justOver]);

        delete process.env.PLACE_REGION_WORKER;
        process.env.AMAP_WEB_SERVICE_KEY = '';
        assert.deepEqual(pickIds(), [recentReady, recentWaiting, oldWaiting, justUnder, justOver]);
        assert.equal([pending, checking, rejected].some((id) => pickIds().includes(id)), false);
    });

    await test('selectPendingPlaces skips settled/not-due checks and caps the batch at ten', async () => {
        const ids = Array.from({ length: 12 }, (_, index) => place(`批量样本 ${index}`));
        assert.deepEqual(pickIds(), ids.slice(0, 10));
        assert.deepEqual(pickIds({ limit: 3 }), ids.slice(0, 3));
        assert.deepEqual(pickIds({ limit: 0 }), []);
        assert.deepEqual(pickIds({ limit: -1 }), []);

        await classifyPlaces([{ id: ids[0] }], { database: sql, complete: allChain, now: NOW });
        assert.deepEqual(pickIds(), ids.slice(1, 11));

        sql.prepare(`INSERT INTO PlaceChainCheck(place_id, name_key, rule_version, status, attempts, next_retry_at)
            VALUES (?, ?, 1, 'error', 1, ?)`).run(ids[1], chainNameKey(row(ids[1]).name), NOW + 60_000);
        assert.deepEqual(pickIds(), [ids[2], ids[3], ids[4], ids[5], ids[6], ids[7], ids[8], ids[9], ids[10], ids[11]]);
        assert.deepEqual(pickIds({ now: NOW + 60_000 }), [ids[1], ids[2], ids[3], ids[4], ids[5], ids[6], ids[7], ids[8], ids[9], ids[10]]);

        sql.prepare(`INSERT INTO PlaceChainCheck(place_id, name_key, rule_version, verdict, confidence, status, attempts)
            VALUES (?, ?, 1, 'unknown', 0.4, 'done', 1)`).run(ids[2], chainNameKey(row(ids[2]).name));
        assert.equal(pickIds().includes(ids[2]), false);
        sql.prepare('UPDATE PlaceChainCheck SET rule_version=0 WHERE place_id=?').run(ids[2]);
        assert.equal(pickIds().includes(ids[2]), true);
    });

    await test('runPlaceChainRound processes at most one batch of ten per round', async () => {
        Array.from({ length: 12 }, (_, index) => place(`两轮样本 ${index}`));
        const first = tracker(allChain);
        const one = await round(first.complete);
        assert.deepEqual([one.selected, one.checked, one.model], [10, 10, 10]);
        assert.equal(JSON.parse(first.calls[0].user).length, 10);
        const second = tracker(allChain);
        const two = await round(second.complete);
        assert.deepEqual([two.selected, two.checked, two.model], [2, 2, 2]);
        assert.equal(JSON.parse(second.calls[0].user).length, 2);
        assert.equal(sql.prepare('SELECT count(*) AS n FROM PlaceChainCheck').get().n, 12);
    });

    await test('switching observe to apply uses the backlog in one transaction and never calls the model', async () => {
        const ids = [place('积压一'), place('积压二'), place('积压三')];
        await classifyPlaces(ids.map((id) => ({ id })), { database: sql, complete: allChain, now: NOW });
        const backlogOnly = place('只分类不应用', { category: '烧烤' });
        const revision = clock();
        const before = ids.map(row);

        const reader = new Database(file, { readonly: true });
        const observed = [];
        sql.function('independent_chain_commit_probe', () => {
            observed.push(reader.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision);
            return observed.length;
        });
        sql.exec('CREATE TEMP TRIGGER independent_chain_commit AFTER UPDATE OF category ON Place BEGIN SELECT independent_chain_commit_probe(); END;');
        let stats;
        try {
            stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        } finally {
            sql.exec('DROP TRIGGER independent_chain_commit');
            reader.close();
        }
        assert.deepEqual([stats.selected, stats.applied], [0, 3]);
        assert.deepEqual(observed, [revision, revision, revision]);
        assert.equal(clock(), revision + 3);
        assert.deepEqual(ids.map(row), before.map((item) => ({ ...item, category: `${item.category}, ${CHAIN_TAG}` })));
        assert.equal(check(backlogOnly), undefined);
        const again = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(again.applied, 0);
    });

    await test('off mode and a missing DeepSeek key do not start the worker or throw', async () => {
        const timers = fakeTimers();
        const hasConfig = tracker(() => true);
        const restore = patch(ai, 'hasDeepseekConfiguration', () => { hasConfig.calls.push(true); return true; });
        let stop = null;
        try {
            process.env.PLACE_CHAIN_TAG_MODE = 'off';
            stop = chain.startPlaceChainWorker();
            assert.equal(timers.calls.length, 0);
            assert.equal(hasConfig.calls.length, 0);
            assert.equal(typeof stop, 'function');
            stop();
            stop = null;

            process.env.PLACE_CHAIN_TAG_MODE = 'observe';
            restore();
            const restoreMissing = patch(ai, 'hasDeepseekConfiguration', () => false);
            try {
                assert.doesNotThrow(() => { stop = chain.startPlaceChainWorker(); });
                assert.equal(timers.calls.length, 0);
                stop();
                stop = null;
            } finally { restoreMissing(); }

            const result = await round(noModel, { config: { mode: 'off' } });
            assert.deepEqual([result.selected, result.applied], [0, 0]);
        } finally {
            if (stop) stop();
            restore();
            timers.restore();
        }
    });

    await test('the worker applies the startup backlog before its first model request', async () => {
        const backlog = place('启动积压');
        await classifyPlaces([{ id: backlog }], { database: sql, complete: allChain, now: NOW });
        process.env.PLACE_CHAIN_TAG_MODE = 'apply';
        const timers = fakeTimers();
        const model = tracker(allChain);
        const restoreConfig = patch(ai, 'hasDeepseekConfiguration', () => true);
        const restoreModel = patch(ai, 'completeDeepseekJson', model.complete);
        let stop = null;
        try {
            stop = chain.startPlaceChainWorker();
            assert.equal(timers.calls.length, 1);
            await timers.calls.at(-1).fn();
            assert.equal(model.calls.length, 0);
            assert.equal(row(backlog).category, '面馆, 连锁店');
            assert.equal(timers.calls.at(-1).delay, 1500);

            const fresh = place('启动后新地点');
            await timers.calls.at(-1).fn();
            assert.equal(model.calls.length, 1);
            assert.equal(row(fresh).category, '面馆, 连锁店');
            assert.equal(timers.calls.at(-1).delay, 60_000);
        } finally {
            if (stop) stop();
            restoreModel();
            restoreConfig();
            timers.restore();
        }
    });

    await test('whole-batch failures back off the worker as a whole and create no per-place attempts', async () => {
        const id = place('整体退避地点');
        const timers = fakeTimers();
        let requests = 0;
        const modelHandler = async (input) => {
            requests += 1;
            if (requests === 1 || requests === 2 || requests === 4) throw new Error('fixture outage');
            if (requests === 3) return {};
            return allChain(input);
        };
        const restoreConfig = patch(ai, 'hasDeepseekConfiguration', () => true);
        const restoreModel = patch(ai, 'completeDeepseekJson', modelHandler);
        let stop = null;
        try {
            stop = chain.startPlaceChainWorker();
            for (const [index, delay] of [60_000, 600_000, 3_600_000, 3_600_000].entries()) {
                await timers.calls.at(-1).fn();
                assert.equal(requests, index + 1);
                assert.equal(timers.calls.at(-1).delay, delay);
                assert.equal(check(id), undefined);
                const scheduled = timers.calls.length;
                chain.wakePlaceChainWorker();
                assert.equal(timers.calls.length, scheduled);
            }
            await timers.calls.at(-1).fn();
            assert.equal(requests, 5);
            assert.equal(check(id).status, 'done');
            assert.equal(check(id).attempts, 1);
            assert.equal(timers.calls.at(-1).delay, 60_000);
        } finally {
            if (stop) stop();
            restoreModel();
            restoreConfig();
            timers.restore();
        }
    });

    await test('rating features, groups and profile/reputation inputs are identical with or without the tag', async () => {
        const { buildFullFeatures } = require('../../modules/ratings/services/fullModelFeatures');
        const { axes } = require('../../modules/ratings/services/bootstrapFeatures');
        const { inputFor, inputHash } = require('../../modules/ratings/services/modelProfiles');
        const { insertCreationRating } = require('../../modules/ratings/services/placeRatings');
        const { markdownToPlainText } = require('../../modules/places/services/markdownText');
        const { clip } = require('../../modules/ratings/services/modelEmbeddings');
        const estimates = require('../../modules/ratings/services/ratingEstimateAdapter');
        const reputation = require('../../modules/ratings/services/ratingReputationAdapter');

        const normal = place('评分普通店', { category: '面馆, 快餐' });
        const empty = place('评分空分类', { category: null });
        const untagged = place('无标签旧店', { category: ' 面馆，  快餐厅, 面馆 ' });
        const ids = [normal, empty];
        const ratingNow = NOW;
        for (const id of ids) insertCreationRating(id, 'owner', 4, ratingNow, 'creation_explicit');

        const select = sql.prepare('SELECT id, name, category, description, per_person_cost FROM Place WHERE id=?');
        const sample = ids.map((id) => select.get(id));
        const ratings = ids.map((id) => ({ place_id: id, user_id: 'owner', score: 4, created_at: ratingNow }));
        const contract = {
            categories: ['面馆', '快餐', CHAIN_TAG],
            profiles: { ds: { properties: ['sample listing property'] }, rv: { properties: ['sample review property'] } },
            flags: []
        };
        const full = (places) => {
            const builder = buildFullFeatures({ places, ratings, asOf: NOW, contract });
            return ids.map((id) => builder.featureFor(id));
        };
        const original = select.get(untagged);
        const legacyInput = { place: { ...original, description: clip(markdownToPlainText(original.description || ''), 400) }, reviews: [] };
        assert.deepEqual(inputFor(untagged), legacyInput);
        assert.equal(inputHash(inputFor(untagged)), inputHash(legacyInput));

        const before = sample.map((item) => ({ axes: axes(item), input: inputFor(item.id), hash: inputHash(inputFor(item.id)), features: full(sample) }));
        const model = { method: 'research_full_nonchain', model_id: 'independent-chain-test', model_hash: 'd'.repeat(64), schema_version: 2 };
        const groups = [];
        const featureInputs = [];
        const reputationInputs = [];
        const restores = [
            patch(numeric, 'capabilities', async () => model),
            patch(numeric, 'compute', async (operation, input) => {
                if (operation === 'modelcontract') return { feature_contract: contract, feature_orders: {} };
                if (operation === 'vectormean') return { sum: null, count: 0 };
                if (operation === 'ratingquality') { groups.push(input.place_groups); return { qualities: [] }; }
                if (operation === 'ratingestimate') { featureInputs.push(input.place_features); return { estimates: [] }; }
                throw new Error(`unexpected numeric operation ${operation}`);
            }),
            patch(numeric, 'computeRatingWeights', async ({ places }) => {
                reputationInputs.push(places.map(({ id, category }) => ({ id, category })));
                return { reputations: [], rating_weights: [] };
            })
        ];
        process.env.RATING_ESTIMATE_MODE = 'active';
        process.env.RATING_PREDICTION_MODE = 'off';
        try {
            await estimates.ratingViews(ids);
            await reputation.refreshRatingWeights(NOW);
            const groupsBefore = groups[0];
            const featuresBefore = featureInputs[0];
            const reputationBefore = reputationInputs[0];

            await classifyPlaces([{ id: normal }, { id: empty }], { database: sql, complete: allChain, now: NOW });
            const applied = applyPendingTags({ database: sql, minConfidence: 0.8 });
            assert.equal(applied, 2);
            assert.equal(row(normal).category, '面馆, 快餐, 连锁店');
            assert.equal(row(empty).category, CHAIN_TAG);

            const tagged = ids.map((id) => select.get(id));
            assert.deepEqual(tagged.map(axes), sample.map(axes));
            assert.deepEqual(full(tagged), full(sample));
            assert.deepEqual(ids.map((id) => inputHash(inputFor(id))), before.map((item) => item.hash));
            assert.deepEqual(ids.map((id) => inputFor(id).place.category), ['面馆, 快餐', null]);

            groups.length = 0;
            featureInputs.length = 0;
            reputationInputs.length = 0;
            await estimates.ratingViews(ids);
            await reputation.refreshRatingWeights(NOW + 1);
            assert.deepEqual(groups[0], groupsBefore);
            assert.deepEqual(featureInputs[0], featuresBefore);
            assert.deepEqual(reputationInputs[0], reputationBefore);
            assert.deepEqual(groups[0].map(({ group_id }) => group_id), ['面馆', null]);
            assert.ok(reputationInputs[0].every(({ category }) => !hasChainTag(category)));
        } finally {
            process.env.RATING_ESTIMATE_MODE = 'off';
            process.env.RATING_PREDICTION_MODE = 'off';
            for (const restore of restores.reverse()) restore();
        }
    });

    await test('report is read-only by default, requires --db for --classify and exports escaped CSV', () => {
        const quoted = place('标题, "店名"', { category: '面馆' });
        const applied = place('已贴标签', { category: '面馆' });
        const locked = place('已锁定标签', { category: '面馆' });
        const manual = place('手工标签', { category: CHAIN_TAG });
        const scoped = [quoted, applied, locked];
        return (async () => {
            await classifyPlaces(scoped.map((id) => ({ id })), { database: sql, complete: allChain, now: NOW });
            await classifyPlaces([{ id: manual }], {
                database: sql, now: NOW,
                complete: async ({ user }) => ({ results: JSON.parse(user).map(({ id }) => chainResult(id, {
                    verdict: 'independent', brand: '', scope: null, confidence: 1
                })) })
            });
            assert.equal(applyPendingTags({ database: sql }), 3);
            setCategory(locked, '面馆');
            assert.equal(check(locked).suppressed, 1);
            assert.equal(hasChainTag(row(manual).category), true);

            const output = path.join(temp, 'chain-report.csv');
            const script = require.resolve('../../scripts/places/chain_tag_report');
            const child = (...args) => spawnSync(process.execPath, [script, ...args], {
                encoding: 'utf8', timeout: 20_000,
                env: { ...process.env, DB_FILE: file, PLACE_CHAIN_TAG_MODE: 'observe', PLACE_CHAIN_TAG_MIN_CONFIDENCE: '0.8' }
            });

            const revision = clock();
            const placeRows = sql.prepare('SELECT * FROM Place ORDER BY id').all();
            const checks = sql.prepare('SELECT * FROM PlaceChainCheck ORDER BY place_id').all();
            const valid = child('--out', output);
            assert.equal(valid.status, 0, valid.stderr);
            assert.match(valid.stdout, /chain：3/);
            assert.match(valid.stdout, /已打：2/);
            assert.match(valid.stdout, /已锁定：1/);
            assert.match(valid.stdout, /人工标了但模型判为非 chain：1/);
            assert.deepEqual(sql.prepare('SELECT * FROM Place ORDER BY id').all(), placeRows);
            assert.deepEqual(sql.prepare('SELECT * FROM PlaceChainCheck ORDER BY place_id').all(), checks);
            assert.equal(clock(), revision);

            const csv = fs.readFileSync(output, 'utf8');
            assert.match(csv, /^place_id,name,city,category,verdict,brand,scope,confidence,source,tag_applied,suppressed,has_tag_now\r\n/);
            assert.ok(csv.includes(`${quoted},"标题, ""店名""",,"面馆, 连锁店",chain`), csv);
            const manualLine = csv.split('\r\n').find((line) => line.startsWith(`${manual},手工标签,`));
            assert.ok(manualLine, csv);
            assert.ok(manualLine.includes(',连锁店,independent,'), manualLine);
            assert.ok(manualLine.endsWith(',0,0,1'), manualLine);

            const unsafe = child('--classify');
            assert.equal(unsafe.status, 1);
            assert.match(unsafe.stderr, /--classify.*--db/);

            fs.writeFileSync(REPORT_PRELOAD, `const ai = require(${JSON.stringify(require.resolve('../../infrastructure/aiClients'))});
                ai.hasDeepseekConfiguration = () => true;
                ai.completeDeepseekJson = async ({ user }) => process.env.REPORT_FIXTURE_FAIL ? {} : ({ results: JSON.parse(user).map(({ id }) => ({
                    id, verdict: 'not_food', brand: '', scope: null, confidence: 1 })) });`);

            const firstPending = place('补判断一');
            const secondPending = place('补判断二');
            const first = spawnSync(process.execPath, ['--require', REPORT_PRELOAD, script, '--db', file, '--classify', '--limit', '1'], {
                encoding: 'utf8', timeout: 20_000,
                env: { ...process.env, DB_FILE: file, PLACE_CHAIN_TAG_MODE: 'observe', PLACE_CHAIN_TAG_MIN_CONFIDENCE: '0.8' }
            });
            assert.equal(first.status, 0, first.stderr);
            assert.equal(check(firstPending).verdict, 'not_food');
            assert.equal(check(secondPending), undefined);

            const failed = spawnSync(process.execPath, ['--require', REPORT_PRELOAD, script, '--db', file, '--classify'], {
                encoding: 'utf8', timeout: 20_000,
                env: { ...process.env, DB_FILE: file, REPORT_FIXTURE_FAIL: '1', PLACE_CHAIN_TAG_MODE: 'observe' }
            });
            assert.equal(failed.status, 1);
            assert.match(failed.stderr, /批次请求失败/);
            assert.equal(check(secondPending), undefined);
        })();
    });

    // -----------------------------------------------------------------------
    // Summary and cleanup
    // -----------------------------------------------------------------------
    try { sql.close(); } catch (_) { /* ignore */ }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    const failed = outcomes.filter((entry) => !entry.ok);
    console.log(`\n${outcomes.length - failed.length} passed, ${failed.length} failed, ${outcomes.length} total`);
    if (failed.length) process.exitCode = 1;
})();
