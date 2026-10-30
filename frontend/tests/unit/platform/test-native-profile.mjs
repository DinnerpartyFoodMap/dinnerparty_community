import assert from 'node:assert/strict';
import {
    pickNativeProfileValues,
    createNativeProfileSession
} from '../../../src/platform/nativeProfile.js';
import {
    buildProfileViewModel,
    profileSelfLevels,
    profileWidgetOptions
} from '../../../src/profile/profileViewModel.js';

class FakePlugin {
    constructor() {
        this.listeners = new Map();
        this.responded = [];
        this.closed = [];
        this.openResolve = null;
        this.openReject = null;
    }

    async addListener(name, callback) {
        this.listeners.set(name, callback);
        return { remove: () => this.listeners.delete(name) };
    }

    open() {
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

// 原生只接受白名单字段
{
    assert.deepEqual(pickNativeProfileValues('setTasteLevel', { key: 'noodles', level: 3 }), { key: 'noodles', level: 3 });
    assert.deepEqual(pickNativeProfileValues('setTasteLevel', { key: 'noodles', level: null }), { key: 'noodles', level: null });
    assert.equal(pickNativeProfileValues('setTasteLevel', { key: 'unknown', level: 3 }), null);
    assert.equal(pickNativeProfileValues('setTasteLevel', { key: 'noodles', level: 9 }), null);
    assert.deepEqual(pickNativeProfileValues('saveWidgets', { widgets: ['recent', 'favorite'] }), { widgets: ['recent', 'favorite'] });
    assert.deepEqual(pickNativeProfileValues('saveWidgets', { widgets: ['recent', 'bad', 'recent'] }), { widgets: ['recent', 'recent'] });
    assert.equal(pickNativeProfileValues('saveWidgets', { widgets: [] }), null);
    assert.deepEqual(pickNativeProfileValues('setBlocked', { blocked: true }), { blocked: true });
    assert.equal(pickNativeProfileValues('setBlocked', { blocked: 'yes' }), null);
    assert.equal(pickNativeProfileValues('other', {}), null);
}

// 视图模型：六轴按固定顺序补齐、小组件行带评价文案、自己填的选项
{
    assert.equal(profileSelfLevels().length, 4);
    assert.equal(profileWidgetOptions().length, 3);

    const profile = {
        user: { id: 9, username: '幽幽子', has_avatar: true },
        relation: { self: true, can_block: false, blocked: false },
        city: '上海',
        widgets: ['recent', 'favorite', 'collection'],
        content: {
            recent: [{ id: 1, name: '小面馆', image: null, category: '小吃', rating_average: 3.8 }],
            favorite: [{ id: 2, name: '火锅店', image: 'https://cdn.example.com/a.jpg', own_score: 4 }],
            collection: [{
                id: 3,
                title: '夜宵',
                total: 1,
                places: [{ id: 4, name: '烧烤', image: null, category: '烧烤', rating_average: 3 }]
            }]
        },
        taste: [
            { key: 'homestyle', value: 0.8, basis: 'evidence' },
            { key: 'noodles', value: 0.2, basis: 'embedding' },
            { key: 'drinks', value: 0.6, basis: 'self', self_level: 3 }
        ]
    };
    const view = buildProfileViewModel(profile, {
        currentUser: { id: 9 },
        tokenPresent: true,
        avatarURL: 'https://api.example.com/users/9/avatar'
    });
    assert.equal(view.name, '幽幽子');
    assert.equal(view.avatarURL, 'https://api.example.com/users/9/avatar');
    assert.ok(view.city.includes('上海'));
    assert.equal(view.self, true);
    assert.equal(view.canEditTaste, true);
    assert.equal(view.canEditWidgets, true);
    assert.equal(view.axes.length, 6);
    assert.deepEqual(view.axes.map((axis) => axis.key), ['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign']);
    assert.equal(view.axes[0].value, 0.8);
    assert.equal(view.axes[1].estimated, true);
    assert.equal(view.axes[2].value, null);
    assert.equal(view.axes[2].label.length > 0, true);
    assert.equal(view.axes[4].selfLevel, 3);
    assert.equal(view.sections.length, 3);
    assert.equal(view.sections[0].kind, 'recent');
    assert.equal(view.sections[0].groups[0].rows[0].name, '小面馆');
    assert.ok(view.sections[0].groups[0].rows[0].meta.length > 0);
    assert.ok(view.sections[1].groups[0].rows[0].meta.length > 0);
    assert.ok(view.sections[2].groups[0].title.includes('夜宵'));
    assert.equal(view.widgetSlotLabels.length, 3);
    assert.ok(view.labels.blockConfirm.includes('幽幽子'));
    assert.ok(view.labels.blockedNote.length > 0);
}

// 会话：偏好 / 小组件 / 屏蔽请求交给网页，respond 回传最新快照；返回与打开地点分开处理
{
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeProfileSession(plugin, {}, {
        onEvent: async (type, values) => {
            calls.push([type, values]);
            return { ok: true, profile: { name: type } };
        },
        onBack: () => calls.push(['back']),
        onOpenPlace: (id) => calls.push(['place', id]),
        onError: (error) => calls.push(['error', error.message])
    });
    const started = session.start();
    await tick();

    plugin.emit('profileEvent', { id: 'other', type: 'setTasteLevel', requestId: 'x', values: { key: 'noodles', level: 2 } });
    plugin.emit('profileEvent', { id: session.id, type: 'setTasteLevel', requestId: 'r1', values: { key: 'noodles', level: 2 } });
    await tick();
    assert.deepEqual(calls[0], ['setTasteLevel', { key: 'noodles', level: 2 }]);
    assert.deepEqual(plugin.responded[0], {
        id: session.id, requestId: 'r1', ok: true, message: '', profile: { name: 'setTasteLevel' }
    });

    plugin.emit('profileEvent', { id: session.id, type: 'saveWidgets', requestId: 'r2', values: { widgets: ['recent'] } });
    await tick();
    assert.deepEqual(calls[1], ['saveWidgets', { widgets: ['recent'] }]);
    assert.equal(plugin.responded[1].requestId, 'r2');

    plugin.emit('profileEvent', { id: session.id, type: 'setBlocked', requestId: 'r3', values: { blocked: true } });
    await tick();
    assert.deepEqual(calls[2], ['setBlocked', { blocked: true }]);

    plugin.openResolve({ id: session.id, action: 'openPlace', values: { placeId: 'p2' } });
    await started;
    assert.deepEqual(calls.at(-1), ['place', 'p2']);
}

// 返回：open 以 back 结束
{
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeProfileSession(plugin, {}, {
        onEvent: async () => ({ ok: true }),
        onBack: () => calls.push('back'),
        onOpenPlace: () => calls.push('place'),
        onError: () => calls.push('error')
    });
    const started = session.start();
    await tick();
    plugin.openResolve({ id: session.id, action: 'back' });
    await started;
    assert.deepEqual(calls, ['back']);
}

// 关闭与失败
{
    const plugin = new FakePlugin();
    const session = createNativeProfileSession(plugin, {}, {
        onEvent: async () => ({ ok: true }),
        onBack: () => {},
        onError: () => {}
    });
    const started = session.start();
    await tick();
    await session.stop();
    assert.deepEqual(plugin.closed, [{ id: session.id }]);
    plugin.openResolve({ id: session.id, action: 'back' });
    await started;

    const failing = new FakePlugin();
    let message = '';
    const failed = createNativeProfileSession(failing, {}, {
        onEvent: async () => ({ ok: true }),
        onBack: () => {},
        onError: (error) => { message = error.message; }
    });
    const failedStart = failed.start();
    await tick();
    failing.openReject(new Error('BUSY'));
    await failedStart;
    assert.equal(message, 'BUSY');
}

console.log('Native profile session tests passed.');
