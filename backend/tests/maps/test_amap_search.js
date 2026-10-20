const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
const budgetModule = require('../../modules/maps/services/amapSearchBudget');
const serviceModule = require('../../modules/maps/services/amapSearch');
const { createAmapSearchRouter } = require('../../modules/maps/routes/amapSearch');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-search-budget-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(options = {}) {
    const sql = new Database(':memory:');
    let time = new Date('2026-10-01T00:00:00+08:00');
    const budget = budgetModule.createSearchBudget(sql, { now: () => time, ...options });
    return { sql, budget, setTime: value => { time = new Date(value); } };
}

test('monthly slots persist and are shared across database connections and sources', () => {
    const file = path.join(dir, 'shared.sqlite');
    const first = new Database(file), second = new Database(file);
    try {
        const options = { now: () => new Date('2026-10-31T12:00:00+08:00') };
        const a = budgetModule.createSearchBudget(first, options);
        const b = budgetModule.createSearchBudget(second, options);
        a.configure({ monthlyLimit: 2, dailyLimit: 10 });
        a.reserve('map_manual');
        b.reserve('journey_address');
        assert.throws(() => a.reserve('legacy_sdk'), { code: 'AMAP_SEARCH_MONTHLY_LIMIT' });
        assert.equal(b.status().monthlyUsed, 2);
        assert.deepEqual(b.status().sources, { journey_address: 1, map_manual: 1 });
        first.close();
        const reopened = new Database(file);
        assert.equal(budgetModule.createSearchBudget(reopened, options).status().monthlyUsed, 2);
        reopened.close();
    } finally { if (first.open) first.close(); second.close(); }
});

test('adaptive daily allocation, explicit zero budget, and China month boundaries', () => {
    const { budget, sql, setTime } = setup();
    try {
        budget.configure({ monthlyLimit: 62 });
        assert.equal(budget.status().todayLimit, 2);
        budget.reserve('map_manual'); budget.reserve('map_manual');
        assert.throws(() => budget.reserve('map_manual'), { code: 'AMAP_SEARCH_DAILY_LIMIT' });
        setTime('2026-10-01T16:00:00Z');
        assert.equal(budget.status().day, '2026-10-02');
        assert.equal(budget.status().todayUsed, 0);
        assert.equal(budget.status().todayLimit, 2);
        setTime('2026-10-31T16:00:00Z');
        assert.equal(budget.status().monthlyUsed, 0);
        budget.configure({ monthlyLimit: 0 });
        assert.throws(() => budget.reserve('map_manual'), { code: 'AMAP_SEARCH_MONTHLY_LIMIT' });
    } finally { sql.close(); }
});

test('runtime shutdown and reconciled prior usage apply before reservation', () => {
    const { budget, sql } = setup();
    try {
        budget.configure({ monthlyLimit: 4000, dailyLimit: 200 });
        budget.reserve('map_manual');
        budget.reconcile(3999);
        budget.reserve('journey_address');
        assert.equal(budget.status().monthlyUsed, 4000);
        budget.configure({ enabled: false });
        assert.throws(() => budget.reserve('map_manual'), { code: 'AMAP_SEARCH_DISABLED' });
        assert.throws(() => budget.configure({ monthlyLimit: -1 }));
        assert.throws(() => budget.configure({ enabled: 'false' }));
        assert.throws(() => budget.reconcile(0));
    } finally { sql.close(); }
});

test('legacy SDK search paths are budgeted but tiles and geocoding pass through', async () => {
    const { budget, sql } = setup();
    budget.configure({ enabled: false });
    const app = express();
    app.use('/_AMapService', budgetModule.createLegacySearchGuard(budget), (_req, res) => res.json({ upstream: true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const base = `http://127.0.0.1:${server.address().port}/_AMapService`;
        for (const p of ['/v3/place/around', '/v5/place/text', '/v3/assistant/inputtips', '/v3/place/detail',
            '///v3/place/text', '/v3//place/text', '/%76%33/place/text', '/v3/place/text/%invalid']) {
            const response = await fetch(base + p);
            assert.equal(response.status, 503);
            assert.equal((await response.json()).code, 'AMAP_SEARCH_DISABLED');
        }
        for (const p of ['/v3/geocode/regeo', '/v3/staticmap', '/v4/map/styles', '/tile']) {
            assert.deepEqual(await (await fetch(base + p)).json(), { upstream: true });
        }
        assert.equal(budget.status().monthlyUsed, 0);
    } finally { await new Promise(resolve => server.close(resolve)); sql.close(); }
});

test('HTTP search validates before spending, coalesces in-flight requests and sanitizes POIs', async () => {
    const { budget, sql } = setup();
    budget.configure({ monthlyLimit: 20, dailyLimit: 20 });
    let release, calls = [];
    const service = serviceModule.createAmapSearch({ budget, key: () => 'test-key', fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        await new Promise(resolve => { release = resolve; });
        return new Response(JSON.stringify({ status: '1', pois: [
            { id: 'p1', name: '测试店', location: '113.2,23.1', address: [], pname: '广东省', cityname: '广州市', adname: '越秀区', type: '餐饮服务', secret: 'not-returned' },
            { id: 'bad', name: '无坐标', location: '' }
        ] }));
    } });
    const app = express(); app.use(express.json()); app.use('/search', createAmapSearchRouter(service));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        for (const body of [{ q: '' }, { q: '店', source: 'input' }, { q: '店', source: 'map_manual', center: { lng: '', lat: 23 } }]) {
            assert.equal((await post(body)).status, 400);
        }
        assert.equal(calls.length, 0);
        const body = { q: ' 测试店 ', center: { lng: 113.2, lat: 23.1 }, source: 'map_manual' };
        const a = post(body), b = post(body);
        while (!release) await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(calls.length, 1);
        release();
        const results = await Promise.all([a, b]);
        assert.equal(results[0].headers.get('cache-control'), 'no-store');
        const data = await results[0].json();
        assert.equal(data.places.length, 1);
        assert.equal(data.places[0].longitude, 113.2);
        assert.equal(data.places[0].address, '广东省广州市越秀区');
        assert.equal('secret' in data.places[0], false);
        assert.deepEqual(await results[1].json(), data);
        assert.equal(calls[0].url.pathname, '/v3/place/around');
        assert.equal(calls[0].url.searchParams.get('keywords'), '测试店');
        assert.equal(calls[0].url.searchParams.get('offset'), '20');
        assert.equal(budget.status().monthlyUsed, 1);
        budget.configure({ enabled: false });
        assert.equal((await post(body)).status, 503);
        assert.equal(calls.length, 1);
    } finally { await new Promise(resolve => server.close(resolve)); sql.close(); }
});

test('unavailable configuration and upstream failures are not empty results or automatic retries', async () => {
    const { budget, sql } = setup(); budget.configure({ dailyLimit: 20 });
    let calls = 0;
    try {
        const missing = serviceModule.createAmapSearch({ budget, key: () => '', fetchImpl: async () => { calls++; } });
        await assert.rejects(() => missing.search({ q: '店', source: 'map_manual' }), { code: 'AMAP_SEARCH_UNAVAILABLE' });
        assert.equal(budget.status().monthlyUsed, 0);
        const failed = serviceModule.createAmapSearch({ budget, key: () => 'test', fetchImpl: async () => {
            calls++; return new Response(JSON.stringify({ status: '0', info: 'QUOTA_EXCEEDED' }));
        } });
        await assert.rejects(() => failed.search({ q: '北京', source: 'journey_address' }), { code: 'AMAP_SEARCH_UPSTREAM' });
        assert.equal(calls, 1);
        assert.equal(budget.status().monthlyUsed, 1);
    } finally { sql.close(); }
});
