'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { test, after, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-structured-search-'));
Object.assign(process.env, {
    DB_FILE: path.join(directory, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false',
    DEEPSEEK_API_KEY: '', SILICONFLOW_API_KEY: '', SEARCH_PROFILE_WORKER: 'true'
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const ai = require('../../infrastructure/aiClients');
const client = require('../../infrastructure/numericAlgorithmClient');
const { db, init, isVectorSearchAvailable } = require('../../infrastructure/database');
const profiles = require('../../modules/discovery/services/searchProfiles');
const { searchSemanticPlaces } = require('../../modules/discovery/services/semanticSearch');
const center = { lat: 23.1291, lng: 113.2644 };
const vector = Array.from({ length: ai.EMBEDDING_DIMENSIONS }, (_, i) => Number(i === 0));
const vectorBlob = Buffer.from(new Float32Array(vector).buffer);
const VERSION = 2;
const plan = (extra = {}) => ({
    core: [], soft: [], must_not: [], exclude_tags: [], keywords: [], min_cost: null, max_cost: null, ...extra
});
const words = { food: [], meals: [], scenes: [], features: [] };
const facts = { ...words, dishes: [], evidence: {}, cost_mentioned: null, closed: false };
const done = (id) => ({ id, status: 'done', facts, inferred: words, closed: false });
const invalid = (id) => ({ id, status: 'invalid', facts: null, inferred: null, closed: false });
const profileReply = (places) => ({ profile_version: VERSION, model: 'fixture', results: places.map(({ id }) => done(id)) });
const rankRow = (id, extra = {}) => ({
    id, evidence_norm: 1, retrieval_norm: 1, factual_core: true, matched: { core: [], soft: [], keywords: [] },
    review_cost: null, ...extra
});
const rankReply = (places, candidates, eligibleIds, max = 8) => ({
    candidates, vector: { wanted: !!eligibleIds, max, ...(eligibleIds && { eligible_ids: eligibleIds }) },
    counts: { pool: places.length, eligible: eligibleIds?.length ?? places.length, with_evidence: candidates.length }
});
const errorReply = (status, code) => ({ status, error: { code } });
const truncated = () => errorReply(502, 'model_output_truncated');
const unavailable = () => errorReply(503, 'upstream_unavailable');
const rateLimited = () => errorReply(429, 'rate_limited');
const accept = async (_query, batch) => batch.map(() => ({ relevant: true, confidence: 0.8, evidence: '' }));
const search = (options = {}) => searchSemanticPlaces('找家店', {
    center, prepareRatings: async () => {}, review: accept,
    embed: async () => { throw new Error('unexpected embedding'); }, ...options
});

init();
const database = db._raw;
beforeEach(() => database.exec('BEGIN'));
afterEach(() => database.exec('ROLLBACK'));
after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function add(name, { category = '其他', description = '', lat = center.lat, status = 'visible' } = {}) {
    return Number(database.prepare(`INSERT INTO Place (name, category, description, latitude, longitude, moderation_status)
        VALUES (?, ?, ?, ?, ?, ?)`).run(name, category, description, lat, center.lng, status).lastInsertRowid);
}

function storeProfile(id, { hash, version = 1 } = {}) {
    const place = database.prepare('SELECT * FROM Place WHERE id = ?').get(id);
    database.prepare(`INSERT INTO PlaceSearchProfile
        (place_id, input_hash, profile_version, status, attempts, facts, inferred, closed, model, updated_at)
        VALUES (?, ?, ?, 'done', 3, ?, ?, 1, 'old-model', 0)`)
        .run(id, hash ?? profiles.searchProfileInputHash(profiles.profileInput(place)), version,
            JSON.stringify({ ...facts, closed: true }), JSON.stringify(words));
}

const getProfile = (id) => database.prepare('SELECT * FROM PlaceSearchProfile WHERE place_id = ?').get(id);

async function serve(t, handler) {
    const fixtureErrors = [];
    const server = http.createServer(async (req, res) => {
        try {
            assert.equal(req.headers.authorization, 'Bearer fixture');
            let result;
            if (req.url === '/v1/capabilities') result = await handler('capabilities');
            else {
                assert.match(req.url, /^\/v1\/compute\/[a-z]+$/);
                let raw = '';
                for await (const chunk of req) raw += chunk;
                const { request_id, input } = JSON.parse(raw);
                assert.equal(typeof request_id, 'string');
                assert.equal(input.contract_version, undefined, 'search uses the search contract');
                result = await handler(req.url.split('/').at(-1), input);
            }
            if (result === 'disconnect') return req.socket.destroy();
            res.writeHead(result?.error ? result.status : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result?.error ? { protocol_version: 1, error: result.error } : { protocol_version: 1, result }));
        } catch (error) {
            fixtureErrors.push(error);
            res.writeHead(500);
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        assert.deepEqual(fixtureErrors, []);
    });
    return {
        NUMERIC_ALGORITHM_SERVICE_URL: 'http://127.0.0.1:' + server.address().port,
        NUMERIC_ALGORITHM_SERVICE_TOKEN: 'fixture'
    };
}

async function useService(t, handlers) {
    const env = await serve(t, (op, input) => {
        if (handlers[op]) return handlers[op](input);
        if (op === 'capabilities') return { search: { profile_version: VERSION } };
        if (op === 'searchcompile') return { profile_version: VERSION, plan: plan() };
        if (op === 'searchorder') return { order: input.items.map(({ id }) => id) };
        throw new Error('unexpected operation ' + op);
    });
    Object.assign(process.env, env);
}

test('compile and pool preparation run concurrently; matching old profiles and plain descriptions go to rank', { timeout: 5000 }, async (t) => {
    const first = add('旧档案', { category: '本地连锁', description: '**招牌**' + '食'.repeat(700) });
    const stale = add('过期档案');
    storeProfile(first);
    storeProfile(stale);
    database.prepare("UPDATE Place SET description = '改过的介绍' WHERE id = ?").run(stale);
    add('隐藏地点', { category: '隐藏标签', status: 'checking' });
    add('远方地点', { lat: 45 });
    let prepared;
    let compileBegan;
    const waitForPrepare = new Promise((resolve) => { prepared = resolve; });
    const waitForCompile = new Promise((resolve) => { compileBegan = resolve; });
    await useService(t, {
        async searchcompile({ query, tags }) {
            compileBegan();
            await waitForPrepare;
            assert.equal(query, '找家店');
            assert.ok(tags.includes('连锁店') && !tags.includes('隐藏标签'));
            return { profile_version: VERSION, plan: plan({ core: [['测试条件']] }) };
        },
        searchrank({ center_given, places }) {
            assert.equal(center_given, true);
            assert.deepEqual(places.map(({ id }) => id), [first, stale]);
            assert.match(places[0].description, /^招牌食/);
            assert.equal(places[0].description.length, 600);
            assert.equal(places[0].profile.version, 1);
            assert.equal(places[0].profile.closed, true);
            assert.deepEqual(places[0].tags, ['连锁店']);
            assert.equal(places[0].distance_km, 0);
            assert.equal(typeof places[0].detail_completeness, 'number');
            assert.equal(places[1].profile, null);
            return rankReply(places, [rankRow(stale, { matched: { core: ['测试条件'], soft: [], keywords: [] } })]);
        }
    });
    const result = await search({ includeDiagnostics: true, prepareRatings: async () => {
        prepared();
        await waitForCompile;
    } });
    assert.deepEqual(result.conditions.core, [['测试条件']]);
    assert.deepEqual(result.recommendation.matched.core, ['测试条件']);
    assert.ok(!('profile_facts' in result.recommendation.place));
});

test('search without a center sends only the most recently updated 3000 visible places', async (t) => {
    const oldest = add('最早');
    database.prepare("UPDATE Place SET created_time = '2000-01-01 00:00:00' WHERE id = ?").run(oldest);
    const updated = add('后来改过');
    database.prepare("UPDATE Place SET updated_time = '2099-01-01 00:00:00' WHERE id = ?").run(updated);
    database.exec(`WITH RECURSIVE inserts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM inserts WHERE n<3000)
        INSERT INTO Place(name, moderation_status, created_time) SELECT '地点 ' || n, 'visible', '2026-01-01 00:00:00' FROM inserts`);
    await useService(t, {
        searchrank({ center_given, places }) {
            assert.equal(center_given, false);
            assert.equal(places.length, 3000);
            assert.equal(places[0].id, updated);
            assert.ok(!places.some(({ id }) => id === oldest));
            return rankReply(places, []);
        }
    });
    assert.equal((await search({ center: null })).status, 'no_relevant_match');
});

test('vector fallback uses only service-eligible IDs, does not duplicate ranked places and caps additions', async (t) => {
    assert.ok(isVectorSearchAvailable());
    t.mock.method(ai, 'hasEmbeddingConfiguration', () => true);
    const insert = database.prepare('INSERT INTO place_vectors (place_id, embedding) VALUES (?, ?)');
    const addVector = (name) => {
        const id = add(name);
        insert.run(BigInt(id), vectorBlob);
        return id;
    };
    const excluded = addVector('禁止兜底');
    const structured = addVector('结构化候选');
    const eligible = Array.from({ length: 4 }, (_, n) => addVector('向量候选 ' + n));
    await useService(t, {
        searchrank: ({ places }) => rankReply(places, [rankRow(structured)], [structured, ...eligible], 2)
    });
    let embeds = 0;
    const result = await search({ embed: async () => { embeds++; return vector; } });
    assert.equal(embeds, 1);
    assert.deepEqual(result.matches.map(({ place, source }) => [place.id, source]), [
        [structured, 'structured'], ...eligible.slice(0, 2).map((id) => [id, 'vector'])
    ]);
    assert.ok(!result.matches.some(({ place }) => place.id === excluded));
    const degraded = await search({ embed: async () => { throw new Error('embedding offline'); } });
    assert.deepEqual(degraded.matches.map(({ place }) => place.id), [structured]);
    t.mock.method(ai, 'hasEmbeddingConfiguration', () => false);
    await search({ embed: async () => { embeds++; return vector; } });
    assert.equal(embeds, 1);
});

test('remote card ordering is used, and an invalid response falls back to confidence then evidence', async (t) => {
    const ids = Array.from({ length: 4 }, (_, n) => add('卡片 ' + n, { description: '新鲜现做' }));
    let failOrder = false;
    await useService(t, {
        searchrank({ places }) {
            return rankReply(places, ids.map((id, i) => rankRow(id, { evidence_norm: [1, 0.2, 0.9, 0.6][i] })));
        },
        searchorder({ items }) {
            assert.deepEqual(items.map(({ id }) => id), ids);
            assert.deepEqual(items.map(({ confidence }) => confidence), [0.6, 0.9, 0.9, 0.7]);
            assert.ok(items.every(({ proximity_score }) => proximity_score === 1));
            return { order: failOrder ? [999, ...ids.slice(1)] : [...ids].reverse() };
        }
    });
    const review = async (_, batch) => batch.map(({ place }) => ({
        relevant: true, confidence: [0.6, 0.9, 0.9, 0.7][ids.indexOf(place.id)],
        evidence: place.id === ids[3] ? '新鲜现做' : '编造的证据'
    }));
    const remote = await search({ review });
    assert.deepEqual(remote.recommendations.map(({ place }) => place.id), [ids[3], ids[2], ids[1]]);
    assert.match(remote.recommendation.reason, /新鲜现做/);
    assert.ok(remote.recommendations.every(({ reason }) => !reason.includes('编造的证据')));
    failOrder = true;
    assert.deepEqual((await search({ review })).recommendations.map(({ place }) => place.id), [ids[2], ids[1], ids[3]]);
});

test('reviews run in batches of eight and partial failure keeps factual core matches', { timeout: 5000 }, async (t) => {
    const ids = Array.from({ length: 16 }, (_, n) => add('审核 ' + n));
    await useService(t, {
        searchrank: ({ places }) => rankReply(places, ids.map((id, n) => rankRow(id, { factual_core: n < 10 })))
    });
    const lengths = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const result = await search({ limit: 10, review: async (_, batch) => {
        lengths.push(batch.length);
        if (lengths.length === 1) {
            await gate;
            return batch.map(() => ({ relevant: false }));
        }
        release();
        throw new Error('review failed');
    } });
    assert.deepEqual(lengths, [8, 8]);
    assert.equal(result.status, 'partial');
    assert.equal(result.matches.length, 10);
    assert.deepEqual(result.recommendations.map(({ place, review_source }) => [place.id, review_source]),
        ids.slice(8, 10).map((id) => [id, 'local_fallback']));
    assert.equal((await search({ review: async () => { throw new Error('review failed'); } })).status, 'unavailable');
});

test('HTTP omits diagnostics and returns 503 when compile or rank is unavailable', async (t) => {
    const id = add('接口地点');
    let failed;
    await useService(t, {
        searchcompile: () => failed === 'compile' ? unavailable() : { profile_version: VERSION, plan: plan() },
        searchrank: ({ places }) => failed === 'rank' ? unavailable() : rankReply(places, [rankRow(id)])
    });
    t.mock.method(ai, 'reviewRecommendationRelevance', accept);
    t.mock.method(require('../../modules/ratings/services/ratingSummaryAdapter'), 'ensureRatingSummaries', async () => {});
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../../modules/discovery/routes/search'));
    const userId = randomUUID();
    database.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(userId, '搜索住民', 'unused');
    const token = require('jsonwebtoken').sign({ id: userId }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const request = () => fetch('http://127.0.0.1:' + server.address().port + '/api/places/search/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ q: '找家店', center, includeDiagnostics: true })
    });
    for (const errorAt of [undefined, 'compile', 'rank']) {
        failed = errorAt;
        const response = await request();
        assert.equal(response.status, failed ? 503 : 200);
        const body = await response.json();
        assert.equal(body.status, failed ? 'unavailable' : 'ok');
        assert.ok(!('conditions' in body));
        assert.deepEqual(body.filter, { tags: [], exclude_tags: [], min_cost: null, max_cost: null });
        if (!failed) {
            assert.ok(!('matched' in body.recommendation));
            assert.ok(body.recommendations.every((card) => !('matched' in card)));
        }
    }
});

test('profile rounds split truncation, preserve the old archive on invalid, and back off for the attempted version', async (t) => {
    const ids = Array.from({ length: 10 }, (_, n) => add('抽取 ' + n, { description: '**店铺资料**' }));
    const old = ids[0];
    const single = ids[1];
    storeProfile(old);
    const initial = getProfile(old);
    add('不抽取的地点', { status: 'pending' });
    const clock = database.prepare('SELECT revision FROM AlgorithmClock').pluck();
    const before = clock.get();
    const calls = [];
    await useService(t, {
        searchprofile({ places }) {
            assert.equal(places[0].description, '店铺资料');
            calls.push(places.map(({ id }) => id));
            if (places.length === 10 || places.some(({ id }) => id === single)) return truncated();
            return { ...profileReply(places), results: places.map(({ id }) => id === old ? invalid(id) : done(id)) };
        },
        searchrank({ places }) {
            assert.equal(places.find(({ id }) => id === old).profile.version, 1);
            assert.equal(places.find(({ id }) => id === single).profile, null);
            return rankReply(places, []);
        }
    });
    const result = await profiles.runSearchProfileRound({ now: 1 });
    assert.equal(result.done, 8);
    assert.equal(result.error, 2);
    assert.equal(result.selected, 10);
    assert.deepEqual(calls[0], ids);
    assert.deepEqual(calls[1], ids.slice(0, 5));
    assert.ok(calls.some((batch) => batch.length === 1 && batch[0] === single));
    assert.ok(calls.some((batch) => batch.join() === ids.slice(5).join()));
    const saved = getProfile(old);
    for (const field of ['input_hash', 'profile_version', 'facts', 'inferred', 'closed', 'model']) {
        assert.equal(saved[field], initial[field], field);
    }
    assert.equal(saved.attempts, 1);
    assert.equal(saved.status, 'error');
    assert.equal(saved.next_retry_at, 60_001);
    assert.equal(getProfile(single).attempts, 1);
    assert.equal(getProfile(ids.at(-1)).profile_version, VERSION);
    assert.equal(clock.get(), before);
    await search();
    assert.equal((await profiles.runSearchProfileRound({ now: 60_000 })).selected, 0);
    assert.equal((await profiles.runSearchProfileRound({ now: 60_001 })).error, 2);
    assert.equal((await profiles.runSearchProfileRound({ now: 660_001 })).error, 2);
    assert.equal(getProfile(old).attempts, 3);
    assert.equal((await profiles.runSearchProfileRound({ now: 9_000_000 })).selected, 0);
    database.prepare("UPDATE Place SET name = '修改过的店名' WHERE id = ?").run(old);
    assert.equal((await profiles.runSearchProfileRound({ now: 9_000_001 })).error, 1);
    assert.equal(getProfile(old).attempts, 1);
});

test('missing capabilities skips the whole round; 429 and unavailable leave attempts intact', async (t) => {
    const id = add('待抽取');
    storeProfile(id);
    const saved = getProfile(id);
    let capabilities = false;
    let calls = 0;
    await useService(t, {
        capabilities: () => capabilities ? { search: { profile_version: VERSION } } : unavailable(),
        searchprofile: () => ++calls === 1 ? rateLimited() : unavailable()
    });
    assert.equal((await profiles.runSearchProfileRound()).requestStatus, 'skipped');
    assert.equal(calls, 0);
    capabilities = true;
    assert.equal((await profiles.runSearchProfileRound()).requestStatus, 'failed');
    assert.equal((await profiles.runSearchProfileRound()).requestStatus, 'failed');
    assert.equal(calls, 2);
    assert.deepEqual(getProfile(id), saved);
});

test('edited places and a concurrent round cannot be overwritten by a stale response', async (t) => {
    const changed = add('改名之前');
    const other = add('另一家');
    let calls = 0;
    await useService(t, {
        async searchprofile({ places }) {
            if (++calls === 1) {
                database.prepare('UPDATE Place SET name = ? WHERE id = ?').run('改名之后', changed);
                assert.equal((await profiles.runSearchProfileRound({ now: 2 })).done, 2);
            }
            return profileReply(places);
        }
    });
    assert.equal((await profiles.runSearchProfileRound({ now: 1 })).stale, 2);
    assert.equal(getProfile(changed).updated_at, 2);
    assert.equal(getProfile(other).updated_at, 2);
    database.prepare('DELETE FROM Place WHERE id = ?').run(other);
    assert.equal(getProfile(other), undefined);
});

test('the client rejects malformed service data and distinguishes its error codes', async (t) => {
    await useService(t, {
        searchprofile: ({ places }) => {
            switch (places[0].id) {
            case 1: return truncated();
            case 2: return rateLimited();
            case 3: return unavailable();
            default: return profileReply([{ id: 999 }]);
            }
        },
        searchcompile: () => ({ profile_version: VERSION, plan: plan({ exclude_tags: ['外部标签'] }) }),
        searchrank: ({ places }) => rankReply(places, [rankRow(1, { evidence_norm: Infinity })])
    });
    for (const [id, code] of [[1, 'model_output_truncated'], [2, 'rate_limited'], [3, 'upstream_unavailable'], [4, 'invalid_response']]) {
        await assert.rejects(client.compute('searchprofile', { places: [{ id }] }), { code });
    }
    await assert.rejects(client.compute('searchcompile', { query: '标签', tags: [] }), { code: 'invalid_response' });
    await assert.rejects(client.compute('searchrank', { places: [{ id: 1 }] }), { code: 'invalid_response' });
});

async function backfillFixture(t, respond) {
    const databaseFile = path.join(fs.mkdtempSync(path.join(directory, 'backfill-')), 'fixture.sqlite');
    const sql = new (require('better-sqlite3'))(databaseFile);
    t.after(() => sql.close());
    sql.exec(`CREATE TABLE Place (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, description TEXT,
        latitude REAL, longitude REAL, moderation_status TEXT NOT NULL DEFAULT 'visible');`);
    const insert = sql.prepare('INSERT INTO Place (name, latitude, longitude, moderation_status) VALUES (?, ?, ?, ?)');
    const calls = [];
    const config = await serve(t, async (op, input) => {
        if (op === 'capabilities') return { search: { profile_version: VERSION } };
        assert.equal(op, 'searchprofile');
        const ids = input.places.map(({ id }) => id);
        calls.push(ids);
        const outcome = await respond?.(ids);
        if (outcome === 'disconnect') return 'disconnect';
        if (outcome === 'truncated') return truncated();
        return profileReply(input.places);
    });
    const script = require.resolve('../../scripts/discovery/backfill_search_profiles');
    const run = (args, onStderr) => new Promise((resolve) => {
        const child = execFile(process.execPath, [script, '--db', databaseFile, ...args], {
            env: { ...process.env, ...config,
                LOG_TO_CONSOLE: 'true', LOG_PRETTY_CONSOLE: 'false', LOG_CONSOLE_LEVEL: 'warn' },
            timeout: 10_000
        }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
        child.stderr.on('data', (chunk) => onStderr?.(String(chunk)));
    });
    const add = (lat = 0, lng = 0, status = 'visible') => insert.run('回填测试地点', lat, lng, status).lastInsertRowid;
    const saved = () => sql.prepare('SELECT place_id FROM PlaceSearchProfile ORDER BY place_id').pluck().all();
    return { add, calls, run, saved };
}

test('backfill concurrency processes each selected ID exactly once in batches of ten', async (t) => {
    let active = 0;
    let maxActive = 0;
    let release;
    const firstWave = new Promise((resolve) => { release = resolve; });
    const fixture = await backfillFixture(t, async () => {
        maxActive = Math.max(maxActive, ++active);
        if (active === 4) release();
        await firstWave;
        active--;
    });
    const ids = Array.from({ length: 45 }, () => fixture.add());
    const result = await fixture.run(['--limit', '42']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(maxActive, 4);
    assert.deepEqual(fixture.calls.map(({ length }) => length).sort((a, b) => a - b), [2, 10, 10, 10, 10]);
    assert.deepEqual(fixture.calls.flat().sort((a, b) => a - b), ids.slice(0, 42));
    assert.deepEqual(fixture.saved(), ids.slice(0, 42));
    const invalid = await fixture.run(['--concurrency', '9']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--concurrency/);
});

test('backfill failure drains in-flight batches, stops dispatch and resumes on rerun', async (t) => {
    let fail = true;
    let release;
    const failureLogged = new Promise((resolve) => { release = resolve; });
    const fixture = await backfillFixture(t, async ([first]) => {
        if (!fail) return;
        if (first === 1) return 'disconnect';
        if (first === 11) await failureLogged;
    });
    const ids = Array.from({ length: 35 }, () => fixture.add());
    let diagnostic = '';
    const failed = await fixture.run(['--concurrency', '2'], (chunk) => {
        diagnostic += chunk;
        if (diagnostic.includes('discovery.search_profiles.request_failed')) release();
    });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /rerun to resume backfill/);
    const warning = failed.stderr.split(/\r?\n/).filter((line) => line.startsWith('{')).map(JSON.parse)
        .find(({ event }) => event === 'discovery.search_profiles.request_failed');
    assert.equal(warning.message, 'Search profile request failed');
    assert.ok(warning.code);
    assert.deepEqual(fixture.calls.map(([first]) => first).sort((a, b) => a - b), [1, 11]);
    assert.deepEqual(fixture.saved(), ids.slice(10, 20));
    fixture.calls.length = 0;
    fail = false;
    const resumed = await fixture.run(['--concurrency', '2']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(fixture.calls.flat().sort((a, b) => a - b), [...ids.slice(0, 10), ...ids.slice(20)]);
    assert.deepEqual(fixture.saved(), ids);
});

test('backfill recovers from truncation and proceeds to the next original batch', async (t) => {
    const fixture = await backfillFixture(t, (ids) => {
        if (ids.length === 10 && ids[0] === 1) return 'truncated';
    });
    const ids = Array.from({ length: 12 }, () => fixture.add());
    const result = await fixture.run(['--concurrency', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.calls, [ids.slice(0, 10), ids.slice(0, 5), ids.slice(5, 10), ids.slice(10)]);
    assert.deepEqual(fixture.saved(), ids);
});

test('backfill near selects only visible places inside the union of the given circles', async (t) => {
    const fixture = await backfillFixture(t);
    const first = fixture.add(0.08, 0);
    fixture.add(0.07, 0.07); // Inside the first circle's bounding box, outside the circle.
    fixture.add(0, 0, 'pending');
    const second = fixture.add(-10, 10);
    fixture.add(20, 20);
    const result = await fixture.run(['--near', '0,0,10', '--near', '-10,10,5']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.calls, [[first, second]]);
    assert.deepEqual(fixture.saved(), [first, second]);
});



test('the schema upgrade converts verified legacy hashes without associating stale archives with edited content', () => {
    const legacy = new (require('better-sqlite3'))(':memory:');
    try {
        legacy.exec(`CREATE TABLE Place (id INTEGER PRIMARY KEY, name TEXT, category TEXT, description TEXT);
            CREATE TABLE PlaceSearchProfile (place_id INTEGER PRIMARY KEY, input_hash TEXT NOT NULL, status TEXT,
                attempts INTEGER, next_retry_at INTEGER, facts TEXT, inferred TEXT, closed INTEGER, model TEXT, updated_at INTEGER);
            INSERT INTO Place VALUES (1, '旧档案', '其他', '**资料**'), (2, '编辑后', '其他', '资料');`);
        const legacyHash = (name) => createHash('sha256').update(JSON.stringify([name, '其他', '资料', 1, 1])).digest('hex');
        const insert = legacy.prepare("INSERT INTO PlaceSearchProfile VALUES (?, ?, 'done', 1, NULL, '{}', '{}', 1, 'old-model', 0)");
        insert.run(1, legacyHash('旧档案'));
        insert.run(2, legacyHash('编辑前'));
        const { initSearchProfileSchema } = require('../../modules/discovery/services/searchProfileSchema');
        initSearchProfileSchema(legacy);
        initSearchProfileSchema(legacy);
        const [converted, stale] = legacy.prepare('SELECT * FROM PlaceSearchProfile ORDER BY place_id').all();
        assert.equal(converted.input_hash, profiles.searchProfileInputHash({ name: '旧档案', category: '其他', description: '资料' }));
        assert.equal(converted.profile_version, 1);
        assert.equal(converted.model, 'old-model');
        assert.equal(converted.closed, 1);
        assert.equal(stale.input_hash, legacyHash('编辑前'));
        assert.equal(stale.profile_version, null);
    } finally {
        legacy.close();
    }
});

test('a failed split remains a batch failure while preserving the successful half', async (t) => {
    const ids = Array.from({ length: 10 }, (_, n) => add('半批 ' + n));
    await useService(t, {
        searchprofile({ places }) {
            if (places.length === 10) return truncated();
            if (places[0].id === ids[5]) return unavailable();
            return profileReply(places);
        }
    });
    const result = await profiles.runSearchProfileRound();
    assert.equal(result.requestStatus, 'failed');
    assert.equal(result.done, 5);
    assert.equal(result.error, 0);
    assert.ok(ids.slice(0, 5).every((id) => getProfile(id)?.status === 'done'));
    assert.ok(ids.slice(5).every((id) => getProfile(id) === undefined));
});

test('the worker uses only private service configuration and backs off failed requests even when woken', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(client, 'configuration', () => null);
    const sizes = [];
    t.mock.method(client, 'searchCapabilities', async () => ({ profile_version: VERSION }));
    t.mock.method(client, 'compute', async (op, { places }) => {
        assert.equal(op, 'searchprofile');
        sizes.push(places.length);
        if (sizes.length === 1) throw client.failure(429, 'rate_limited');
        return profileReply(places);
    });
    for (let n = 0; n < 11; n++) add('等待后台 ' + n);
    profiles.startSearchProfileWorker();
    t.mock.timers.tick(5000);
    assert.deepEqual(sizes, []);
    t.mock.method(client, 'configuration', () => ({ url: 'fixture' }));
    const stop = profiles.startSearchProfileWorker();
    try {
        t.mock.timers.tick(5000);
        await new Promise(setImmediate);
        assert.deepEqual(sizes, [10]);
        assert.equal(database.prepare('SELECT COUNT(*) FROM PlaceSearchProfile').pluck().get(), 0);
        profiles.wakeSearchProfileWorker();
        t.mock.timers.tick(59_999);
        assert.deepEqual(sizes, [10]);
        t.mock.timers.tick(1);
        await new Promise(setImmediate);
        assert.deepEqual(sizes, [10, 10]);
        t.mock.timers.tick(1500);
        await new Promise(setImmediate);
        assert.deepEqual(sizes, [10, 10, 1]);
        assert.equal(database.prepare('SELECT SUM(attempts) FROM PlaceSearchProfile').pluck().get(), 11);
    } finally {
        stop();
    }
});
