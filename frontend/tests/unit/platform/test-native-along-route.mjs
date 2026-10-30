import assert from 'node:assert/strict';
import {
    pickNativeAlongRouteValues,
    createNativeAlongRouteSession
} from '../../../src/platform/nativeAlongRoute.js';
import {
    alongRouteModeOptions,
    alongRouteDistanceOptions,
    alongRouteRoutesState,
    alongRoutePlacesState,
    formatAlongRouteTrip
} from '../../../src/discovery/alongRouteController.js';

class FakePlugin {
    constructor() {
        this.listeners = new Map();
        this.responded = [];
        this.closed = [];
        this.snapshot = null;
        this.openResolve = null;
        this.openReject = null;
    }

    async addListener(name, callback) {
        this.listeners.set(name, callback);
        return { remove: () => this.listeners.delete(name) };
    }

    open(snapshot) {
        this.snapshot = snapshot;
        return new Promise((resolve, reject) => {
            this.openResolve = resolve;
            this.openReject = reject;
        });
    }

    async respond(payload) { this.responded.push(payload); }
    async close(payload) { this.closed.push(payload); }
    emit(name, data) { this.listeners.get(name)?.(data); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 条件白名单：非法 URL 整条丢弃；出行方式、距离与标签都截到上限
{
    assert.equal(pickNativeAlongRouteValues({ url: 'not-a-url' }), null);
    assert.equal(pickNativeAlongRouteValues(null), null);
    const values = pickNativeAlongRouteValues({
        url: ' https://surl.amap.com/demo ',
        mode: 'teleport',
        query: '  火锅  ',
        categories: ['小吃', '  ', 3, 'x'.repeat(40)],
        corridorMeters: 1234
    });
    assert.deepEqual(values, {
        url: 'https://surl.amap.com/demo',
        mode: 'driving',
        query: '火锅',
        categories: ['小吃', 'x'.repeat(24)],
        corridorMeters: 1000
    });
    assert.equal(pickNativeAlongRouteValues({ url: 'https://a', corridorMeters: 3000 }).corridorMeters, 3000);
    assert.equal(pickNativeAlongRouteValues({ url: 'https://a', mode: 'walking' }).mode, 'walking');
}

// 网页格式化好的结果：路线摘要、地点说明
{
    const modes = alongRouteModeOptions();
    assert.equal(modes.length, 4);
    assert.equal(modes[0].id, 'driving');
    assert.ok(modes.every((mode) => mode.label.length > 0));
    assert.deepEqual(alongRouteDistanceOptions().map((item) => item.value), [500, 1000, 2000, 3000]);

    const routes = alongRouteRoutesState([
        { index: 0, distance: 1500, duration: 600 },
        { index: 1, distance: 300, duration: 0 }
    ], null);
    assert.equal(routes.routes.length, 2);
    assert.equal(routes.routes[0].title, '方案 1');
    assert.ok(routes.routes[0].detail.includes('公里'));
    assert.ok(routes.routes[0].detail.includes('分钟'));
    assert.equal(routes.routes[1].detail, '300 米');
    assert.ok(routes.routesTitle.includes('2'));

    const places = alongRoutePlacesState(0, [{
        id: 7,
        name: '小面馆',
        category: '小吃',
        per_person_cost: 30,
        distance_to_route: 120,
        route_matches: [{ route_index: 0, distance_to_route: 80 }]
    }]);
    assert.equal(places.places[0].id, '7');
    assert.equal(places.places[0].name, '小面馆');
    assert.ok(places.places[0].meta.includes('小吃'));
    assert.ok(places.places[0].meta.includes('120'));
    assert.ok(places.places[0].matches.includes('方案 1'));
    assert.equal(places.emptyText, '');
    assert.ok(alongRoutePlacesState(0, []).emptyText.length > 0);

    const trip = formatAlongRouteTrip({
        origin: { name: 'A' },
        destination: { name: 'B' },
        waypoints: [{}, {}]
    });
    assert.ok(trip.includes('A → B'));
    assert.ok(trip.includes('2'));
}

// 会话：只处理本次 id 的事件；submit / chooseRoute 经 respond 回传；select 结果交给网页打开地点
{
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeAlongRouteSession(plugin, { labels: {} }, {
        onSubmit: async (values) => {
            calls.push(['submit', values]);
            return { ok: true, state: { routes: [] } };
        },
        onChooseRoute: async (index, values) => {
            calls.push(['choose', index, values]);
            return { ok: true, state: { places: [] } };
        },
        onSelectPlace: (placeId) => calls.push(['place', placeId]),
        onClose: () => calls.push(['close']),
        onError: (error) => calls.push(['error', error.message])
    });
    const started = session.start();
    await tick();

    // 旧 id 不处理
    plugin.emit('alongRouteEvent', { id: 'other', type: 'submit', requestId: 'r0', values: { url: 'https://x' } });
    // 非法条件不回复
    plugin.emit('alongRouteEvent', { id: session.id, type: 'submit', requestId: 'r0', values: { url: 'ftp://x' } });
    plugin.emit('alongRouteEvent', {
        id: session.id, type: 'submit', requestId: 'r1',
        values: { url: 'https://surl.amap.com/demo', mode: 'walking', query: '面', categories: ['小吃'], corridorMeters: 2000 }
    });
    await tick();
    assert.equal(calls[0][0], 'submit');
    assert.deepEqual(calls[0][1], {
        url: 'https://surl.amap.com/demo',
        mode: 'walking',
        query: '面',
        categories: ['小吃'],
        corridorMeters: 2000
    });
    assert.deepEqual(plugin.responded[0], {
        id: session.id, requestId: 'r1', ok: true, message: '', state: { routes: [] }
    });

    plugin.emit('alongRouteEvent', {
        id: session.id, type: 'chooseRoute', requestId: 'r2',
        values: { url: 'https://surl.amap.com/demo', index: 1, categories: [], corridorMeters: 500 }
    });
    await tick();
    assert.equal(calls[1][0], 'choose');
    assert.equal(calls[1][1], 1);
    assert.deepEqual(calls[1][2].categories, []);
    assert.equal(calls[1][2].corridorMeters, 500);
    assert.equal(plugin.responded[1].requestId, 'r2');

    plugin.openResolve({ id: session.id, action: 'select', values: { placeId: 'p1' } });
    await started;
    assert.deepEqual(calls.at(-1), ['place', 'p1']);
    assert.equal(plugin.listeners.size, 0);
}

// 关闭：stop 调用插件 close，且不再处理后续事件
{
    const plugin = new FakePlugin();
    const session = createNativeAlongRouteSession(plugin, {}, {
        onSubmit: async () => ({ ok: true }),
        onClose: () => {},
        onError: () => {}
    });
    const started = session.start();
    await tick();
    await session.stop();
    assert.deepEqual(plugin.closed, [{ id: session.id }]);
    plugin.emit('alongRouteEvent', { id: session.id, type: 'submit', requestId: 'r1', values: { url: 'https://a' } });
    await tick();
    assert.equal(plugin.responded.length, 0);
    plugin.openResolve({ id: session.id, action: 'close' });
    await started;
}

// 打开失败交给 onError
{
    const plugin = new FakePlugin();
    let failed = null;
    const session = createNativeAlongRouteSession(plugin, {}, {
        onSubmit: async () => ({ ok: true }),
        onClose: () => {},
        onError: (error) => { failed = error; }
    });
    const started = session.start();
    await tick();
    plugin.openReject(new Error('UNAVAILABLE'));
    await started;
    assert.equal(failed?.message, 'UNAVAILABLE');
}

console.log('Native along-route session tests passed.');
