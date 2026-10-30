import assert from 'node:assert/strict';
import { createNativeAdminSession } from '../../../src/platform/nativeAdmin.js';
import { createNativeAdminController } from '../../../src/admin/nativeAdminController.js';

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

// 事件 -> 网页执行 -> respond 回传页面；图片按 imageId 回传 data URL
{
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeAdminSession(plugin, { dashboard: { id: 'dash' } }, {
        onEvent: async (type, event) => {
            calls.push([type, event.actionId || event.filterId || event.formId]);
            if (type === 'action') return { page: { id: 'page' }, message: 'ok' };
            if (type === 'submit') return { error: 'bad' };
            return {};
        },
        onLoadImage: async (imageId) => ({ ok: true, imageId, imageData: 'data:image/png;base64,AAA' }),
        onClose: () => calls.push(['close']),
        onError: (error) => calls.push(['error', error.message])
    });
    const started = session.start();
    await tick();

    plugin.emit('adminEvent', { id: 'other', type: 'action', requestId: 'x', actionId: 'a1' });
    plugin.emit('adminEvent', { id: session.id, type: 'action', requestId: 'r1', actionId: 'a1' });
    await tick();
    assert.deepEqual(calls[0], ['action', 'a1']);
    assert.equal(plugin.responded[0].requestId, 'r1');
    assert.equal(plugin.responded[0].ok, true);
    assert.equal(plugin.responded[0].page.id, 'page');
    assert.equal(plugin.responded[0].message, 'ok');

    plugin.emit('adminEvent', { id: session.id, type: 'submit', requestId: 'r2', formId: 'f1', values: { a: 1 } });
    await tick();
    assert.equal(plugin.responded[1].ok, false);
    assert.equal(plugin.responded[1].error, 'bad');

    plugin.emit('adminEvent', { id: session.id, type: 'loadImage', requestId: 'r3', imageId: 'feedback:9' });
    await tick();
    assert.equal(plugin.responded[2].imageId, 'feedback:9');
    assert.ok(plugin.responded[2].imageData.startsWith('data:image/png'));

    plugin.openResolve({ id: session.id, action: 'close' });
    await started;
    assert.deepEqual(calls.at(-1), ['close']);
}

// 打开失败交给 onError；stop 调用插件 close
{
    const plugin = new FakePlugin();
    let failed = '';
    const session = createNativeAdminSession(plugin, {}, {
        onEvent: async () => ({}),
        onLoadImage: async () => ({ ok: false }),
        onClose: () => {},
        onError: (error) => { failed = error.message; }
    });
    const started = session.start();
    await tick();
    await session.stop();
    assert.deepEqual(plugin.closed, [{ id: session.id }]);
    plugin.openResolve({ id: session.id, action: 'close' });
    await started;
    assert.equal(failed, '');

    const failing = new FakePlugin();
    let message = '';
    const next = createNativeAdminSession(failing, {}, {
        onEvent: async () => ({}),
        onLoadImage: async () => ({ ok: false }),
        onClose: () => {},
        onError: (error) => { message = error.message; }
    });
    const pending = next.start();
    await tick();
    failing.openReject(new Error('BUSY'));
    await pending;
    assert.equal(message, 'BUSY');
}

console.log('Native admin session tests passed.');

// 控制器 smoke：权限面板、用户行、白名单/公告表单（使用假 fetch）
{
    const originalFetch = globalThis.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url) => {
        const path = String(url).replace('https://api.example.com', '');
        if (path === '/admin/users') {
            return json([
                { id: 1, username: '幽幽子', admin_level: '', is_banned: 0, has_avatar: 0, qq: '' },
                { id: 2, username: '妖梦', admin_level: 'YOUMU', is_banned: 1, has_avatar: 0, qq: '12345' }
            ]);
        }
        if (path === '/admin/qq-whitelist') return json([{ id: 1, qq: '12345', created_time: '2026-10-30' }]);
        if (path === '/admin/notices') return json([]);
        return json({}, 404);
    };
    try {
        const controller = createNativeAdminController({
            backendUrl: 'https://api.example.com', token: 't', user: { id: 9, admin_level: 'YUYUKO' }
        });
        const dashboard = controller.dashboard();
        assert.equal(dashboard.sections[0].rows.length, 9);
        assert.ok(dashboard.sections[0].rows.some((row) => row.id === 'skinCodes'));
        assert.ok(!dashboard.sections[0].rows.some((row) => row.id === 'generalUsers'));

        const users = await controller.load('users');
        assert.equal(users.sections[0].rows.length, 2);
        assert.ok(users.sections[0].rows[0].actions.length >= 5);
        assert.equal(users.sections[0].rows[1].badgeTone, 'danger');

        const qq = await controller.load('qqWhitelist');
        assert.ok(qq.sections.some((section) => section.form));
        assert.ok(qq.sections.some((section) => section.rows?.length === 1));

        const notices = await controller.load('notices');
        assert.ok(notices.sections.some((section) => section.form));
        assert.ok(notices.sections[0].text.length > 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('Native admin controller smoke tests passed.');
