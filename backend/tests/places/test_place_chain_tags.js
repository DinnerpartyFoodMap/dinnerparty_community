'use strict';

const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-chain-tags-'));
const file = path.join(temp, 'test.sqlite');
Object.assign(process.env, {
    DB_FILE: file, DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: 'fake-deepseek', SILICONFLOW_API_KEY: '', AMAP_WEB_SERVICE_KEY: '',
    LOG_TO_CONSOLE: 'false', LOG_TO_FILE: 'false', PLACE_MODERATION_ENABLED: 'false', PLACE_CHAIN_TAG_MODE: 'observe',
    PLACE_CHAIN_TAG_MIN_CONFIDENCE: '0.8', PLACE_CHAIN_TAG_MODEL: '', RATING_ESTIMATE_MODE: 'off', RATING_PREDICTION_MODE: 'off',
    MARKER_SNAPSHOT_TTL_MS: '1000', TILE_SNAPSHOT_TTL_MS: '1000'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
init();
sql.prepare("INSERT INTO User(id, username, password, admin_level) VALUES ('owner', 'owner', 'x', NULL), ('admin', 'admin', 'x', 'YUYUKO'), ('guest', 'guest', 'x', NULL)").run();
const chain = require('../../modules/places/services/placeChainTags');
const { CHAIN_TAG, CHAIN_SYSTEM_PROMPT, chainNameKey, hasChainTag, stripChainTag,
    classifyPlaces, selectPendingPlaces, runPlaceChainRound, applyPendingTags } = chain;
const ai = require('../../infrastructure/aiClients');
const now = Date.now();
const old = new Date(now - 31 * 60_000).toISOString();
const recent = new Date(now - 1000).toISOString();
const round = (complete, extra = {}) => runPlaceChainRound({ database: sql, complete, now, ...extra });
const noModel = () => assert.fail('Unexpected model call');
const chainResult = (id, extra = {}) => ({ id, verdict: 'chain', brand: '示例品牌', scope: 'national', confidence: 0.9, ...extra });
const allChain = async ({ user }) => ({ results: JSON.parse(user).map(({ id }) => chainResult(id)) });
const clock = (database = sql) => database.prepare('SELECT revision FROM AlgorithmClock').get().revision;
const row = (id) => sql.prepare('SELECT * FROM Place WHERE id = ?').get(id);
const check = (id) => sql.prepare('SELECT * FROM PlaceChainCheck WHERE place_id = ?').get(id);
const setCategory = (id, category) => sql.prepare('UPDATE Place SET category = ? WHERE id = ?').run(category, id);

function place(name, { category = '面馆', status = 'visible', date = old, description = '这里有真材实料的手工面条和每日现熬的浓郁牛肉汤。' } = {}) {
    const insert = sql.prepare(`INSERT INTO Place(name, category, description, moderation_status, created_time,
        creator_id, updated_by, updated_time, has_vector, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, 'owner', 'owner', '2026-01-01 00:00:00', 1, 23.1, 113.2)`);
    return Number(insert.run(name, category, description, status, date).lastInsertRowid);
}

function pickIds(options) {
    return selectPendingPlaces({ database: sql, now, ...options }).map(({ id }) => id);
}

beforeEach(() => {
    sql.exec('DELETE FROM Place');
});
after(() => {
    sql.close();
    fs.rmSync(temp, { recursive: true, force: true });
});

test('normalizes names, matches exact SQL/JS tag boundaries and keeps the documented prompt', () => {
    for (const [input, expected] of [
        [' ＭＡＮＮＥＲ（北京） (其它)【区】 [a(b)]「店」 ', 'manner'], ['麦当劳 人民广场店', '麦当劳'],
        ['麦当劳-人民广场店', '麦当劳'], ['麦当劳 — 人民广场店（南门）', '麦当劳'], ['麦当劳·人民广场店', '麦当劳'],
        ['Shake Shack 人民广场店', 'shakeshack'], ['正宗 兰州拉面', '正宗兰州拉面'], ['麦当劳人民广场店', '麦当劳人民广场店'],
        ['咖啡-小馆', '咖啡-小馆'], ['（【a】[b]「(c)」） 店', '店']
    ]) assert.equal(chainNameKey(input), expected, input);
    const categoryCases = [
        [null, false], ['面馆,非连锁店,连锁店铺', false], ['主打连锁店面馆', false], ['连锁店', true],
        ['连锁店， 面馆', true], ['面馆,  连锁店 \n', true], ['面馆 连锁店 非连锁店', true],
        ['面馆\u00a0连锁店\u3000小吃', true], ['面馆|连锁店|小吃', true], ['连锁店铺，非连锁店', false]
    ];
    for (const [category, expected] of categoryCases) {
        assert.equal(hasChainTag(category), expected, JSON.stringify(category));
        const id = place('店', { category });
        setCategory(id, '其他');
        assert.equal(check(id)?.suppressed === 1, expected, JSON.stringify(category));
        if (!expected) continue;
        assert.equal(check(id).status, 'pending');
        setCategory(id, category);
        assert.equal(check(id).suppressed, 0);
    }
    assert.equal(stripChainTag('连锁店，面馆, 连锁店, Fresh Pasta, 非连锁店'), '面馆, Fresh Pasta, 非连锁店');
    assert.equal(stripChainTag('面馆  连锁店'), '面馆');
    assert.equal(stripChainTag('连锁店'), '');
    assert.equal(stripChainTag('非连锁店，连锁店铺'), '非连锁店，连锁店铺');
    const doc = fs.readFileSync(path.join(__dirname, '../../modules/places/doc/README.md'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(doc.split('### 连锁店识别提示词')[1].split('```text\n')[1].split('\n```')[0], CHAIN_SYSTEM_PROMPT);
});

test('observe uses local rules and a single model batch with public same-name evidence', async () => {
    const noodles = place('正宗老牌兰州拉面（人民广场店）');
    const shaxian = place('沙县小吃');
    const one = place('麦当劳（人民广场店）', { category: '快餐, 连锁店', description: `**牛肉**\n\n<a href="/a">汉堡</a>\n${'鲜'.repeat(120)}` });
    const two = place('麦当劳-渡口店');
    const three = place('麦当劳 人民大道店');
    const local = place('陶陶居');
    const hidden = place('麦当劳·私有店', { status: 'pending' });
    const rejected = place('麦当劳·驳回店', { status: 'rejected' });
    const insertRegion = sql.prepare('INSERT INTO PlaceRegion(place_id, city, checked_at) VALUES (?, ?, 0)');
    for (const [id, city] of [[one, '上海市'], [two, '深圳市'], [three, '深圳市'], [hidden, '北京市']]) insertRegion.run(id, city);
    assert.deepEqual(pickIds(), [noodles, shaxian, one, two, three, local]);
    const before = sql.prepare('SELECT * FROM Place ORDER BY id').all();
    const revision = clock();
    let calls = 0;
    const stats = await round(async ({ system, user, model, maxTokens, temperature }) => {
        calls++;
        assert.equal(system, CHAIN_SYSTEM_PROMPT);
        assert.equal(model, 'fake-deepseek');
        assert.equal(temperature, 0);
        assert.ok(maxTokens >= 1500);
        const input = JSON.parse(user);
        assert.deepEqual(input.map(({ id }) => id), [one, two, three, local]);
        assert.deepEqual(input[0], { id: one, name: row(one).name, category: '快餐', city: '上海市',
            description: `牛肉 汉堡 ${'鲜'.repeat(114)}`, site_same_name: { places: 3, cities: 2 } });
        assert.equal(input[3].city, null);
        return { results: input.reverse().map(({ id }) => chainResult(id, { scope: id === local ? 'regional' : 'national', brand: `**${'示'.repeat(45)}**` })) };
    });
    assert.equal(calls, 1);
    assert.deepEqual([stats.rule, stats.model, stats.chain, stats.category_name, stats.applied], [2, 4, 4, 2, 0]);
    assert.deepEqual([check(noodles).name_key, check(noodles).verdict, check(noodles).confidence, check(noodles).source],
        ['正宗老牌兰州拉面', 'category_name', 1, 'rule']);
    assert.equal(check(local).scope, 'regional');
    assert.equal(check(local).brand, '示'.repeat(40));
    assert.equal(check(local).model, 'fake-deepseek');
    assert.equal(check(rejected), undefined);
    assert.deepEqual(sql.prepare('SELECT * FROM Place ORDER BY id').all(), before);
    assert.equal(clock(), revision);
    const pureRule = place('风味重庆小面');
    assert.equal((await round(noModel)).category_name, 1);
    assert.equal(check(pureRule).model, null);
});

test('invalid and missing model rows retry on schedule, while valid and unknown rows settle', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => place(`样本 ${i}`));
    const [good, unknown, missing, invalidVerdict, invalidScope, invalidConfidence, duplicate, invalidBrand] = ids;
    const answer = async () => ({ results: [
        chainResult(unknown, { verdict: 'unknown', brand: '忽略', scope: 'regional' }), chainResult(9999),
        chainResult(invalidVerdict, { verdict: 'maybe' }), chainResult(invalidScope, { scope: 'city' }),
        chainResult(invalidConfidence, { confidence: 2 }), chainResult(duplicate), chainResult(good),
        chainResult(duplicate), { id: invalidBrand, verdict: 'chain', scope: 'national', confidence: 1 }
    ] });
    const failed = [missing, invalidVerdict, invalidScope, invalidConfidence, duplicate, invalidBrand];
    assert.equal((await round(answer)).error, failed.length);
    assert.equal(check(good).verdict, 'chain');
    assert.deepEqual([check(unknown).verdict, check(unknown).scope, check(unknown).brand], ['unknown', null, '']);
    const failureAt = (id, attempt, delay, at) => assert.deepEqual(
        [check(id).status, check(id).attempts, check(id).checked_at, check(id).next_retry_at, check(id).verdict],
        ['error', attempt, at, at + delay, null]);
    for (const id of failed) failureAt(id, 1, 60_000, now);
    assert.deepEqual(pickIds({ now: now + 59_999 }), []);
    const missingRows = async () => ({ results: [] });
    await round(missingRows, { now: now + 60_000 });
    for (const id of failed) failureAt(id, 2, 600_000, now + 60_000);
    await round(missingRows, { now: now + 660_000 });
    for (const id of failed) failureAt(id, 3, 3_600_000, now + 660_000);
    assert.deepEqual(pickIds({ now: now + 4_260_000 }), []);
    sql.prepare('UPDATE PlaceChainCheck SET rule_version = 0 WHERE place_id IN (?, ?)').run(unknown, good);
    assert.deepEqual(pickIds(), [unknown]);
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('新样本', missing);
    assert.deepEqual(pickIds(), [unknown, missing]);
    await round(allChain);
    assert.equal(check(missing).attempts, 1);
    assert.equal(check(unknown).rule_version, 1);
});

test('exhausted errors retry after a rule upgrade, including records without a version', async () => {
    const oldRule = place('旧规则');
    const noVersion = place('未记录规则版本');
    const currentRule = place('当前规则');
    const seed = sql.prepare(`INSERT INTO PlaceChainCheck (place_id, name_key, rule_version, status, attempts, next_retry_at)
        VALUES (?, ?, ?, 'error', 3, ?)`);
    for (const [id, version] of [[oldRule, 0], [noVersion, null], [currentRule, 1]]) {
        seed.run(id, chainNameKey(row(id).name), version, now + 3_600_000);
    }
    assert.deepEqual(pickIds(), [oldRule, noVersion]);
    const oldSnapshot = [oldRule, noVersion, currentRule].map(check);
    assert.equal((await round(async () => ({}))).requestStatus, 'failed');
    assert.deepEqual([oldRule, noVersion, currentRule].map(check), oldSnapshot);

    await round(async () => ({ results: [chainResult(oldRule)] }));
    assert.deepEqual([check(oldRule).status, check(oldRule).attempts, check(oldRule).rule_version], ['done', 1, 1]);
    assert.deepEqual([check(noVersion).status, check(noVersion).attempts, check(noVersion).rule_version, check(noVersion).next_retry_at],
        ['error', 1, 1, now + 60_000]);
    assert.deepEqual(check(currentRule), oldSnapshot[2]);
});

test('normalizes numeric-string IDs and defaults absent non-chain brand and scope', async () => {
    const [national, independent, unknown, duplicate, missingChainScope] = Array.from({ length: 5 }, (_, i) => place(`样本 ${i}`));
    const result = await round(async () => ({ results: [
        chainResult(String(national)), { id: String(independent), verdict: 'independent', confidence: 0.8 },
        { id: unknown, verdict: 'unknown', confidence: 0.4, scope: null },
        chainResult(String(duplicate)), chainResult(duplicate),
        { id: missingChainScope, verdict: 'chain', confidence: 1, brand: '某品牌' }
    ] }));
    assert.deepEqual([result.requestStatus, result.chain, result.independent, result.unknown, result.error], ['ok', 1, 1, 1, 2]);
    for (const id of [independent, unknown]) assert.deepEqual([check(id).brand, check(id).scope], ['', null]);
    for (const id of [duplicate, missingChainScope]) assert.equal(check(id).status, 'error');
});

test('observation backlog is applied atomically and preserves metadata and existing tags', async () => {
    const normal = place('点都德', { category: '粤菜, 早茶' });
    const empty = place('陶陶居', { category: null });
    const manual = place('某品牌', { category: '连锁店, 快餐' });
    const long = place(' long ', { category: Array.from({ length: 14 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(14)}`).join(', ') });
    const low = place('低置信度');
    const renamed = place('改名');
    const hidden = place('稍后隐藏');
    await round(async ({ user }) => ({ results: JSON.parse(user).map(({ id }) => chainResult(id, { confidence: id === low ? 0.79 : 0.8 })) }));
    sql.prepare("UPDATE Place SET name = '新店名' WHERE id = ?").run(renamed);
    sql.prepare("UPDATE Place SET moderation_status = 'pending' WHERE id = ?").run(hidden);
    sql.prepare('DELETE FROM Category WHERE name = ?').run(CHAIN_TAG);
    const before = new Map([normal, empty, manual, long, low, renamed, hidden].map((id) => [id, row(id)]));
    const revision = clock();
    const history = sql.prepare('SELECT count(*) AS n FROM PlaceRevision').get().n;
    const reader = new Database(file, { readonly: true });
    const observed = [];
    sql.function('observe_chain_commit', () => { observed.push(clock(reader)); return observed.length; });
    sql.exec('CREATE TEMP TRIGGER test_chain_commit AFTER UPDATE OF category ON Place BEGIN SELECT observe_chain_commit(); END;');
    try {
        const stats = await round(noModel, { config: { mode: 'apply', minConfidence: 0.8 }, applyOnly: true });
        assert.equal(stats.applied, 2);
    } finally {
        sql.exec('DROP TRIGGER test_chain_commit');
        reader.close();
    }
    assert.deepEqual(observed, [revision, revision], 'other connections only see the old revision during all updates');
    assert.equal(clock(), revision + 2);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM PlaceRevision').get().n, history);
    assert.deepEqual(sql.prepare('SELECT name, created_by FROM Category WHERE name = ?').get(CHAIN_TAG), { name: CHAIN_TAG, created_by: null });
    assert.deepEqual(row(normal), { ...before.get(normal), category: '粤菜, 早茶, 连锁店' });
    assert.deepEqual(row(empty), { ...before.get(empty), category: CHAIN_TAG });
    for (const id of [manual, long, low, renamed, hidden]) assert.deepEqual(row(id), before.get(id));
    assert.equal(check(normal).tag_applied, 1);
    assert.ok(check(normal).applied_at);
    assert.equal(applyPendingTags({ database: sql }), 0);
    assert.equal(clock(), revision + 2);
});

test('suppression survives classification and concurrent removal, then clears on rename or manual re-add', async () => {
    const locked = place('手工标注（甲店）', { category: '连锁店, 非连锁店' });
    const renameBeforeCheck = place('以后改名', { category: CHAIN_TAG });
    const racing = place('请求期间删除', { category: CHAIN_TAG });
    const deleted = place('请求期间删地点');
    const removedAfterRename = place('先分类再改名', { category: CHAIN_TAG });
    await classifyPlaces([{ id: removedAfterRename }], { database: sql, complete: allChain, now });
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('改名后明确去标签', removedAfterRename);
    setCategory(removedAfterRename, '面馆');
    setCategory(locked, '非连锁店');
    setCategory(renameBeforeCheck, '其他');
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('新品牌', renameBeforeCheck);
    await round(async (input) => {
        setCategory(racing, '面馆');
        sql.prepare('DELETE FROM Place WHERE id = ?').run(deleted);
        return allChain(input);
    });
    assert.equal(check(deleted), undefined);
    assert.equal(check(locked).suppressed, 1);
    assert.equal(check(renameBeforeCheck).suppressed, 0);
    assert.equal(check(racing).suppressed, 1);
    assert.equal(check(removedAfterRename).suppressed, 1);
    assert.equal(applyPendingTags({ database: sql }), 1);
    assert.equal(row(locked).category, '非连锁店');
    setCategory(racing, '面馆, 连锁店');
    assert.equal(check(racing).suppressed, 0);
    assert.equal(check(racing).tag_applied, 0);
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('手工标注（乙店）', locked);
    assert.deepEqual(pickIds(), []);
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('手工标注改名', locked);
    await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
    assert.equal(row(locked).category, '非连锁店, 连锁店');
    assert.equal(check(locked).suppressed, 0);
    assert.equal(check(locked).tag_applied, 1);
    setCategory(locked, '面馆');
    assert.equal(check(locked).tag_applied, 0);
    assert.equal(applyPendingTags({ database: sql }), 0);

    const second = new Database(file);
    try {
        second.pragma('foreign_keys = OFF');
        second.prepare('DELETE FROM Place WHERE id = ?').run(locked);
        assert.equal(check(locked), undefined);
    } finally { second.close(); }
});

test('waits for regions and wakes on creation and once moderation publishes a place', async (t) => {
    t.mock.method(chain, 'wakePlaceChainWorker');
    chain.wakePlaceChainWorker.mock.mockImplementationOnce(() => { throw new Error('fixture wake failure'); });
    const vectors = require('../../modules/preferences/services/placeVectorService');
    t.mock.method(vectors, 'queuePlaceVectorSync', () => {});
    const ready = place('地区已就绪', { date: recent });
    const waiting = place('等地区', { date: recent });
    const timedOut = place('等待超时');
    const checking = place('审核样本');
    place('待复核样本', { status: 'pending' });
    place('驳回样本', { status: 'rejected' });
    sql.prepare('INSERT INTO PlaceRegion(place_id, city, checked_at) VALUES (?, NULL, 0)').run(ready);
    const moderation = require('../../modules/places/services/placeModeration');
    process.env.PLACE_MODERATION_ENABLED = 'true';
    assert.equal(moderation.registerNewPlaceSync(checking, 'owner', 'web'), 'checking');
    process.env.PLACE_MODERATION_ENABLED = 'false';
    process.env.AMAP_WEB_SERVICE_KEY = 'not-a-real-key';
    try {
        assert.deepEqual(pickIds(), [ready, timedOut]);
        require('../../modules/places/services/placeService').afterPlacesCreated([ready]);
        await new Promise(setImmediate);
        assert.equal(chain.wakePlaceChainWorker.mock.callCount(), 1);
        process.env.PLACE_REGION_WORKER = 'false';
        assert.deepEqual(pickIds(), [ready, waiting, timedOut]);
        delete process.env.PLACE_REGION_WORKER;
        assert.equal(await moderation.moderatePlace(checking), 'visible');
        assert.equal(chain.wakePlaceChainWorker.mock.callCount(), 2);
        assert.deepEqual(pickIds(), [ready, timedOut, checking]);
    } finally { process.env.AMAP_WEB_SERVICE_KEY = ''; }
});

test('worker modes disable scheduling or apply the startup backlog before model calls', async (t) => {
    const timer = t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    const model = t.mock.method(ai, 'completeDeepseekJson', allChain);
    const configured = t.mock.method(ai, 'hasDeepseekConfiguration', () => true);
    process.env.PLACE_CHAIN_TAG_MODE = 'off';
    chain.startPlaceChainWorker()();
    assert.equal(configured.mock.callCount(), 0);
    process.env.PLACE_CHAIN_TAG_MODE = 'observe';
    configured.mock.mockImplementation(() => false);
    chain.startPlaceChainWorker()();
    assert.equal(timer.mock.callCount(), 0);

    const backlogged = place('启动前记录');
    await classifyPlaces([{ id: backlogged }], { database: sql, complete: allChain, now });
    const fresh = place('启动后判断');
    configured.mock.mockImplementation(() => true);
    process.env.PLACE_CHAIN_TAG_MODE = 'apply';
    const stop = chain.startPlaceChainWorker();
    try {
        await timer.mock.calls.at(-1).arguments[0]();
        assert.equal(model.mock.callCount(), 0);
        assert.equal(check(backlogged).tag_applied, 1);
        await timer.mock.calls.at(-1).arguments[0]();
        assert.equal(model.mock.callCount(), 1);
        assert.equal(check(fresh).tag_applied, 1);
    } finally { stop(); process.env.PLACE_CHAIN_TAG_MODE = 'observe'; }
});

test('whole-batch failures back off the worker, preserve checks and reset after recovery', async (t) => {
    const retrying = place('重试样本');
    await classifyPlaces([{ id: retrying }], { database: sql, complete: async () => ({ results: [] }), now: now - 60_000 });
    const saved = check(retrying);
    const renamed = place('旧店名');
    await classifyPlaces([{ id: renamed }], { database: sql, complete: allChain, now });
    const savedName = check(renamed);
    sql.prepare('UPDATE Place SET name = ? WHERE id = ?').run('新店名', renamed);
    const unchecked = Array.from({ length: 8 }, (_, i) => place(`新样本 ${i}`));
    const timer = t.mock.method(global, 'setTimeout', () => ({ unref() {} }));
    t.mock.method(ai, 'hasDeepseekConfiguration', () => true);
    let requests = 0;
    t.mock.method(ai, 'completeDeepseekJson', async (input) => {
        requests++;
        if (requests === 5) return allChain(input);
        chain.wakePlaceChainWorker();
        if (requests === 4) return { results: null };
        throw new Error('fixture provider outage');
    });
    const stop = chain.startPlaceChainWorker();
    const latest = () => timer.mock.calls.at(-1).arguments;
    try {
        for (const [index, delay] of [60_000, 600_000, 3_600_000, 3_600_000].entries()) {
            await latest()[0]();
            assert.equal(requests, index + 1);
            assert.equal(latest()[1], delay);
            assert.deepEqual(check(retrying), saved);
            assert.deepEqual(check(renamed), savedName);
            assert.ok(unchecked.every((id) => check(id) === undefined));
            const scheduled = timer.mock.callCount();
            chain.wakePlaceChainWorker();
            assert.equal(timer.mock.callCount(), scheduled);
        }
        assert.equal(JSON.parse(ai.completeDeepseekJson.mock.calls[0].arguments[0].user).length, 10);
        await latest()[0]();
        assert.equal(latest()[1], 1500);
        assert.equal(check(retrying).attempts, 2);
        assert.deepEqual([check(renamed).name_key, check(renamed).attempts], ['新店名', 1]);
        assert.ok(unchecked.every((id) => check(id).verdict === 'chain' && check(id).attempts === 1));
        const next = place('恢复后的新样本');
        await latest()[0]();
        assert.equal(latest()[1], 60_000);
        assert.equal(check(next), undefined);
    } finally { stop(); }
});

test('owner and admin edits, request approval and the category merge script all suppress removal', async (t) => {
    const summaries = require('../../modules/ratings/services/ratingSummaryAdapter');
    t.mock.method(summaries, 'ensureRatingSummaries', async () => clock());
    const vectorSync = require('../../modules/preferences/services/placeVectorService');
    t.mock.method(vectorSync, 'queuePlaceVectorSync', () => {});
    const byOwner = place('住民编辑', { category: '餐厅, 连锁店' });
    const byAdmin = place('管理员编辑', { category: '餐厅, 连锁店' });
    const byReview = place('批准修改申请', { category: '餐厅, 连锁店' });
    const byMerge = place('脚本合并', { category: '餐厅, 连锁店' });
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    const server = await listen(app);
    try {
        const request = async (url, method, user, body, expected) => {
            const token = jwt.sign({ id: user }, process.env.JWT_SECRET || 'yuyuko_secret_key');
            const response = await fetch(`${server.url}${url}`, { method, body: JSON.stringify(body),
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
            const payload = await response.json();
            assert.equal(response.status, expected, JSON.stringify(payload));
            return payload;
        };
        await request(`/places/${byOwner}`, 'PUT', 'owner', { category: '餐厅', no_experience: true }, 200);
        await request(`/places/${byAdmin}`, 'PUT', 'admin', { category: '餐厅', no_experience: true }, 200);
        const edit = await request('/place-requests', 'POST', 'guest',
            { place_id: byReview, proposed: { category: '餐厅' }, note: '该地点是独立运营的商家', no_experience: true }, 201);
        await request(`/place-requests/${edit.id}/review`, 'POST', 'admin', { action: 'approve' }, 200);
    } finally { await server.close(); }

    // Supply a temporary merge rule in the child process to exercise a merge that removes this tag.
    const mergeRules = require.resolve('../../modules/places/categoryMerges.json');
    const preload = path.join(temp, 'test-merge-rules.js');
    // Drop rules that keep 连锁店 as a target first: a kept tag may not also be merged away.
    fs.writeFileSync(preload, `const m = require(${JSON.stringify(mergeRules)}).merges;
for (const key of Object.keys(m)) if (m[key] === '连锁店') delete m[key];
m['连锁店'] = '独立经营';`);
    const result = spawnSync(process.execPath,
        ['--require', preload, require.resolve('../../scripts/places/merge_categories'), '--db', file, '--apply'],
        { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(row(byMerge).category, '餐厅, 独立经营');
    for (const id of [byOwner, byAdmin, byReview, byMerge]) {
        assert.equal(check(id).suppressed, 1);
        assert.equal(check(id).verdict, null);
    }
    await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
    for (const id of [byOwner, byAdmin, byReview, byMerge]) assert.equal(hasChainTag(row(id).category), false);
});

async function listen(app) {
    const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    } };
}

test('detail, list, marker snapshot and map tiles reflect tags on normal reads and refresh', async (t) => {
    const numeric = require('../../infrastructure/numericAlgorithmClient');
    t.mock.method(numeric, 'capabilities', async () => null);
    t.mock.method(numeric, 'compute', async (operation, input) => {
        if (operation === 'ratingsummary') {
            return { summaries: input.place_ids.map((place_id) => ({ place_id, count: 0, average: null, tier: null,
                distribution: { 1: 0, 2: 0, 3: 0, 4: 0 } })) };
        }
        assert.equal(operation, 'ratingsort');
        return { ranked: input.places.map(({ id }) => ({ place_id: id, score: 2.5 })) };
    });
    const id = place('缓存地点');
    await round(allChain);
    const app = express();
    app.use(require('../../http/middleware/publicCache').publicCache());
    app.use('/places/tiles', require('../../modules/places/routes/placeTiles'));
    app.use('/places', require('../../modules/places/routes/places'));
    const server = await listen(app);
    const get = async (url, status = 200) => {
        const result = await fetch(server.url + url);
        const body = await result.json();
        assert.equal(result.status, status, JSON.stringify(body));
        return body;
    };
    const markerCategory = (data) => data.rows.find((item) => item[0] === id)[data.fields.indexOf('category')];
    const tiles = '/places/tiles';
    try {
        const beforeList = await get('/places/list');
        assert.equal(beforeList.items[0].category, '面馆');
        assert.equal((await get(`/places/${id}`)).category, '面馆');
        assert.equal(markerCategory(await get('/places/markers')), '面馆');
        const oldManifest = await get(`${tiles}/manifest`);
        assert.equal(applyPendingTags({ database: sql }), 1);
        assert.equal((await get(`/places/${id}`)).category, '面馆, 连锁店');
        assert.equal((await get('/places/list')).items[0].category, '面馆, 连锁店');
        await get(`/places/list?snapshot=${beforeList.snapshot}`, 409);
        const { listPlaces } = require('../../modules/places/services/placeList');
        await assert.rejects(listPlaces({ snapshot: beforeList.snapshot }), (error) => error.code === 'stale_input');
        assert.equal((await get('/places/list?excludeTags=连锁店')).items.length, 0);

        const afterTtl = Date.now() + 2000;
        t.mock.method(Date, 'now', () => afterTtl);
        assert.equal(markerCategory(await get('/places/markers')), '面馆, 连锁店');
        const manifest = await get(`${tiles}/manifest`);
        assert.notEqual(manifest.version, oldManifest.version);
        const dictionary = await get(`${tiles}/${manifest.dict}/dict`);
        assert.ok(dictionary.tags.includes(CHAIN_TAG));
        const [coordinates, hash] = Object.entries(manifest.tiles[12])[0];
        const leaf = await get(`${tiles}/${hash}/12/${coordinates}`);
        assert.equal(leaf.rows[0][leaf.fields.indexOf('category')], '面馆, 连锁店');
    } finally { await server.close(); }
});

test('profile hashes preserve exact pre-change categories on untagged places', () => {
    const { inputFor, inputHash } = require('../../modules/ratings/services/modelProfiles');
    const { markdownToPlainText } = require('../../modules/places/services/markdownText');
    const { clip } = require('../../modules/ratings/services/modelEmbeddings');
    const select = sql.prepare('SELECT id, name, category, description, per_person_cost FROM Place WHERE id = ?');
    for (const category of [' 面馆，  快餐厅, 面馆 ', '非连锁店,连锁店铺', '', null]) {
        const id = place('无标签样本', { category });
        const original = select.get(id);
        const legacyInput = { place: { ...original, description: clip(markdownToPlainText(original.description || ''), 400) }, reviews: [] };
        const input = inputFor(id);
        assert.deepEqual(input, legacyInput);
        assert.equal(inputHash(input), inputHash(legacyInput));
    }
});

test('rating features, grouping, profile input/hash and numeric wire input exclude the tag', async (t) => {
    const normal = place('评分地点', { category: '面馆, 快餐' });
    const empty = place('原本无分类', { category: null });
    const { inputFor, inputHash, syncProfile } = require('../../modules/ratings/services/modelProfiles');
    const { axes } = require('../../modules/ratings/services/bootstrapFeatures');
    const { buildFullFeatures } = require('../../modules/ratings/services/fullModelFeatures');
    const { placeDetailCompleteness } = require('../../modules/places/services/placeQuality');
    const { insertCreationRating } = require('../../modules/ratings/services/placeRatings');
    const numeric = require('../../infrastructure/numericAlgorithmClient');
    const model = { method: 'research_full_nonchain', model_id: 'chain-tag-test', model_hash: 'a'.repeat(64) };
    const contract = { categories: ['面馆', '快餐', CHAIN_TAG], profiles: {
        ds: { properties: ['sample listing property'] }, rv: { properties: ['sample review property'] }
    } };
    const groups = [];
    const weightsInputs = [];
    t.mock.method(numeric, 'capabilities', async () => model);
    t.mock.method(numeric, 'compute', async (operation, input) => {
        if (operation === 'modelcontract') return { feature_contract: contract };
        if (operation === 'vectormean') return { sum: null, count: 0 };
        if (operation === 'ratingquality') {
            groups.push(input.place_groups);
            return { qualities: [] };
        }
        assert.equal(operation, 'ratingestimate');
        return { estimates: [] };
    });
    t.mock.method(numeric, 'computeRatingWeights', async ({ places }) => {
        weightsInputs.push(places.map(({ id, category }) => ({ id, category })));
        return { reputations: [], rating_weights: [] };
    });
    for (const id of [normal, empty]) insertCreationRating(id, 'owner', 4, now, 'creation_explicit');
    const ids = [normal, empty];
    const sample = ids.map(row);
    const ratings = ids.map((id) => ({ place_id: id, user_id: 'owner', score: 4, created_at: now }));
    const full = (places) => {
        const builder = buildFullFeatures({ places, ratings, asOf: now, contract });
        return ids.map((id) => builder.featureFor(id));
    };
    const beforeHash = ids.map((id) => inputHash(inputFor(id)));
    process.env.RATING_ESTIMATE_MODE = 'active';
    try {
        const estimates = require('../../modules/ratings/services/ratingEstimateAdapter');
        const reputation = require('../../modules/ratings/services/ratingReputationAdapter');
        await estimates.ratingViews(ids);
        await reputation.refreshRatingWeights(now);
        await round(allChain, { config: { mode: 'apply', minConfidence: 0.8 } });
        await estimates.ratingViews(ids);
        await reputation.refreshRatingWeights(now);
    } finally { process.env.RATING_ESTIMATE_MODE = 'off'; }
    const tagged = ids.map(row);
    assert.deepEqual(full(tagged), full(sample));
    assert.deepEqual(tagged.map(axes), sample.map(axes));
    assert.deepEqual(tagged.map(placeDetailCompleteness), sample.map(placeDetailCompleteness));
    assert.deepEqual(ids.map((id) => inputHash(inputFor(id))), beforeHash);
    assert.deepEqual(groups.map((items) => items.map(({ group_id }) => group_id)), [['面馆', null], ['面馆', null]]);
    assert.ok(weightsInputs[1].every(({ category }) => !hasChainTag(category)));
    const promptInputs = [];
    for (const id of ids) await assert.rejects(syncProfile(id, model, contract, { database: sql, now, complete: async ({ user }) => {
        promptInputs.push(JSON.parse(user).category);
        throw new Error('Stop after capturing the fake prompt');
    } }), /Stop after capturing/);
    assert.deepEqual(promptInputs, ['面馆, 快餐', null]);
});

test('report is read-only, exports escaped CSV and requires an explicit classification database', async () => {
    const quoted = place('标题, "店名"');
    const manual = place('手工标注', { category: CHAIN_TAG });
    const locked = place('锁定', { category: CHAIN_TAG });
    const applied = place('已经贴过');
    setCategory(locked, '餐厅');
    await classifyPlaces([{ id: applied }], { database: sql, complete: allChain, now });
    assert.equal(applyPendingTags({ database: sql }), 1);
    await round(async () => ({ results: [chainResult(quoted), chainResult(locked),
        chainResult(manual, { verdict: 'independent', brand: '', scope: null })] }));
    const output = path.join(temp, 'chain.csv');
    const script = require.resolve('../../scripts/places/chain_tag_report');
    const child = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const revision = clock();
    const valid = child('--out', output);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /chain：3/);
    assert.match(valid.stdout, /会打：1/);
    assert.match(valid.stdout, /已打：1/);
    assert.match(valid.stdout, /已锁定：1/);
    assert.match(valid.stdout, /人工标了但模型判为非 chain：1/);
    const csv = fs.readFileSync(output, 'utf8');
    assert.match(csv, /^place_id,name,city,category,verdict,brand,scope,confidence,source,tag_applied,suppressed,has_tag_now/);
    assert.ok(csv.includes(`${quoted},"标题, ""店名""",,面馆,chain`));
    assert.equal(clock(), revision);
    const unsafe = child('--classify');
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /--classify.*--db/);

    const firstPending = place('补判断一');
    const secondPending = place('补判断二');
    const preload = path.join(temp, 'fake-report-model.js');
    fs.writeFileSync(preload, `const ai = require(${JSON.stringify(require.resolve('../../infrastructure/aiClients'))});
        ai.hasDeepseekConfiguration = () => true;
        ai.completeDeepseekJson = async ({ user }) => process.env.CHAIN_REPORT_FIXTURE_FAIL ? {} : ({ results: JSON.parse(user).map(({ id }) => ({
            id, verdict: 'not_food', brand: '', scope: null, confidence: 1 })) });`);
    const classified = spawnSync(process.execPath, ['--require', preload, script, '--db', file, '--classify', '--limit', '1'],
        { encoding: 'utf8' });
    assert.equal(classified.status, 0, classified.stderr);
    assert.equal(check(firstPending).verdict, 'not_food');
    assert.equal(check(secondPending), undefined);
    const failed = spawnSync(process.execPath, ['--require', preload, script, '--db', file, '--classify'],
        { encoding: 'utf8', env: { ...process.env, CHAIN_REPORT_FIXTURE_FAIL: '1' }, timeout: 3000 });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /批次请求失败/);
    assert.equal(check(secondPending), undefined);
});
