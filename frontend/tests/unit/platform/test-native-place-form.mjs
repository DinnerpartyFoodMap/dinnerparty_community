// iOS 原生地点表单的网页侧会话（platform/nativePlaceForm.js）：字段白名单、按 requestId 回执、过期 id 忽略、结束动作。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativePlaceFormSession, pickPlaceFormValues, MAX_PLACE_IMAGE_BASE64, PLACE_FORM_ACTIONS } from '../../../src/platform/nativePlaceForm.js';

// 白名单：截断、人均只要正整数、评价 1–4、图片只要 http(s) 地址
assert.deepEqual(pickPlaceFormValues({
    name: '  店名 ', category: '火锅店, 烧烤', description: 'x'.repeat(1200), perPersonCost: '012', rating: 9,
    exteriorImages: ['https://cdn.example.com/a.jpg', 'javascript:alert(1)', 42], menuImages: 'nope', extra: true
}), {
    name: '店名', category: '火锅店, 烧烤', description: 'x'.repeat(1000), perPersonCost: '', rating: null,
    exteriorImages: ['https://cdn.example.com/a.jpg'], menuImages: []
});
assert.equal(pickPlaceFormValues({ perPersonCost: '45', rating: 3 }).perPersonCost, '45');
assert.equal(pickPlaceFormValues({ rating: 3 }).rating, 3);
assert.equal(pickPlaceFormValues(null), null);
assert.deepEqual([...PLACE_FORM_ACTIONS], ['submitted', 'deleted', 'cancel', 'pickPosition']);

function fakePlugin() {
    const plugin = { listener: null, responses: [], opened: null, closed: [] };
    let finishOpen;
    plugin.addListener = async (name, handler) => { assert.equal(name, 'placeFormEvent'); plugin.listener = handler; return { remove() { plugin.listener = null; } }; };
    plugin.open = (snapshot) => { plugin.opened = snapshot; return new Promise((resolve) => { finishOpen = resolve; }); };
    plugin.finish = (result) => finishOpen(result);
    plugin.respond = async (payload) => { plugin.responses.push(payload); };
    plugin.close = async (payload) => { plugin.closed.push(payload); };
    return plugin;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

{
    const plugin = fakePlugin();
    const calls = [];
    const finished = [];
    const session = createNativePlaceFormSession(plugin, { mode: 'create', labels: { title: '添加地点' } }, {
        onUpload: async (image) => { calls.push(['upload', image.length]); return { ok: true, url: 'https://cdn.example.com/new.jpg' }; },
        onSubmit: async (values) => { calls.push(['submit', values.name]); return { ok: false, message: '店名重复' }; },
        onDelete: async () => { calls.push(['delete']); return { ok: true }; },
        onFinish: (action, values) => finished.push([action, values?.name]),
        onError: (error) => { throw error; }
    });
    const started = session.start();
    await tick();
    assert.equal(plugin.opened.mode, 'create');
    assert.equal(plugin.opened.id, session.id);
    // 其他表单的事件、没有 requestId 的事件、不认识的类型都忽略
    await plugin.listener({ id: 'other', type: 'upload', requestId: 'r0', image: 'abc' });
    await plugin.listener({ id: session.id, type: 'upload', image: 'abc' });
    await plugin.listener({ id: session.id, type: 'eval', requestId: 'r1' });
    assert.deepEqual(calls, []);
    await plugin.listener({ id: session.id, type: 'upload', requestId: 'r2', image: 'abcd' });
    await plugin.listener({ id: session.id, type: 'upload', requestId: 'r3', image: 'a'.repeat(MAX_PLACE_IMAGE_BASE64 + 1) });
    await plugin.listener({ id: session.id, type: 'submit', requestId: 'r4', values: { name: '新店' } });
    await plugin.listener({ id: session.id, type: 'submit', requestId: 'r5', values: { name: '   ' } });
    await plugin.listener({ id: session.id, type: 'delete', requestId: 'r6' });
    assert.deepEqual(calls, [['upload', 4], ['submit', '新店'], ['delete']]);
    assert.deepEqual(plugin.responses.map(({ requestId, ok, url, message }) => [requestId, ok, url, message]), [
        ['r2', true, 'https://cdn.example.com/new.jpg', ''],
        ['r3', false, undefined, ''],
        ['r4', false, undefined, '店名重复'],
        ['r5', false, undefined, ''],
        ['r6', true, undefined, '']
    ]);
    plugin.finish({ id: session.id, action: 'cancel', values: { name: '草稿', description: '写了一半' } });
    await started;
    assert.deepEqual(finished, [['cancel', '草稿']]);
    assert.equal(plugin.listener, null, 'listener removed after the form ends');
}

{
    // 原生返回别的 id 或不认识的动作：算作异常结束，调用方改用网页表单
    const plugin = fakePlugin();
    let failed = null;
    const session = createNativePlaceFormSession(plugin, { mode: 'edit' }, {
        onUpload: async () => ({ ok: true }), onSubmit: async () => ({ ok: true }), onFinish: () => assert.fail('must not finish'),
        onError: (error) => { failed = error; }
    });
    const started = session.start();
    await tick();
    plugin.finish({ id: session.id, action: 'explode' });
    await started;
    assert.ok(failed instanceof Error);
}

{
    // 停止后不再回执，并关闭原生表单
    const plugin = fakePlugin();
    const session = createNativePlaceFormSession(plugin, { mode: 'edit' }, {
        onUpload: async () => ({ ok: true }), onSubmit: async () => ({ ok: true }), onFinish: () => {}, onError: () => {}
    });
    session.start();
    await tick();
    const handler = plugin.listener;
    await session.stop();
    await handler({ id: session.id, type: 'submit', requestId: 'late', values: { name: '迟到' } });
    assert.deepEqual(plugin.responses, []);
    assert.deepEqual(plugin.closed, [{ id: session.id }]);
}

// Swift 插件与网页约定的事件名、方法与结束动作一致
const swift = readFileSync(new URL('../../../ios/App/App/NativePlaceFormPlugin.swift', import.meta.url), 'utf8');
assert.ok(swift.includes('notifyListeners("placeFormEvent"'), 'event name');
for (const method of ['open', 'close', 'respond']) assert.ok(swift.includes(`CAPPluginMethod(name: "${method}"`), method);
for (const action of ['submitted', 'deleted', 'cancel', 'pickPosition']) assert.ok(swift.includes(`"${action}"`), `native finishes with ${action}`);
for (const type of ['upload', 'submit', 'delete']) assert.ok(swift.includes(`"${type}"`), `native sends ${type}`);
const registered = readFileSync(new URL('../../../ios/App/App/FoodMapBridgeViewController.swift', import.meta.url), 'utf8');
assert.ok(registered.includes('registerPluginInstance(NativePlaceFormPlugin())'));
const project = readFileSync(new URL('../../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
// 与反馈页插件一样登记在工程里（文件引用、编译文件、分组与 Sources）
const mentions = (name) => (project.match(new RegExp(`${name}\\.swift`, 'g')) || []).length;
assert.equal(mentions('NativePlaceFormPlugin'), mentions('NativeFeedbackPlugin'), 'registered like NativeFeedbackPlugin.swift');

console.log('native place form tests passed');
