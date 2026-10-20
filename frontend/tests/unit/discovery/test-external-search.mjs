import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalSearchController, searchExternalPlaces, unmarkedExternalPlaces } from '../../../src/discovery/externalSearch.js';

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('typing, resetting and repeated clicks do not automatically repeat external requests', async () => {
    const pending = defer(); let calls = 0; let state;
    const controller = createExternalSearchController(() => { calls++; return pending.promise; }, value => { state = value; });
    controller.setContext('陶陶居', 0);
    assert.equal(calls, 0);
    const a = controller.search({ center: { lng: 113, lat: 23 } });
    const b = controller.search({ center: { lng: 113, lat: 23 } });
    assert.equal(calls, 1);
    pending.resolve([{ id: 'one' }]);
    await Promise.all([a, b]);
    assert.equal(state.loaded, true);
    assert.deepEqual(state.results, [{ id: 'one' }]);
    await controller.search({});
    assert.equal(calls, 1, 'already-displayed results are retained without a second request');
    controller.setContext('陶陶居', 0);
    assert.equal(state.loaded, true);
    controller.setContext('陶陶居', 1);
    assert.equal(state.loaded, false);
    assert.equal(calls, 1);
});

test('out-of-order results and failures never overwrite a newer query or closed search', async () => {
    const old = defer(), current = defer(); let state;
    const controller = createExternalSearchController(({ q }) => q === '旧店' ? old.promise : current.promise, next => { state = next; });
    controller.setContext('旧店', 0); const a = controller.search({});
    controller.setContext('新店', 0); const b = controller.search({});
    old.resolve([{ id: 'wrong' }]); await a;
    assert.equal(state.query, '新店'); assert.equal(state.loading, true);
    current.resolve([]); await b;
    assert.equal(state.loaded, true); assert.equal(state.error, '');
    controller.setContext('', 0); await controller.search({});
    assert.equal(state.loaded, false); assert.deepEqual(state.results, []);
    controller.dispose();
});

test('failure is visible, can be explicitly retried, and never becomes a successful empty result', async () => {
    let calls = 0, state;
    const controller = createExternalSearchController(async () => {
        if (++calls === 1) throw new Error('今日外部地点搜索已达上限');
        return [];
    }, next => { state = next; });
    controller.setContext('新店', 0); await controller.search({});
    assert.equal(state.loaded, false); assert.match(state.error, /上限/); assert.equal(state.loading, false);
    await controller.search({}); assert.equal(state.loaded, true); assert.equal(state.error, '');
});

test('external HTTP requests coalesce only while in flight, with area and source preserved', async () => {
    const previous = globalThis.fetch; const pending = defer(); const requests = [];
    globalThis.fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); await pending.promise; return new Response(JSON.stringify({ places: [] })); };
    try {
        const args = { q: ' 陶陶居 ', center: { lng: 113, lat: 23 }, source: 'map_manual' };
        const a = searchExternalPlaces('http://local', args), b = searchExternalPlaces('http://local', args);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.q, '陶陶居');
        assert.deepEqual(requests[0].body.center, { lng: 113, lat: 23 });
        assert.equal(requests[0].body.source, 'map_manual');
        pending.resolve(); await Promise.all([a, b]);
        await searchExternalPlaces('http://local', args);
        assert.equal(requests.length, 2, 'no durable result cache');
    } finally { globalThis.fetch = previous; }
});

test('a synchronous request failure also allows an explicit retry', async () => {
    let calls = 0, state;
    const controller = createExternalSearchController(() => {
        if (++calls === 1) throw new Error('Unavailable');
        return Promise.resolve([]);
    }, next => { state = next; });
    controller.setContext('新店', 0);
    await controller.search({});
    assert.equal(state.loading, false);
    await controller.search({});
    assert.equal(calls, 2);
    assert.equal(state.loaded, true);
});

test('adjacent different businesses and distant same-name branches remain visible', () => {
    const known = [{ name: '同名店（东门）', longitude: 113, latitude: 23 }];
    const pois = [
        { id: 'duplicate', name: '同名店(东门)', longitude: 113.00001, latitude: 23 },
        { id: 'neighbor', name: '隔壁面馆', longitude: 113.00001, latitude: 23 },
        { id: 'branch', name: '同名店（东门）', longitude: 113.1, latitude: 23 }
    ];
    const result = unmarkedExternalPlaces(pois, known, { lng: 113, lat: 23 });
    assert.deepEqual(result.map(p => p.id), ['amap_neighbor', 'amap_branch']);
    assert.equal(result[0].isMarked, false); assert.equal(result[0].showOnMap, false);
    assert.ok(result[0].dist < 50);
});
