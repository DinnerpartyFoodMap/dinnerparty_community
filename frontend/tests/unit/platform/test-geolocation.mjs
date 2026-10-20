// 网页端定位流程：先返回最先拿到的（粗略）位置，再用持续定位提高精度；npm run test:platform
import assert from 'node:assert/strict';
import { locateWithBrowser, LOCATION_ERROR } from '../../../src/platform/geolocation.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const permitted = () => Promise.resolve();
// 伦敦在高德中国范围外，坐标不做 GCJ-02 转换，便于直接比较
const fix = (accuracy, lng = -0.12, lat = 51.5) => ({ coords: { longitude: lng, latitude: lat, accuracy }, timestamp: 1 });
const ipFix = { lng: -0.1, lat: 51.4, accuracy: null, coordSystem: 'GCJ-02', source: 'ip' };

function fakeGeolocation() {
    let nextId = 1;
    const fake = {
        coarse: [],
        watches: new Map(),
        cleared: [],
        getCurrentPosition(ok, err, options) { fake.coarse.push({ ok, err, options }); },
        watchPosition(ok, err, options) {
            const id = nextId++;
            fake.watches.set(id, { ok, err, options });
            return id;
        },
        clearWatch(id) {
            fake.cleared.push(id);
            fake.watches.delete(id);
        },
        coarseResult(position) { fake.coarse.shift()?.ok(position); },
        coarseError(code) { fake.coarse.shift()?.err({ code, message: `error ${code}` }); },
        watchResult(position) { for (const watch of fake.watches.values()) watch.ok(position); },
        watchError(code) { for (const watch of fake.watches.values()) watch.err({ code, message: `error ${code}` }); }
    };
    return fake;
}

// 粗略位置先返回，之后明显更准的结果才回调；达到 20 米时停止持续定位
{
    const geolocation = fakeGeolocation();
    const updates = [];
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, ipLocate: async () => assert.fail('IP not needed'), onUpdate: (p) => updates.push(p.accuracy) });
    assert.deepEqual(geolocation.coarse[0].options, { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 });
    assert.deepEqual([...geolocation.watches.values()][0].options, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    geolocation.coarseResult(fix(150));
    const first = await pending;
    assert.equal(first.accuracy, 150);
    assert.equal(first.source, 'browser');
    geolocation.watchResult(fix(140));   // 不到 20% 的改进不回调
    geolocation.watchResult(fix(60));
    geolocation.watchResult(fix(15));
    assert.deepEqual(updates, [60, 15]);
    assert.equal(geolocation.cleared.length, 1, 'watch stops once accuracy reaches 20 m');
    geolocation.watchResult(fix(5));
    assert.deepEqual(updates, [60, 15], 'nothing is reported after stopping');
}

// 不传 onUpdate：返回第一个结果后立即停止
{
    const geolocation = fakeGeolocation();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted });
    geolocation.watchResult(fix(80));
    assert.equal((await pending).accuracy, 80);
    assert.equal(geolocation.cleared.length, 1);
}

// 浏览器坐标为 WGS-84，在中国范围内转换为 GCJ-02 并保留原始坐标
{
    const geolocation = fakeGeolocation();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted });
    geolocation.coarseResult(fix(30, 116.397, 39.908));
    const position = await pending;
    assert.equal(position.coordSystem, 'GCJ-02');
    assert.deepEqual(position.raw, { lng: 116.397, lat: 39.908, coordSystem: 'WGS-84' });
    assert.ok(Math.abs(position.lng - 116.397) > 1e-4, 'Beijing is shifted to GCJ-02');
}

// 拒绝授权：立即失败，不拿 IP 位置顶替
{
    const geolocation = fakeGeolocation();
    let ipCalls = 0;
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, ipDelay: 10, ipLocate: async () => { ipCalls += 1; return ipFix; } });
    geolocation.coarseError(1);
    await assert.rejects(pending, { code: LOCATION_ERROR.PERMISSION_DENIED });
    await sleep(30);
    assert.equal(ipCalls, 0);
    assert.equal(geolocation.cleared.length, 1);
}

// 浏览器迟迟没有结果：IP 定位先给粗略位置，之后浏览器结果作为更新
{
    const geolocation = fakeGeolocation();
    const updates = [];
    const position = await locateWithBrowser({ geolocation, whenPermitted: permitted, timeout: 100, ipDelay: 10, ipLocate: async () => ipFix, onUpdate: (p) => updates.push(p) });
    assert.equal(position.source, 'ip');
    geolocation.watchResult(fix(500));
    assert.equal(updates.length, 1, 'any browser fix beats an IP fix');
    assert.equal(updates[0].accuracy, 500);
}

// 授权弹窗还没答复时不开始 IP 兜底倒计时
{
    const geolocation = fakeGeolocation();
    let answer;
    const prompt = new Promise((resolve) => { answer = resolve; });
    let ipCalls = 0;
    const pending = locateWithBrowser({ geolocation, whenPermitted: () => prompt, ipDelay: 10, ipLocate: async () => { ipCalls += 1; return ipFix; } });
    await sleep(40);
    assert.equal(ipCalls, 0, 'no IP fallback while the permission prompt is open');
    answer();
    assert.equal((await pending).source, 'ip');
    assert.equal(ipCalls, 1);
}

// 一直没有结果、IP 也失败：到期报超时
{
    const geolocation = fakeGeolocation();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, timeout: 60, ipDelay: 10, ipLocate: async () => { throw new Error('ip failed'); } });
    await assert.rejects(pending, { code: LOCATION_ERROR.TIMEOUT });
    assert.equal(geolocation.cleared.length, 1);
}

// 浏览器两路都报“无法定位”、IP 也失败：不等到期，直接报无法定位
{
    const geolocation = fakeGeolocation();
    const started = Date.now();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, timeout: 5000, ipLocate: async () => { throw new Error('ip failed'); } });
    geolocation.coarseError(2);
    geolocation.watchError(2);
    await assert.rejects(pending, { code: LOCATION_ERROR.POSITION_UNAVAILABLE });
    assert.ok(Date.now() - started < 1000);
}

// 浏览器报错但持续定位之后恢复：仍然返回位置
{
    const geolocation = fakeGeolocation();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, ipLocate: async () => { throw new Error('ip failed'); } });
    geolocation.coarseError(3);
    await sleep(5);
    geolocation.watchResult(fix(40));
    assert.equal((await pending).accuracy, 40);
}

// 没有浏览器定位接口：只用 IP 定位
{
    assert.equal((await locateWithBrowser({ geolocation: null, whenPermitted: permitted, ipLocate: async () => ipFix })).source, 'ip');
    await assert.rejects(locateWithBrowser({ geolocation: null, whenPermitted: permitted }), { code: LOCATION_ERROR.POSITION_UNAVAILABLE });
}

// 取消：首个结果之前取消则失败为 ABORTED；之后取消则停止更新
{
    const geolocation = fakeGeolocation();
    const controller = new AbortController();
    const pending = locateWithBrowser({ geolocation, whenPermitted: permitted, signal: controller.signal, onUpdate: () => {} });
    controller.abort();
    await assert.rejects(pending, { code: LOCATION_ERROR.ABORTED });
    assert.equal(geolocation.cleared.length, 1);

    const again = fakeGeolocation();
    const later = new AbortController();
    const updates = [];
    const first = locateWithBrowser({ geolocation: again, whenPermitted: permitted, signal: later.signal, onUpdate: (p) => updates.push(p) });
    again.coarseResult(fix(200));
    await first;
    const [watch] = again.watches.values();
    later.abort();
    watch.ok(fix(10));
    assert.deepEqual(updates, []);
    assert.equal(again.cleared.length, 1);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(locateWithBrowser({ geolocation: fakeGeolocation(), whenPermitted: permitted, signal: aborted.signal }), { code: LOCATION_ERROR.ABORTED });
}

console.log('geolocation tests passed');
