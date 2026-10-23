// 网页与 iOS 渐进定位、App 权限、超时、取消；npm run test:platform
import assert from 'node:assert/strict';
import { getCurrentLocation, locateWithBrowser, locateWithWatch, LOCATION_ERROR } from '../../../src/platform/geolocation.js';

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

// iOS 持续定位（locateWithWatch）：插件回调 (position, error)，watch 返回的 id 用于 clearWatch
const freshFix = (accuracy, lng = -0.12, lat = 51.5) => ({ coords: { longitude: lng, latitude: lat, accuracy }, timestamp: Date.now() });
const pluginError = (code) => ({ code: `OS-PLUG-GLOC-${code}`, message: `native ${code}` });

function fakeWatchPlugin() {
    let nextId = 1;
    const fake = {
        callbacks: new Map(),
        cleared: [],
        watch: async (callback) => {
            const id = `watch-${nextId++}`;
            fake.callbacks.set(id, callback);
            return id;
        },
        clearWatch: async (id) => {
            fake.cleared.push(id);
            fake.callbacks.delete(id);
        },
        emit(raw, error) { for (const callback of fake.callbacks.values()) callback(raw, error); }
    };
    return fake;
}

// 首个位置立即返回，之后明显更准的结果才回调；达到 20 米时停止持续定位
{
    const plugin = fakeWatchPlugin();
    const updates = [];
    const pending = locateWithWatch({ watch: plugin.watch, clearWatch: plugin.clearWatch, onUpdate: (p) => updates.push(p.accuracy) });
    await sleep(0);
    const [callback] = plugin.callbacks.values();
    plugin.emit(freshFix(65));
    const first = await pending;
    assert.equal(first.accuracy, 65);
    assert.equal(first.source, 'native');
    assert.deepEqual(first.raw, { lng: -0.12, lat: 51.5, coordSystem: 'WGS-84' });
    plugin.emit(freshFix(60));   // 不到 20% 的改进不回调
    plugin.emit(freshFix(30));
    plugin.emit(freshFix(12));
    assert.deepEqual(updates, [30, 12]);
    await sleep(0);
    assert.deepEqual(plugin.cleared, ['watch-1'], 'watch stops once accuracy reaches 20 m');
    callback(freshFix(5));
    assert.deepEqual(updates, [30, 12], 'nothing is reported after stopping');
}

// 不传 onUpdate：返回第一个结果后立即停止；插件在返回 id 之前回调也能停掉
{
    const plugin = fakeWatchPlugin();
    const pending = locateWithWatch({
        watch: async (callback) => { callback(freshFix(80)); return plugin.watch(callback); },
        clearWatch: plugin.clearWatch
    });
    assert.equal((await pending).accuracy, 80);
    await sleep(0);
    assert.deepEqual(plugin.cleared, ['watch-1']);
}

// 系统缓存的旧位置不用，等新位置
{
    const plugin = fakeWatchPlugin();
    const pending = locateWithWatch({ watch: plugin.watch, clearWatch: plugin.clearWatch, onUpdate: () => {} });
    await sleep(0);
    plugin.emit({ ...freshFix(5, 2.35, 48.85), timestamp: Date.now() - 5 * 60 * 1000 });
    plugin.emit(freshFix(65));
    const position = await pending;
    assert.equal(position.accuracy, 65);
    assert.equal(position.lng, -0.12);
}

// 一时取不到位置：继续等；之后有位置仍然返回，一直没有则到期报无法定位
{
    const plugin = fakeWatchPlugin();
    const pending = locateWithWatch({ watch: plugin.watch, clearWatch: plugin.clearWatch });
    await sleep(0);
    plugin.emit(null, pluginError('0002'));
    plugin.emit(freshFix(40));
    assert.equal((await pending).accuracy, 40);

    const stuck = fakeWatchPlugin();
    const failing = locateWithWatch({ watch: stuck.watch, clearWatch: stuck.clearWatch, timeout: 30 });
    await sleep(0);
    stuck.emit(null, pluginError('0002'));
    await assert.rejects(failing, { code: LOCATION_ERROR.POSITION_UNAVAILABLE });
    assert.deepEqual(stuck.cleared, ['watch-1']);

    const silent = fakeWatchPlugin();
    await assert.rejects(locateWithWatch({ watch: silent.watch, clearWatch: silent.clearWatch, timeout: 30 }), { code: LOCATION_ERROR.TIMEOUT });
    assert.deepEqual(silent.cleared, ['watch-1']);
}

// 无权限、定位关闭、插件首个位置超时：立即失败并停止
for (const [code, expected] of [
    ['0003', LOCATION_ERROR.PERMISSION_DENIED],
    ['0007', LOCATION_ERROR.SERVICES_DISABLED],
    ['0008', LOCATION_ERROR.PERMISSION_DENIED],
    ['0010', LOCATION_ERROR.TIMEOUT]
]) {
    const plugin = fakeWatchPlugin();
    const pending = locateWithWatch({ watch: plugin.watch, clearWatch: plugin.clearWatch, timeout: 5000 });
    await sleep(0);
    plugin.emit(null, pluginError(code));
    await assert.rejects(pending, (error) => {
        assert.equal(error.code, expected, code);
        assert.equal(error.cause.code, `OS-PLUG-GLOC-${code}`, 'keeps the native error for diagnosis');
        return true;
    });
    await sleep(0);
    assert.deepEqual(plugin.cleared, ['watch-1']);
}

// 取消：调用后马上取消不再开始定位；之后取消则停止更新
{
    const plugin = fakeWatchPlugin();
    const controller = new AbortController();
    const pending = locateWithWatch({ watch: plugin.watch, clearWatch: plugin.clearWatch, signal: controller.signal, onUpdate: () => {} });
    controller.abort();
    await assert.rejects(pending, { code: LOCATION_ERROR.ABORTED });
    await sleep(0);
    assert.equal(plugin.callbacks.size, 0, 'no watch is started');

    const again = fakeWatchPlugin();
    const later = new AbortController();
    const updates = [];
    const first = locateWithWatch({ watch: again.watch, clearWatch: again.clearWatch, signal: later.signal, onUpdate: (p) => updates.push(p) });
    await sleep(0);
    const [callback] = again.callbacks.values();
    again.emit(freshFix(200));
    await first;
    later.abort();
    callback(freshFix(10));
    assert.deepEqual(updates, []);
    await sleep(0);
    assert.deepEqual(again.cleared, ['watch-1']);
}

// 使用真实 Capacitor JS 代理，仅替换跨设备的 nativePromise / nativeCallback 边界。
// @capacitor/core 只在首次导入时绑定 window.Capacitor，所以 Android / iOS 共用一个替身，平台由 androidBridge / webkit 决定。
{
    const originalWindow = globalThis.window;
    const originalCapacitor = globalThis.Capacitor;
    const originalBridge = globalThis.androidBridge;
    const originalWebkit = globalThis.webkit;
    const nativeError = (code, data) => Object.assign(new Error(`native ${code}`), { code, data });
    const amapFix = (accuracy, lng = 116.397, lat = 39.908, coordType = 'GCJ02') => ({ longitude: lng, latitude: lat, accuracy, coordType, locationType: 5, timestamp: 1 });
    const methods = ['checkPermissions', 'requestPermissions', 'getCurrentPosition', 'clearWatch'].map(name => ({ name, rtype: 'promise' }))
        .concat({ name: 'watchPosition', rtype: 'callback' });
    let permission = { location: 'denied', coarseLocation: 'granted' };
    let checkPermission = async () => permission;
    let requestPermission = async () => permission;
    let request = async () => assert.fail('getCurrentPosition not expected');
    let startWatch = () => assert.fail('watchPosition not expected');
    let nextWatch = 1;
    const cleared = [];
    const calls = [];
    globalThis.window = globalThis;
    globalThis.androidBridge = {};
    globalThis.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => (globalThis.androidBridge ? 'android' : 'ios'),
        PluginHeaders: [{ name: 'AMapLocation', methods }, { name: 'Geolocation', methods }],
        nativePromise: async (plugin, method, options) => {
            calls.push(`${plugin}.${method}`);
            assert.equal(plugin, globalThis.androidBridge ? 'AMapLocation' : 'Geolocation', 'each platform uses its own location plugin');
            if (method === 'checkPermissions') return checkPermission();
            if (method === 'requestPermissions') return requestPermission(options);
            if (method === 'getCurrentPosition') return request(options);
            if (method === 'clearWatch') {
                cleared.push(options.id);
                return undefined;
            }
            assert.fail(`Unexpected native method: ${method}`);
        },
        nativeCallback: (plugin, method, options, callback) => {
            calls.push(`${plugin}.${method}`);
            assert.equal(plugin, 'Geolocation', 'only the iOS plugin watches');
            assert.equal(method, 'watchPosition');
            const id = `watch-${nextWatch++}`;
            startWatch(options, callback);
            return id;
        }
    };
    try {
        // Android：高德国内结果已是 GCJ-02，不再转换；只把超时交给插件，精度由插件按已授予的权限决定
        request = async (options) => {
            assert.deepEqual(options, { timeout: 10000 });
            return amapFix(2000);
        };
        const approximate = await getCurrentLocation();
        assert.deepEqual(calls, ['AMapLocation.checkPermissions', 'AMapLocation.getCurrentPosition']);
        assert.equal(approximate.source, 'native');
        assert.equal(approximate.accuracy, 2000);
        assert.equal(approximate.lng, 116.397);
        assert.equal(approximate.converted, false);
        assert.deepEqual(approximate.raw, { lng: 116.397, lat: 39.908, coordSystem: 'GCJ-02' });

        // 高德境外返回 WGS-84：境外坐标原样使用；精度缺失时为 null
        request = async () => amapFix(undefined, -0.12, 51.5, 'WGS84');
        const overseas = await getCurrentLocation();
        assert.equal(overseas.coordSystem, 'GCJ-02');
        assert.equal(overseas.lng, -0.12);
        assert.equal(overseas.accuracy, null);
        assert.deepEqual(overseas.raw, { lng: -0.12, lat: 51.5, coordSystem: 'WGS-84' });

        // 高德失败后插件改用系统定位：国内的 WGS-84 结果要转换成 GCJ-02
        request = async () => ({ ...amapFix(8, 116.397, 39.908, 'WGS84'), provider: 'gps' });
        const fallback = await getCurrentLocation();
        assert.equal(fallback.converted, true);
        assert.ok(Math.abs(fallback.lng - 116.397) > 1e-4 && Math.abs(fallback.lat - 39.908) > 1e-4);
        assert.deepEqual(fallback.raw, { lng: 116.397, lat: 39.908, coordSystem: 'WGS-84' });

        // 插件与高德 SDK 的错误码
        for (const [code, expected] of [
            ['PERMISSION_DENIED', LOCATION_ERROR.PERMISSION_DENIED],
            ['SERVICES_DISABLED', LOCATION_ERROR.SERVICES_DISABLED],
            ['TIMEOUT', LOCATION_ERROR.TIMEOUT],
            ['AMAP_12', LOCATION_ERROR.PERMISSION_DENIED],
            ['AMAP_4', LOCATION_ERROR.TIMEOUT],
            ['AMAP_7', LOCATION_ERROR.UNKNOWN],
            ['AMAP_INIT', LOCATION_ERROR.UNKNOWN],
            ['AMAP_13', LOCATION_ERROR.POSITION_UNAVAILABLE],
            ['AMAP_20', LOCATION_ERROR.POSITION_UNAVAILABLE]
        ]) {
            request = async () => { throw nativeError(code, { amapCode: 0, detail: '#0000' }); };
            await assert.rejects(getCurrentLocation(), (error) => {
                assert.equal(error.code, expected, code);
                assert.equal(error.cause.code, code, 'keeps the native error for diagnosis');
                return true;
            });
        }
        request = async () => ({ coordType: 'GCJ02' });
        await assert.rejects(getCurrentLocation(), { code: LOCATION_ERROR.POSITION_UNAVAILABLE });

        // 两种权限都被拒绝：不向高德索取位置
        calls.length = 0;
        permission = { location: 'prompt', coarseLocation: 'prompt' };
        requestPermission = async (options) => {
            assert.deepEqual(options, { permissions: ['location', 'coarseLocation'] });
            return { location: 'denied', coarseLocation: 'denied' };
        };
        request = () => assert.fail('denied permission must not request a position');
        await assert.rejects(getCurrentLocation(), { code: LOCATION_ERROR.PERMISSION_DENIED });
        assert.deepEqual(calls, ['AMapLocation.checkPermissions', 'AMapLocation.requestPermissions']);
        permission = { location: 'granted', coarseLocation: 'granted' };

        // 原生无回调：JS 截止时间必须释放调用，不能永远锁住定位按钮。
        request = () => new Promise(() => {});
        const outcome = await Promise.race([
            getCurrentLocation({ timeout: 15 }).then(() => 'resolved', error => error),
            sleep(100).then(() => 'still pending')
        ]);
        assert.equal(outcome.code, LOCATION_ERROR.TIMEOUT);
        assert.ok(outcome.message.includes('网络'), 'Android timeouts (AMap requests) still mention the network');

        // 权限检查自身无回调也必须超时，启动自动定位才不会一直占用按钮。
        checkPermission = () => new Promise(() => {});
        const stalledCheck = await Promise.race([
            getCurrentLocation({ timeout: 15 }).then(() => 'resolved', error => error.code),
            sleep(100).then(() => 'still pending')
        ]);
        assert.equal(stalledCheck, LOCATION_ERROR.TIMEOUT);
        checkPermission = async () => permission;

        // 离开地图时取消；迟到的原生位置不应恢复已结束的请求。
        let late;
        let started;
        const began = new Promise(resolve => { started = resolve; });
        request = () => new Promise(resolve => { late = resolve; started(); });
        const controller = new AbortController();
        const cancelled = getCurrentLocation({ signal: controller.signal, timeout: 5000 });
        await began;
        controller.abort();
        const cancelledOutcome = await Promise.race([
            cancelled.then(() => 'resolved', error => error.code),
            sleep(100).then(() => 'still pending')
        ]);
        late(amapFix(5));
        assert.equal(cancelledOutcome, LOCATION_ERROR.ABORTED);

        // 授权弹窗等待不计入获取位置的超时；只授予模糊位置也可继续。
        permission = { location: 'prompt', coarseLocation: 'prompt' };
        requestPermission = async () => {
            await sleep(30);
            return { location: 'denied', coarseLocation: 'granted' };
        };
        request = async () => amapFix(2000);
        assert.equal((await getCurrentLocation({ timeout: 15 })).accuracy, 2000);

        // 已取消或在授权期间离开地图：不再向原生索取位置。
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        checkPermission = () => assert.fail('aborted request must not check permission');
        await assert.rejects(getCurrentLocation({ signal: alreadyAborted.signal }), { code: LOCATION_ERROR.ABORTED });
        checkPermission = async () => permission;
        let answer;
        let promptStarted;
        const prompted = new Promise(resolve => { promptStarted = resolve; });
        requestPermission = () => new Promise(resolve => { answer = resolve; promptStarted(); });
        request = () => assert.fail('cancelled permission prompt must not request a position');
        const leaving = new AbortController();
        const awaitingPermission = getCurrentLocation({ signal: leaving.signal });
        await prompted;
        leaving.abort();
        await assert.rejects(awaitingPermission, { code: LOCATION_ERROR.ABORTED });
        answer({ location: 'granted', coarseLocation: 'granted' });
        await sleep(0);

        // iOS 用 @capacitor/geolocation 的持续定位（不用单次定位）：WGS-84 本地转换；只有精确权限时才请求高精度；
        // 插件的 timeout 要显式传，不传时插件只等 5 秒
        delete globalThis.androidBridge;
        globalThis.webkit = { messageHandlers: { bridge: {} } };
        calls.length = 0;
        permission = { location: 'denied', coarseLocation: 'granted' };
        request = () => assert.fail('iOS must not use the one-shot getCurrentPosition');
        startWatch = (options, callback) => {
            assert.deepEqual(options, { enableHighAccuracy: false, timeout: 20000, maximumAge: 0 }, 'approximate permission must not trigger a precise-location upgrade');
            callback(freshFix(2000));
        };
        const iosApproximate = await getCurrentLocation();
        assert.equal(iosApproximate.accuracy, 2000);
        assert.deepEqual(iosApproximate.raw, { lng: -0.12, lat: 51.5, coordSystem: 'WGS-84' });
        await sleep(0);
        assert.deepEqual(calls, ['Geolocation.checkPermissions', 'Geolocation.watchPosition', 'Geolocation.clearWatch']);
        assert.deepEqual(cleared, ['watch-1'], 'without onUpdate the watch stops after the first fix');

        // 精确权限：首个位置立即返回，更准的位置交给 onUpdate，达到 20 米停止
        permission = { location: 'granted', coarseLocation: 'granted' };
        const watching = new Promise((resolve) => {
            startWatch = (options, callback) => {
                assert.equal(options.enableHighAccuracy, true);
                resolve(callback);
            };
        });
        const iosUpdates = [];
        const iosPending = getCurrentLocation({ onUpdate: (p) => iosUpdates.push(p.accuracy) });
        const emit = await watching;
        emit(freshFix(65, 116.397, 39.908));
        const iosFirst = await iosPending;
        assert.equal(iosFirst.accuracy, 65);
        assert.equal(iosFirst.coordSystem, 'GCJ-02');
        assert.ok(Math.abs(iosFirst.lng - 116.397) > 1e-4, 'Beijing is shifted to GCJ-02');
        emit(freshFix(8, 116.397, 39.908));
        assert.deepEqual(iosUpdates, [8]);
        await sleep(0);
        assert.deepEqual(cleared, ['watch-1', 'watch-2']);

        // 插件错误码；检查权限时系统定位总开关关闭
        for (const [code, expected] of [
            ['OS-PLUG-GLOC-0003', LOCATION_ERROR.PERMISSION_DENIED],
            ['OS-PLUG-GLOC-0010', LOCATION_ERROR.TIMEOUT]
        ]) {
            startWatch = (options, callback) => callback(null, { code, message: `native ${code}` });
            await assert.rejects(getCurrentLocation(), { code: expected });
        }
        checkPermission = async () => { throw nativeError('OS-PLUG-GLOC-0007'); };
        await assert.rejects(getCurrentLocation(), { code: LOCATION_ERROR.SERVICES_DISABLED });
        checkPermission = async () => permission;

        // 一直没有位置：报超时，iOS 的提示不提网络
        startWatch = () => {};
        await assert.rejects(getCurrentLocation({ timeout: 15 }), (error) => {
            assert.equal(error.code, LOCATION_ERROR.TIMEOUT);
            assert.ok(!error.message.includes('网络'), error.message);
            return true;
        });
    } finally {
        globalThis.window = originalWindow;
        globalThis.Capacitor = originalCapacitor;
        globalThis.androidBridge = originalBridge;
        globalThis.webkit = originalWebkit;
    }
}

console.log('geolocation tests passed');
