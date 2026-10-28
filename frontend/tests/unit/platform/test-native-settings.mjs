import assert from 'node:assert/strict';
import { createNativeSettingsSession } from "../../../src/platform/nativeSettings.js";

function harness(open) {
    const actions = [], errors = [], closed = [], snapshots = [];
    const plugin = {
        open: async snapshot => { snapshots.push(snapshot); return open(snapshot); },
        close: async ({ id }) => { closed.push(id); }
    };
    const session = createNativeSettingsSession(plugin, { username: '测试住民', dark: true }, {
        onAction: action => actions.push(action), onError: error => errors.push(error), retryDelay: 0
    });
    return { session, actions, errors, closed, snapshots };
}

for (const action of ['back', 'avatar', 'username', 'password', 'themes', 'personalize', 'skins', 'logoutAll', 'deleteAccount']) {
    const h = harness(({ id }) => ({ id, action }));
    await h.session.start();
    assert.deepEqual(h.actions, [action]);
    assert.equal(h.snapshots[0].username, '测试住民');
    assert.equal(h.errors.length, 0);
}
// 只接受本次呈现的白名单动作，异常结束回退到可操作的网页页面。
for (const response of [{ id: 'old', action: 'deleteAccount' }, { action: 'eval' }, { action: 'cancel' }]) {
    const h = harness(({ id }) => ({ id, ...response }));
    await h.session.start();
    assert.equal(h.actions.length, 0);
    assert.equal(h.errors.length, 1);
}
// 离开设置后，迟到的原生动作不能发起账号请求。
{
    let resolveOpen;
    const h = harness(() => new Promise(resolve => { resolveOpen = resolve; }));
    const pending = h.session.start();
    await h.session.stop();
    resolveOpen({ id: h.snapshots[0].id, action: 'deleteAccount' });
    await pending;
    assert.deepEqual(h.closed, [h.snapshots[0].id]);
    assert.equal(h.actions.length, 0);
    assert.equal(h.errors.length, 0);
}
// 住民面板关闭期间重试；持续占用有上限，不顶掉其他系统界面。
{
    let calls = 0;
    const h = harness(({ id }) => {
        if (++calls < 3) throw Object.assign(new Error('transition'), { code: 'BUSY' });
        return { id, action: 'themes' };
    });
    await h.session.start();
    assert.equal(calls, 3);
    assert.deepEqual(h.actions, ['themes']);
    assert.equal(new Set(h.snapshots.map(s => s.id)).size, 1);
    const busy = harness(() => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); });
    await busy.session.start();
    assert.equal(busy.snapshots.length, 16);
    assert.equal(busy.errors.length, 1);
}
{
    const h = harness(() => { throw new Error('plugin unavailable'); });
    await h.session.start();
    assert.equal(h.errors.length, 1);
    const next = harness(({ id }) => ({ id, action: 'back' }));
    await next.session.start();
    assert.notEqual(h.snapshots[0].id, next.snapshots[0].id);
}
// 原生页内事件：只处理本次呈现的白名单事件；保存结果按 requestId 回传，表单只保留四个字符串字段。
// 其他呈现（旧 id）的事件被忽略；呈现结束后移除监听。
{
    let emit, openedId, finishOpen, removed = 0;
    const events = [];
    const plugin = {
        addListener: async (name, handler) => { assert.equal(name, 'settingsEvent'); emit = handler; return { remove: () => { removed += 1; } }; },
        open: ({ id }) => { openedId = id; return new Promise(resolve => { finishOpen = () => resolve({ id, action: 'back' }); }); },
        close: async () => {},
        respond: async () => {}
    };
    const session = createNativeSettingsSession(plugin, {}, { onAction: () => {}, onError: error => { throw error; }, onEvent: async event => { events.push(event); return { ok: true }; } });
    const started = session.start();
    while (!openedId) await new Promise(resolve => setTimeout(resolve, 1));
    await emit({ id: 'settings-old', type: 'motion', key: 'webMotion', value: false });
    assert.equal(events.length, 0, '其他呈现的事件被忽略');
    finishOpen();
    await started;
    assert.equal(removed, 1, '呈现结束后移除监听');
}
{
    let emit, openedId;
    const responses = [], events = [];
    let finishOpen;
    const plugin = {
        addListener: async (name, handler) => { emit = handler; return { remove: () => {} }; },
        open: ({ id }) => { openedId = id; return new Promise(resolve => { finishOpen = () => resolve({ id, action: 'back' }); }); },
        close: async () => {},
        respond: async payload => { responses.push(payload); }
    };
    const session = createNativeSettingsSession(plugin, {}, {
        onAction: () => {}, onError: error => { throw error; },
        onEvent: async event => {
            events.push(event);
            if (event.type === 'saveMap') return event.values.zoom === 'x' ? { ok: false, message: '请输入有效的缩放等级' } : { ok: true, message: '已保存' };
            return { ok: true };
        }
    });
    const started = session.start();
    while (!openedId) await new Promise(resolve => setTimeout(resolve, 1));
    await emit({ id: openedId, type: 'saveMap', requestId: 'r1', values: { style: 'standard', lat: '23.1', lng: '113.3', zoom: '15', token: 'leak', extra: 1 } });
    await emit({ id: openedId, type: 'saveMap', requestId: 'r2', values: { zoom: 'x' } });
    await emit({ id: openedId, type: 'saveMap', values: {} });                      // 缺 requestId
    await emit({ id: openedId, type: 'motion', key: 'webMotion', value: false });
    await emit({ id: openedId, type: 'motion', key: 'clusterGlass', value: true });
    await emit({ id: openedId, type: 'motion', key: 'evil', value: true });          // 非白名单开关
    await emit({ id: openedId, type: 'motion', key: 'clusterMotion', value: 'yes' }); // 非布尔
    await emit({ id: openedId, type: 'eval', code: '1' });
    assert.deepEqual(events.map(e => e.type), ['saveMap', 'saveMap', 'motion', 'motion']);
    assert.deepEqual(events[0].values, { style: 'standard', lat: '23.1', lng: '113.3', zoom: '15' }, '只保留四个表单字段');
    assert.deepEqual(events[2], { type: 'motion', key: 'webMotion', value: false });
    assert.deepEqual(events[3], { type: 'motion', key: 'clusterGlass', value: true });
    assert.deepEqual(responses, [
        { id: openedId, requestId: 'r1', ok: true, message: '已保存' },
        { id: openedId, requestId: 'r2', ok: false, message: '请输入有效的缩放等级' }
    ]);
    // 离开设置后迟到的事件不再处理
    await session.stop();
    await emit({ id: openedId, type: 'motion', key: 'webMotion', value: true });
    assert.equal(events.length, 4);
    finishOpen();
    await started;
}
// 其他子页面的请求：每类只取白名单字段，非法字段整条丢弃；回执状态只保留白名单键。
{
    let emit, openedId, finishOpen;
    const responses = [], events = [];
    const plugin = {
        addListener: async (name, handler) => { emit = handler; return { remove: () => {} }; },
        open: ({ id }) => { openedId = id; return new Promise(resolve => { finishOpen = () => resolve({ id, action: 'back' }); }); },
        close: async () => {},
        respond: async payload => { responses.push(payload); }
    };
    const session = createNativeSettingsSession(plugin, {}, {
        onAction: () => {}, onError: error => { throw error; },
        onEvent: async event => {
            events.push(event);
            if (event.type === 'saveUsername') return { ok: true, message: '住民名已更新', state: { username: event.values.username, token: 'leak', html: { x: 1 } } };
            if (event.type === 'setDarkMode') return { ok: true, message: '已保存设置', state: { dark: event.values.value, primary: '#FF8FB1', secondary: 7 } };
            return { ok: true, message: '' };
        }
    });
    const started = session.start();
    while (!openedId) await new Promise(resolve => setTimeout(resolve, 1));
    await emit({ id: openedId, type: 'saveUsername', requestId: 'u1', values: { username: '新名字', extra: 'x' } });
    await emit({ id: openedId, type: 'savePassword', requestId: 'p1', values: { current: 'a', next: 'bbbbbb', confirm: 'bbbbbb', token: 'leak' } });
    await emit({ id: openedId, type: 'uploadAvatar', requestId: 'a1', values: { image: 'QUJD' } });
    await emit({ id: openedId, type: 'uploadAvatar', requestId: 'a2', values: { image: 42 } });                 // 非字符串
    await emit({ id: openedId, type: 'setDarkMode', requestId: 'd1', values: { value: true } });
    await emit({ id: openedId, type: 'setDarkMode', requestId: 'd2', values: { value: 'true' } });             // 非布尔
    await emit({ id: openedId, type: 'saveThemeColors', requestId: 't1', values: { primary: '#E2789F', secondary: '#8C6BB1' } });
    await emit({ id: openedId, type: 'setMapStyle', requestId: 's1', values: { which: 'map_style_light', value: 'amap://styles/normal' } });
    await emit({ id: openedId, type: 'setMapStyle', requestId: 's2', values: { which: '__proto__', value: 'x' } }); // 非白名单字段
    await emit({ id: openedId, type: 'toString', requestId: 'x1', values: {} });                                   // 原型上的名字不能当事件
    assert.deepEqual(events.map(e => e.type), ['saveUsername', 'savePassword', 'uploadAvatar', 'setDarkMode', 'saveThemeColors', 'setMapStyle']);
    assert.deepEqual(events[0].values, { username: '新名字' });
    assert.deepEqual(events[1].values, { current: 'a', next: 'bbbbbb', confirm: 'bbbbbb' });
    assert.deepEqual(events[5].values, { which: 'map_style_light', value: 'amap://styles/normal' });
    assert.deepEqual(responses.find(r => r.requestId === 'u1').state, { username: '新名字' }, '回执状态只保留白名单键');
    assert.deepEqual(responses.find(r => r.requestId === 'd1').state, { dark: true, primary: '#FF8FB1' }, '类型不符的状态字段被丢弃');
    assert.equal('state' in responses.find(r => r.requestId === 'p1'), false, '没有状态时不带 state');
    finishOpen();
    await started;
}
console.log('native settings tests passed');
