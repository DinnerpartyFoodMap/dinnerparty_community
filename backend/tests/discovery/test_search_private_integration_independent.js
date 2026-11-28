'use strict';

// Independent integration test for the public backend. It starts a local fake
// computation service on a random port, uses an isolated temporary SQLite file,
// and injects the review / embedding functions through the normal module seams.

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { test, beforeEach, afterEach, after } = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-search-private-independent-'));
Object.assign(process.env, {
    DB_FILE: path.join(directory, 'test.sqlite'),
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    DEEPSEEK_API_KEY: '',
    SILICONFLOW_API_KEY: '',
    SEARCH_PROFILE_WORKER: 'false',
    JWT_SECRET: 'independent-private-integration-test-secret-0123456789abcdef',
    AI_SEARCH_RATE_LIMIT: '500'
});
delete process.env.NUMERIC_ALGORITHM_SERVICE_URL;
delete process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN;
delete process.env.JOURNEY_ALGORITHM_SERVICE_URL;
delete process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;

require.cache[require.resolve('../../infrastructure/redis')] = {
    exports: { isReady: () => false }
};

const ai = require('../../infrastructure/aiClients');
const client = require('../../infrastructure/numericAlgorithmClient');
const { db, init, isVectorSearchAvailable } = require('../../infrastructure/database');
const profiles = require('../../modules/discovery/services/searchProfiles');
const ratingSummaryAdapter = require('../../modules/ratings/services/ratingSummaryAdapter');
const express = require('express');
const searchRoutes = require('../../modules/discovery/routes/search');
const jwt = require('jsonwebtoken');

init();
const database = db._raw;
const VERSION = 5;
const FIELD_NAMES = ['food', 'meals', 'scenes', 'features'];
const WORDS = Object.fromEntries(FIELD_NAMES.map((field) => [field, []]));
const EMPTY_FACTS = {
    ...WORDS,
    dishes: [],
    evidence: {},
    cost_mentioned: null,
    closed: false
};
const bootstrapModel = {
    status: 'ready',
    method: 'research_bootstrap',
    model_id: 'fixture-model',
    model_hash: 'a'.repeat(64)
};

function emptyPlan(extra = {}) {
    return {
        core: [], soft: [], must_not: [], exclude_tags: [], keywords: [],
        min_cost: null, max_cost: null, ...extra
    };
}

function doneProfile(id) {
    return {
        id,
        status: 'done',
        facts: { ...EMPTY_FACTS, evidence: {} },
        inferred: { ...WORDS },
        closed: false
    };
}

function invalidProfile(id) {
    return { id, status: 'invalid', facts: null, inferred: null, closed: false };
}

function profileReply(places, mapper = (place) => doneProfile(place?.id ?? place)) {
    return {
        profile_version: VERSION,
        model: 'fixture-model',
        results: places.map(mapper)
    };
}

function rankCandidate(id, extra = {}) {
    return {
        id,
        evidence_norm: 1,
        retrieval_norm: 1,
        factual_core: true,
        matched: { core: [], soft: [], keywords: [] },
        review_cost: null,
        ...extra
    };
}

function rankReply(places, candidates, vector = { wanted: false, max: 2 }, counts) {
    return {
        candidates,
        vector,
        counts: counts ?? {
            pool: places.length,
            eligible: places.length,
            with_evidence: candidates.length
        }
    };
}

function capabilitiesResult(version = VERSION) {
    return { search: { profile_version: version }, bootstrap_model: bootstrapModel };
}

function errorResult(status, code) {
    return { __error: { status, code, message: 'fixture failure' } };
}

function rawResult(status, body, contentType = 'application/json') {
    return { __raw: { status, body, contentType } };
}

function writeResult(res, result) {
    if (result === 'disconnect') {
        res.destroy();
        return;
    }
    if (result && result.__raw) {
        const { status, body, contentType } = result.__raw;
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(body);
        return;
    }
    if (result && result.__error) {
        const { status, code, message } = result.__error;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ protocol_version: 1, error: { code, message } }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol_version: 1, result }));
}

async function serve(t, handler, token = 'fixture-' + randomUUID()) {
    const received = [];
    const errors = [];
    const server = http.createServer(async (req, res) => {
        try {
            const auth = req.headers.authorization || '';
            if (!/^Bearer .+/.test(auth)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ protocol_version: 1, error: { code: 'unauthorized' } }));
                return;
            }
            const suppliedToken = auth.slice('Bearer '.length);
            if (req.method === 'GET' && req.url === '/v1/capabilities') {
                writeResult(res, await handler('capabilities', null, { token: suppliedToken }));
                return;
            }
            const match = /^\/v1\/compute\/([a-z]+)$/.exec(req.url || '');
            if (!match) {
                res.writeHead(404);
                res.end();
                return;
            }
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const envelope = JSON.parse(raw);
            assert.equal(typeof envelope.request_id, 'string');
            assert.equal(envelope.input.contract_version, undefined);
            received.push({ op: match[1], input: envelope.input, request_id: envelope.request_id, token: suppliedToken });
            writeResult(res, await handler(match[1], envelope.input, { token: suppliedToken }));
        } catch (error) {
            errors.push(error);
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('fixture failure');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        assert.deepEqual(errors, []);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        token,
        received,
        errors
    };
}

async function useService(t, handlers = {}, options = {}) {
    const service = await serve(t, async (operation, input, context) => {
        if (operation === 'capabilities') {
            if (handlers.capabilities) return handlers.capabilities(input, context);
            return capabilitiesResult(options.profileVersion ?? VERSION);
        }
        if (handlers[operation]) return handlers[operation](input, context);
        if (operation === 'searchcompile') {
            return { profile_version: options.profileVersion ?? VERSION, plan: emptyPlan() };
        }
        if (operation === 'searchorder') return { order: input.items.map(({ id }) => id) };
        throw new Error('unexpected operation ' + operation);
    }, options.token);
    const token = options.token || service.token;
    Object.assign(process.env, {
        JOURNEY_ALGORITHM_SERVICE_URL: service.url,
        JOURNEY_ALGORITHM_SERVICE_TOKEN: token
    });
    return { ...service, token };
}

async function startApi(t) {
    const app = express();
    app.use(express.json());
    app.use('/api', searchRoutes);
    const server = await new Promise((resolve, reject) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
        started.on('error', reject);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function aiSearch(base, body, token) {
    const response = await fetch(`${base}/api/places/search/ai`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
}

function createTestUser() {
    const id = randomUUID();
    database.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)')
        .run(id, '测试住民', 'unused');
    return jwt.sign({ id }, process.env.JWT_SECRET);
}

function addPlace(name, {
    category = '测试分类',
    description = '测试描述',
    status = 'visible',
    perPersonCost = null
} = {}) {
    return Number(database.prepare(`INSERT INTO Place
        (name, category, description, latitude, longitude, moderation_status, per_person_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(name, category, description, 23.1291, 113.2644, status, perPersonCost).lastInsertRowid);
}

function currentHash(id) {
    const place = database.prepare('SELECT * FROM Place WHERE id = ?').get(id);
    return profiles.searchProfileInputHash(profiles.profileInput(place));
}

function storeArchive(id, overrides = {}) {
    const place = database.prepare('SELECT * FROM Place WHERE id = ?').get(id);
    const hash = profiles.searchProfileInputHash(profiles.profileInput(place));
    const facts = overrides.facts === undefined
        ? { ...EMPTY_FACTS, food: ['旧资料'], evidence: { 旧资料: '旧档案' } }
        : overrides.facts;
    const inferred = overrides.inferred === undefined ? { ...WORDS, food: ['旧推断'] } : overrides.inferred;
    database.prepare(`INSERT INTO PlaceSearchProfile
        (place_id, input_hash, profile_version, status, attempts, next_retry_at,
         attempt_hash, attempt_version, facts, inferred, closed, model, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
            id,
            overrides.input_hash ?? hash,
            overrides.profile_version ?? VERSION,
            overrides.status ?? 'done',
            overrides.attempts ?? 2,
            overrides.next_retry_at ?? null,
            overrides.attempt_hash ?? null,
            overrides.attempt_version ?? null,
            facts === null ? null : JSON.stringify(facts),
            inferred === null ? null : JSON.stringify(inferred),
            overrides.closed ?? 0,
            overrides.model ?? 'old-model',
            overrides.updated_at ?? 0
        );
}

function getProfile(id) {
    return database.prepare('SELECT * FROM PlaceSearchProfile WHERE place_id = ?').get(id);
}

function placeSnapshot() {
    return database.prepare(`SELECT id, name, category, description, latitude, longitude,
        moderation_status, per_person_cost FROM Place ORDER BY id`).all();
}

beforeEach(() => database.exec('BEGIN'));
afterEach(() => database.exec('ROLLBACK'));
after(() => {
    try {
        db.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('numericAlgorithmClient forwards the four operations and accepts their successful results', async (t) => {
    const service = await useService(t, {
        searchprofile: ({ places }) => profileReply(places),
        searchcompile: ({ tags }) => ({
            profile_version: VERSION,
            plan: emptyPlan({ exclude_tags: tags.slice(0, 1) })
        }),
        searchrank: ({ places }) => rankReply(places, places.map(({ id }) => rankCandidate(id))),
        searchorder: ({ items }) => ({ order: items.map(({ id }) => id) })
    });
    const places = [
        { id: 1, name: '甲', category: '测试分类', description: '甲描述' },
        { id: 2, name: '乙', category: '测试分类', description: '乙描述' }
    ];
    const profile = await client.compute('searchprofile', { places });
    assert.equal(profile.profile_version, VERSION);
    assert.equal(profile.results.length, 2);

    const compile = await client.compute('searchcompile', { query: '找店', tags: ['测试分类'] });
    assert.deepEqual(compile.plan.exclude_tags, ['测试分类']);

    const rank = await client.compute('searchrank', {
        plan: emptyPlan(), center_given: false, places: [{ id: 1 }, { id: 2 }]
    });
    assert.deepEqual(rank.counts, { pool: 2, eligible: 2, with_evidence: 2 });
    assert.deepEqual(new Set(rank.candidates.map(({ id }) => id)), new Set([1, 2]));

    const order = await client.compute('searchorder', {
        items: [
            { id: 2, evidence_norm: 0.1, proximity_score: 0.1, confidence: 0.1 },
            { id: 1, evidence_norm: 0.2, proximity_score: 0.2, confidence: 0.2 }
        ]
    });
    assert.deepEqual(order.order, [2, 1]);

    await assert.rejects(client.compute('not-an-operation', {}), { status: 400, code: 'invalid_input' });
    assert.equal(service.received.length, 4);
    assert.ok(service.received.every(({ token }) => token === process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN));
});

test('numericAlgorithmClient rejects malformed results instead of trusting them', async (t) => {
    let reply = null;
    await useService(t, {
        searchprofile: () => reply,
        searchcompile: () => reply,
        searchrank: () => reply,
        searchorder: () => reply
    });
    const profileInput = { places: [{ id: 1 }, { id: 2 }] };
    const compileInput = { query: '找店', tags: ['甲'] };
    const rankInput = {
        plan: emptyPlan(), center_given: false, places: [{ id: 1 }, { id: 2 }]
    };
    const orderInput = {
        items: [
            { id: 1, evidence_norm: 0.5, proximity_score: 0.5, confidence: 0.5 },
            { id: 2, evidence_norm: 0.5, proximity_score: 0.5, confidence: 0.5 }
        ]
    };
    const profileBase = profileReply([{ id: 1 }, { id: 2 }]);
    const rankBase = rankReply([{ id: 1 }, { id: 2 }], [rankCandidate(1), rankCandidate(2)]);
    const closedMismatch = doneProfile(1);
    closedMismatch.closed = true;
    const invalidWithFacts = { id: 1, status: 'invalid', facts: EMPTY_FACTS, inferred: WORDS, closed: false };
    const noEvidence = doneProfile(1);
    delete noEvidence.facts.evidence;
    const cases = [
        ['profile duplicate id', 'searchprofile', profileInput,
            { ...profileBase, results: [doneProfile(1), doneProfile(1)] }],
        ['profile unknown id', 'searchprofile', profileInput,
            { ...profileBase, results: [doneProfile(1), doneProfile(99)] }],
        ['profile missing id', 'searchprofile', profileInput,
            { ...profileBase, results: [doneProfile(1)] }],
        ['profile invalid carries facts', 'searchprofile', profileInput,
            { ...profileBase, results: [invalidWithFacts, doneProfile(2)] }],
        ['profile closed mismatch', 'searchprofile', profileInput,
            { ...profileBase, results: [closedMismatch, doneProfile(2)] }],
        ['profile without evidence', 'searchprofile', profileInput,
            { ...profileBase, results: [noEvidence, doneProfile(2)] }],
        ['profile version zero', 'searchprofile', profileInput, { ...profileBase, profile_version: 0 }],
        ['profile empty model', 'searchprofile', profileInput, { ...profileBase, model: '' }],
        ['compile foreign exclude tag', 'searchcompile', compileInput,
            { profile_version: VERSION, plan: emptyPlan({ exclude_tags: ['外部标签'] }) }],
        ['compile inverted costs', 'searchcompile', compileInput,
            { profile_version: VERSION, plan: emptyPlan({ min_cost: 10, max_cost: 5 }) }],
        ['compile empty core group', 'searchcompile', compileInput,
            { profile_version: VERSION, plan: emptyPlan({ core: [[]] }) }],
        ['compile core is not an array', 'searchcompile', compileInput,
            { profile_version: VERSION, plan: { ...emptyPlan(), core: 'x' } }],
        ['rank duplicate candidate', 'searchrank', rankInput,
            rankReply(rankInput.places, [rankCandidate(1), rankCandidate(1)])],
        ['rank foreign candidate', 'searchrank', rankInput,
            rankReply(rankInput.places, [rankCandidate(1), rankCandidate(99)])],
        ['rank wrong pool count', 'searchrank', rankInput,
            { ...rankBase, counts: { pool: 9, eligible: 2, with_evidence: 2 } }],
        ['rank candidates exceed evidence count', 'searchrank', rankInput,
            { ...rankBase, counts: { pool: 2, eligible: 2, with_evidence: 0 } }],
        ['rank wanted without eligible ids', 'searchrank', rankInput,
            { ...rankBase, vector: { wanted: true, max: 2 } }],
        ['rank candidate outside eligible ids', 'searchrank', rankInput,
            { ...rankBase, candidates: [rankCandidate(1)], vector: { wanted: true, max: 2, eligible_ids: [2] },
                counts: { pool: 2, eligible: 1, with_evidence: 1 } }],
        ['rank evidence out of range', 'searchrank', rankInput,
            rankReply(rankInput.places, [rankCandidate(1, { evidence_norm: 2 }), rankCandidate(2)])],
        ['rank retrieval out of range', 'searchrank', rankInput,
            rankReply(rankInput.places, [rankCandidate(1, { retrieval_norm: -0.1 }), rankCandidate(2)])],
        ['rank missing matched', 'searchrank', rankInput,
            rankReply(rankInput.places, [{ ...rankCandidate(1), matched: undefined }, rankCandidate(2)])],
        ['order missing id', 'searchorder', orderInput, { order: [1] }],
        ['order duplicate id', 'searchorder', orderInput, { order: [1, 1] }],
        ['order extra id', 'searchorder', orderInput, { order: [1, 2, 3] }],
        ['order is not an array', 'searchorder', orderInput, { order: {} }]
    ];
    for (const [label, operation, input, result] of cases) {
        reply = result;
        await assert.rejects(client.compute(operation, input), (error) => {
            assert.equal(error.status, 502, label);
            assert.equal(error.code, 'invalid_response', label);
            return true;
        });
    }
});

test('numericAlgorithmClient distinguishes service errors and malformed envelopes', async (t) => {
    let mode = 'truncated';
    await useService(t, {
        searchprofile: () => {
            switch (mode) {
            case 'truncated': return errorResult(502, 'model_output_truncated');
            case 'rate': return errorResult(429, 'rate_limited');
            case 'upstream': return errorResult(503, 'upstream_unavailable');
            case 'other': return errorResult(500, 'unexpected');
            case 'disconnect': return 'disconnect';
            default: return rawResult(200, '{broken');
            }
        }
    });
    const call = () => client.compute('searchprofile', { places: [{ id: 1 }] });
    await assert.rejects(call, { status: 502, code: 'model_output_truncated' });
    mode = 'rate';
    await assert.rejects(call, { status: 429, code: 'rate_limited' });
    mode = 'upstream';
    await assert.rejects(call, { status: 503, code: 'upstream_unavailable' });
    mode = 'other';
    await assert.rejects(call, (error) => error.status === 503);
    mode = 'disconnect';
    await assert.rejects(call, (error) => error.status === 503);
    mode = 'invalid';
    await assert.rejects(call, { status: 502, code: 'invalid_response' });
});

test('searchCapabilities validates the profile version while capabilities keeps its old contract', async (t) => {
    const service = await useService(t, {
        capabilities: (_input, { token }) => {
            switch (token) {
            case 'valid': return capabilitiesResult(7);
            case 'zero': return capabilitiesResult(0);
            case 'float': return capabilitiesResult(1.5);
            case 'string': return capabilitiesResult('7');
            case 'missing': return { bootstrap_model: bootstrapModel };
            case 'protocol': return rawResult(200, JSON.stringify({
                protocol_version: 2, result: capabilitiesResult(7)
            }));
            case 'http': return errorResult(503, 'unavailable');
            case 'nonjson': return rawResult(200, 'not json', 'text/plain');
            case 'badbootstrap': return {
                ...capabilitiesResult(7),
                bootstrap_model: { ...bootstrapModel, status: 'pending' }
            };
            default: return capabilitiesResult(9);
            }
        }
    });
    const ask = async (token) => {
        process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN = token;
        return client.searchCapabilities();
    };
    assert.deepEqual(await ask('valid'), { profile_version: 7 });
    for (const token of ['zero', 'float', 'string', 'missing', 'protocol', 'http', 'nonjson']) {
        assert.equal(await ask(token), null, token);
    }
    process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN = 'bootstrap';
    assert.deepEqual(await client.capabilities(), bootstrapModel);
    process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN = 'badbootstrap';
    assert.equal(await client.capabilities(), null);

    const saved = process.env.JOURNEY_ALGORITHM_SERVICE_URL;
    delete process.env.JOURNEY_ALGORITHM_SERVICE_URL;
    assert.equal(await client.searchCapabilities(), null);
    assert.equal(await client.capabilities(), null);
    process.env.JOURNEY_ALGORITHM_SERVICE_URL = saved || service.url;
});

test('profile input hashes use plain text content and the table exposes profile_version', () => {
    const columns = database.prepare('PRAGMA table_info(PlaceSearchProfile)').all().map(({ name }) => name);
    assert.ok(columns.includes('profile_version'));

    const formatted = {
        id: 7,
        name: '测试店',
        category: '测试分类',
        description: '**招牌**  测试\n\n第二段'
    };
    const plain = profiles.plainSearchDescription(formatted.description);
    assert.ok(!plain.includes('*'));
    assert.ok(!/\s{2}/.test(plain));
    const normalized = profiles.profileInput(formatted);
    assert.deepEqual(Object.keys(normalized).sort(), ['category', 'description', 'id', 'name']);
    assert.equal(normalized.description, plain);
    const expected = createHash('sha256')
        .update(JSON.stringify([normalized.name, normalized.category, normalized.description]))
        .digest('hex');
    assert.equal(profiles.searchProfileInputHash(normalized), expected);
    assert.equal(profiles.searchProfileInputHash({
        name: normalized.name, category: normalized.category, description: normalized.description
    }), expected);
    assert.equal(profiles.searchProfileInputHash(profiles.profileInput({
        ...formatted, description: '**招牌** 测试 第二段'
    })), expected);
    for (const changed of [
        { ...normalized, name: '另一家' },
        { ...normalized, category: '其他' },
        { ...normalized, description: '招牌 测试 第三段' }
    ]) {
        assert.notEqual(profiles.searchProfileInputHash(changed), expected);
    }
});

test('profile rounds skip without capabilities and leave every row untouched', async (t) => {
    const id = addPlace('待抽取');
    const before = placeSnapshot();
    let calls = 0;
    for (const caps of [
        () => errorResult(503, 'unavailable'),
        () => capabilitiesResult(0)
    ]) {
        await useService(t, {
            capabilities: caps,
            searchprofile: () => {
                calls++;
                return profileReply([{ id }]);
            }
        });
        const result = await profiles.runSearchProfileRound({ database, now: 1 });
        assert.equal(result.requestStatus, 'skipped');
        assert.equal(result.selected, 0);
    }
    assert.equal(calls, 0);
    assert.equal(database.prepare('SELECT COUNT(*) FROM PlaceSearchProfile').pluck().get(), 0);
    assert.deepEqual(placeSnapshot(), before);
});

test('profile rounds extract missing, changed and old-version profiles for public places only', async (t) => {
    const noArchive = addPlace('无档案');
    const unchanged = addPlace('没有变化');
    const changed = addPlace('改动之前');
    const oldVersion = addPlace('旧版本');
    const hidden = addPlace('不公开', { status: 'pending' });
    const backedOff = addPlace('退避中');
    storeArchive(unchanged, { attempts: 2 });
    const oldHash = profiles.searchProfileInputHash({
        name: '改动之前', category: '测试分类', description: '测试描述'
    });
    storeArchive(changed, {
        input_hash: oldHash, attempts: 2, next_retry_at: 999999,
        attempt_hash: oldHash, attempt_version: VERSION
    });
    database.prepare('UPDATE Place SET name = ? WHERE id = ?').run('改动之后', changed);
    storeArchive(oldVersion, {
        profile_version: VERSION - 1, attempts: 2, next_retry_at: 999999,
        attempt_hash: currentHash(oldVersion), attempt_version: VERSION - 1
    });
    storeArchive(backedOff, {
        status: 'error', facts: null, inferred: null, attempts: 1,
        next_retry_at: 2000, attempt_hash: currentHash(backedOff), attempt_version: VERSION
    });
    const unchangedBefore = getProfile(unchanged);
    const backedOffBefore = getProfile(backedOff);
    const placeBefore = placeSnapshot();
    const batches = [];
    await useService(t, {
        searchprofile: ({ places }) => {
            batches.push(places.map(({ id }) => id));
            return profileReply(places);
        }
    });
    const result = await profiles.runSearchProfileRound({ database, now: 1000 });
    assert.equal(result.requestStatus, 'ok');
    assert.equal(result.selected, 3);
    assert.equal(result.done, 3);
    assert.equal(batches.length, 1);
    assert.deepEqual(new Set(batches[0]), new Set([noArchive, changed, oldVersion]));
    for (const id of [noArchive, changed, oldVersion]) {
        const row = getProfile(id);
        assert.equal(row.status, 'done');
        assert.equal(row.attempts, 1);
        assert.equal(row.profile_version, VERSION);
        assert.equal(row.input_hash, currentHash(id));
    }
    assert.deepEqual(getProfile(unchanged), unchangedBefore);
    assert.deepEqual(getProfile(backedOff), backedOffBefore);
    assert.equal(getProfile(hidden), undefined);
    assert.deepEqual(placeSnapshot(), placeBefore);
});

test('profile rounds split truncated batches, process ten at a time, and record single failures', async (t) => {
    const ids = Array.from({ length: 10 }, (_, index) => addPlace('拆分 ' + index));
    let mode = 'split';
    const batches = [];
    await useService(t, {
        searchprofile: ({ places }) => {
            batches.push(places.map(({ id }) => id));
            if (mode === 'done') return profileReply(places);
            if (places.length > 1) return errorResult(502, 'model_output_truncated');
            if (places[0].id === ids[0]) return errorResult(502, 'model_output_truncated');
            if (places[0].id === ids[1]) {
                return { ...profileReply(places), results: [invalidProfile(ids[1])] };
            }
            return profileReply(places);
        }
    });
    const first = await profiles.runSearchProfileRound({ database, now: 0 });
    assert.equal(first.selected, 10);
    assert.equal(first.done, 8);
    assert.equal(first.error, 2);
    assert.equal(Math.max(...batches.map(({ length }) => length)), 10);
    assert.ok(batches.every(({ length }) => length <= 10));
    assert.ok(batches.some(({ length }) => length === 5));
    assert.ok(batches.filter(({ length }) => length === 1).length >= 2);
    for (const id of [ids[0], ids[1]]) {
        const row = getProfile(id);
        assert.equal(row.status, 'error');
        assert.equal(row.attempts, 1);
        assert.equal(row.next_retry_at, 60_000);
    }

    for (let index = 0; index < 12; index++) addPlace('批次 ' + index);
    mode = 'done';
    batches.length = 0;
    const second = await profiles.runSearchProfileRound({ database, now: 2000 });
    assert.equal(second.selected, 10);
    assert.deepEqual(batches.map(({ length }) => length), [10]);
    const third = await profiles.runSearchProfileRound({ database, now: 2000 });
    assert.equal(third.selected, 2);
    assert.deepEqual(batches.map(({ length }) => length), [10, 2]);
});

test('profile failures back off and stop after three attempts', async (t) => {
    const id = addPlace('总是失败');
    let calls = 0;
    await useService(t, {
        searchprofile: ({ places }) => {
            calls++;
            return { ...profileReply(places), results: [invalidProfile(places[0].id)] };
        }
    });
    const rounds = [];
    for (const now of [0, 59_999, 60_000, 659_999, 660_000, 9_999_999]) {
        rounds.push(await profiles.runSearchProfileRound({ database, now }));
    }
    assert.equal(rounds[0].selected, 1);
    assert.equal(rounds[0].error, 1);
    assert.equal(rounds[1].selected, 0);
    assert.equal(rounds[2].selected, 1);
    assert.equal(rounds[3].selected, 0);
    assert.equal(rounds[4].selected, 1);
    assert.equal(rounds[5].selected, 0);
    assert.equal(calls, 3);
    const row = getProfile(id);
    assert.equal(row.status, 'error');
    assert.equal(row.attempts, 3);
    assert.equal(row.next_retry_at, null);
});

test('profile failures preserve the old archive and only touch status, attempts and retry time', async (t) => {
    const id = addPlace('旧档案店');
    storeArchive(id, {
        facts: { ...EMPTY_FACTS, food: ['旧资料'], evidence: { 旧资料: '旧档案' } },
        inferred: { ...WORDS, food: ['旧推断'] },
        closed: 1,
        profile_version: VERSION,
        attempts: 2,
        model: 'old-model'
    });
    const before = getProfile(id);
    database.prepare('UPDATE Place SET name = ? WHERE id = ?').run('改名后的店', id);
    await useService(t, {
        searchprofile: ({ places }) => ({
            ...profileReply(places), results: [invalidProfile(id)]
        })
    });
    const result = await profiles.runSearchProfileRound({ database, now: 1000 });
    assert.equal(result.selected, 1);
    assert.equal(result.error, 1);
    const after = getProfile(id);
    for (const field of ['facts', 'inferred', 'closed', 'profile_version', 'model', 'input_hash']) {
        assert.equal(after[field], before[field], field);
    }
    assert.equal(after.status, 'error');
    assert.equal(after.attempts, 1);
    assert.equal(after.next_retry_at, 61_000);
    assert.equal(after.attempt_hash, currentHash(id));
    assert.equal(after.attempt_version, VERSION);
});

test('the AI search endpoint omits private diagnostics and returns the public filter shape', async (t) => {
    addPlace('甲店');
    addPlace('乙店');
    let compiledTags = [];
    let rankedPlaces = [];
    await useService(t, {
        searchcompile: ({ tags }) => {
            compiledTags = tags;
            return {
                profile_version: VERSION,
                plan: emptyPlan({
                    core: [['测试条件']],
                    exclude_tags: tags.includes('测试分类') ? ['测试分类'] : [],
                    min_cost: 10,
                    max_cost: 50
                })
            };
        },
        searchrank: ({ places }) => {
            rankedPlaces = places;
            return rankReply(places, places.map(({ id }) => rankCandidate(id)));
        },
        searchorder: ({ items }) => ({ order: items.map(({ id }) => id) })
    });
    t.mock.method(ai, 'reviewRecommendationRelevance', async (_query, batch) =>
        batch.map(() => ({ relevant: true, confidence: 0.8, evidence: '' })));
    t.mock.method(ratingSummaryAdapter, 'ensureRatingSummaries', async () => {});
    const token = createTestUser();
    const base = await startApi(t);
    const response = await aiSearch(base, { q: '找一家测试店', limit: 5, includeDiagnostics: true }, token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'ok');
    assert.ok(!('conditions' in response.body));
    assert.deepEqual(response.body.filter, {
        tags: [],
        exclude_tags: compiledTags.includes('测试分类') ? ['测试分类'] : [],
        min_cost: 10,
        max_cost: 50
    });
    assert.ok(response.body.recommendations.length > 0);
    assert.ok(response.body.recommendations.every((card) => !('matched' in card)));
    assert.ok(response.body.recommendations.every((card) => card.reason_source === 'template'));
    assert.ok(compiledTags.includes('测试分类'));
    assert.deepEqual(new Set(rankedPlaces.map(({ id }) => id)), new Set(response.body.matches.map(({ place }) => place.id)));
    const unauthorized = await aiSearch(base, { q: '找一家测试店' });
    assert.equal(unauthorized.status, 401);
});

test('the AI search endpoint answers 503 when compilation or ranking fails', async (t) => {
    addPlace('故障店');
    let failAt = null;
    await useService(t, {
        searchcompile: () => failAt === 'compile'
            ? errorResult(503, 'upstream_unavailable')
            : { profile_version: VERSION, plan: emptyPlan() },
        searchrank: ({ places }) => failAt === 'rank'
            ? errorResult(503, 'upstream_unavailable')
            : rankReply(places, []),
        searchorder: ({ items }) => ({ order: items.map(({ id }) => id) })
    });
    t.mock.method(ratingSummaryAdapter, 'ensureRatingSummaries', async () => {});
    t.mock.method(ai, 'reviewRecommendationRelevance', async () => []);
    const token = createTestUser();
    const base = await startApi(t);
    for (const at of ['compile', 'rank']) {
        failAt = at;
        const response = await aiSearch(base, { q: '找店' }, token);
        assert.equal(response.status, 503, at);
        assert.equal(response.body.status, 'unavailable');
        assert.deepEqual(response.body.recommendations, []);
        assert.deepEqual(response.body.filter, {
            tags: [], exclude_tags: [], min_cost: null, max_cost: null
        });
    }
});

test('searchorder failure does not fail the search and falls back to confidence then evidence', async (t) => {
    const ids = Array.from({ length: 4 }, (_, index) => addPlace('排序 ' + index));
    const evidence = new Map([[ids[0], 1], [ids[1], 0.2], [ids[2], 0.9], [ids[3], 0.5]]);
    const confidence = new Map([[ids[0], 0.6], [ids[1], 0.9], [ids[2], 0.9], [ids[3], 0.7]]);
    let orderMode = 'fail';
    let lastOrderInput = [];
    await useService(t, {
        searchcompile: () => ({ profile_version: VERSION, plan: emptyPlan() }),
        searchrank: ({ places }) => rankReply(places, places.map(({ id }) => rankCandidate(id, {
            evidence_norm: evidence.get(id)
        }))),
        searchorder: ({ items }) => {
            lastOrderInput = items.map(({ id }) => id);
            if (orderMode === 'fail') return errorResult(503, 'upstream_unavailable');
            return { order: [...lastOrderInput].reverse() };
        }
    });
    t.mock.method(ai, 'reviewRecommendationRelevance', async (_query, batch) =>
        batch.map(({ place }) => ({ relevant: true, confidence: confidence.get(place.id), evidence: '' })));
    t.mock.method(ratingSummaryAdapter, 'ensureRatingSummaries', async () => {});
    const token = createTestUser();
    const base = await startApi(t);
    const failed = await aiSearch(base, { q: '找店', limit: 5 }, token);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, 'ok');
    assert.deepEqual(failed.body.recommendations.map(({ place }) => place.id), [ids[2], ids[1], ids[3]]);
    orderMode = 'reverse';
    const reversed = await aiSearch(base, { q: '找店', limit: 5 }, token);
    assert.equal(reversed.status, 200);
    assert.deepEqual(reversed.body.recommendations.map(({ place }) => place.id),
        [...lastOrderInput].reverse().slice(0, 3));
});

test('vector fallback uses only eligible ids and respects the service-provided cap', async (t) => {
    if (!isVectorSearchAvailable()) return t.skip('sqlite-vec is unavailable');
    const structured = addPlace('结构化候选');
    const eligible = [addPlace('向量一'), addPlace('向量二'), addPlace('向量三')];
    const ineligible = addPlace('不可兜底');
    const vector = Array.from({ length: ai.EMBEDDING_DIMENSIONS }, (_, index) => Number(index === 0));
    const blob = Buffer.from(new Float32Array(vector).buffer);
    const insert = database.prepare('INSERT INTO place_vectors (place_id, embedding) VALUES (?, ?)');
    for (const id of [...eligible, ineligible]) insert.run(BigInt(id), blob);
    await useService(t, {
        searchcompile: () => ({ profile_version: VERSION, plan: emptyPlan() }),
        searchrank: ({ places }) => rankReply(
            places,
            [rankCandidate(structured)],
            { wanted: true, max: 2, eligible_ids: [structured, ...eligible] },
            { pool: places.length, eligible: 4, with_evidence: 1 }
        ),
        searchorder: ({ items }) => ({ order: items.map(({ id }) => id) })
    });
    t.mock.method(ai, 'hasEmbeddingConfiguration', () => true);
    t.mock.method(ai, 'createEmbedding', async () => vector);
    t.mock.method(ai, 'reviewRecommendationRelevance', async (_query, batch) =>
        batch.map(() => ({ relevant: true, confidence: 0.8, evidence: '' })));
    t.mock.method(ratingSummaryAdapter, 'ensureRatingSummaries', async () => {});
    const token = createTestUser();
    const base = await startApi(t);
    const response = await aiSearch(base, { q: '找店', limit: 10 }, token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const recommendations = response.body.recommendations;
    assert.equal(recommendations[0].place.id, structured);
    assert.equal(recommendations[0].source, 'structured');
    const vectorIds = recommendations.slice(1).map(({ place }) => place.id);
    assert.ok(vectorIds.every((id) => eligible.includes(id)));
    assert.ok(!vectorIds.includes(ineligible));
    assert.ok(vectorIds.length <= 2);
    assert.ok(recommendations.slice(1).every(({ source }) => source === 'vector'));
    assert.equal(response.body.matches.filter(({ source }) => source === 'vector').length, 2);
});

test('review batches run in parallel and partial failures keep only fact-layer candidates', async (t) => {
    const ids = Array.from({ length: 16 }, (_, index) => addPlace('审核 ' + index));
    const evidence = new Map(ids.map((id, index) => [id, 1 - index * 0.01]));
    await useService(t, {
        searchcompile: () => ({ profile_version: VERSION, plan: emptyPlan() }),
        searchrank: () => rankReply(
            ids.map((id) => ({ id })),
            ids.map((id, index) => rankCandidate(id, {
                evidence_norm: evidence.get(id),
                retrieval_norm: 1 - index * 0.01,
                factual_core: index === 6 || index === 7
            }))
        ),
        searchorder: ({ items }) => ({ order: items.map(({ id }) => id) })
    });
    const batchSizes = [];
    let active = 0;
    let maxActive = 0;
    t.mock.method(ai, 'reviewRecommendationRelevance', async (_query, batch) => {
        batchSizes.push(batch.length);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        if (batch[0].place.id === ids[0]) throw new Error('fixture review failed');
        return batch.map(() => ({ relevant: true, confidence: 0.8, evidence: '' }));
    });
    t.mock.method(ratingSummaryAdapter, 'ensureRatingSummaries', async () => {});
    const token = createTestUser();
    const base = await startApi(t);
    const response = await aiSearch(base, { q: '找店', limit: 10 }, token);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'partial');
    assert.deepEqual(response.body.recommendations.map(({ place }) => place.id), [ids[6], ids[7], ids[8]]);
    assert.deepEqual(response.body.recommendations.map(({ review_source }) => review_source),
        ['local_fallback', 'local_fallback', 'deepseek']);
    assert.deepEqual(batchSizes.sort((left, right) => left - right), [8, 8]);
    assert.equal(maxActive, 2);
});
