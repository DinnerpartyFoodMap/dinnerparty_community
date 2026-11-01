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

// 控制器 smoke：首页信息框、用户行与详情字段、白名单/公告内联表单、口味分类实时保存、展会修改页（使用假 fetch）
{
    const originalFetch = globalThis.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const puts = [];
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('https://api.example.com', '');
        if (path === '/admin/users') {
            return json([
                { id: 1, username: '幽幽子', admin_level: '', is_banned: 0, has_avatar: 0, qq: '' },
                { id: 2, username: '妖梦', admin_level: 'YOUMU', is_banned: 1, ban_reason: '刷屏', has_avatar: 1, qq: '12345' }
            ]);
        }
        if (path === '/admin/qq-whitelist') return json([{ id: 1, qq: '12345', created_time: '2026-10-30' }]);
        if (path === '/admin/notices') return json([{ id: 3, title: '停机', content: '今晚维护', color_key: 'rose', is_active: 1 }]);
        if (path.startsWith('/admin/taste-axes/places?')) return json({ items: [{ place_id: 7, name: '面馆', category: '面', source: 'llm', axes: ['noodles'] }], total: 1, page_size: 20 });
        if (path === '/admin/taste-axes/places/7' && options.method === 'PUT') { puts.push(JSON.parse(options.body)); return json({ ok: true }); }
        if (path === '/admin/exhibitions') return json({ exhibitions: [{ id: 4, name: '例大祭', event_time: '2026-11-08 10:00', description: '简介', information: '信息' }] });
        if (path === '/place-requests') return json([{ id: 5, status: 'pending', place_id: 8, requester_id: 'u3', created_time: '2026-10-31', proposed: { name: '新店名', per_person_cost: 30, exterior_images: ['/uploads/a.jpg'] }, note: '改名了' }]);
        return json({}, 404);
    };
    try {
        const controller = createNativeAdminController({
            backendUrl: 'https://api.example.com', token: 't', user: { id: 9, username: '紫', admin_level: 'YUYUKO' }
        });
        // 首页：个人信息框（服务器默认头像兜底），带图标的管理项，没有皮肤兑换码
        const dashboard = controller.dashboard();
        assert.equal(dashboard.header.title, '紫');
        assert.match(dashboard.header.image, /\/users\/9\/avatar\?fallback=default$/);
        assert.match(dashboard.header.subtitle, /YUYUKO/);
        assert.equal(dashboard.sections[0].rows.length, 8);
        assert.ok(!dashboard.sections[0].rows.some((row) => row.id === 'skinCodes'));
        assert.ok(!dashboard.sections[0].rows.some((row) => row.id === 'generalUsers'));
        assert.ok(dashboard.sections[0].rows.every((row) => row.symbol));

        // 用户：没有统计栏，刷新在导航栏；列表是头像、用户名、QQ、状态，字段在详情里
        const users = await controller.load('users');
        assert.equal(users.subtitle, '');
        assert.ok(users.refresh);
        assert.ok(!users.buttons.length);
        const [first, second] = users.sections[0].rows;
        assert.equal(users.sections[0].rows.length, 2);
        assert.match(first.image, /\/users\/1\/avatar\?fallback=default$/);
        assert.equal(first.imageShape, 'circle');
        assert.equal(first.detail, undefined);
        assert.ok(first.actions.length >= 5);
        assert.equal(second.badgeTone, 'danger');
        assert.ok(second.fields.some((field) => field.value === '刷屏'));
        assert.ok(second.fields.some((field) => field.value === 'YOUMU'));

        // 地点申请：列表无图，详情按字段分开，图片在详情页
        const places = await controller.load('places');
        const request = places.sections[0].rows[0];
        assert.equal(places.subtitle, '');
        assert.equal(request.image, undefined);
        assert.ok(request.fields.some((field) => field.value === '新店名'));
        assert.ok(request.fields.some((field) => field.value === '30'));
        assert.ok(request.fields.some((field) => field.value === '改名了'));
        assert.deepEqual(request.gallery, ['https://api.example.com/uploads/a.jpg']);

        // 口味分类：行内复选框，勾选即保存（silent，不刷新页面）
        const taste = await controller.load('tasteAxes');
        const place = taste.sections[0].rows[0];
        assert.deepEqual(place.checks.value, ['noodles']);
        assert.equal(place.checks.options.length, 6);
        const saved = await controller.handle('action', { actionId: place.checks.actionId, values: { value: ['dessert', 'noodles'] } });
        assert.deepEqual(saved, { silent: true });
        assert.deepEqual(puts.at(-1), { axes: ['noodles', 'dessert'] });

        // 白名单：输入框直接在页面里，记录左滑删除
        const qq = await controller.load('qqWhitelist');
        assert.equal(qq.subtitle, '');
        assert.equal(qq.sections[0].form.inline, true);
        const entry = qq.sections[1].rows[0];
        assert.equal(entry.actions.length, 0);
        assert.equal(entry.swipe[0].tone, 'danger');

        // 公告：当前公告（测试环境没有网页渲染时只有文字），发布表单直接填写，颜色是色块
        const notices = await controller.load('notices');
        assert.match(notices.sections[0].text, /停机/);
        const publish = notices.sections.find((section) => section.form).form;
        assert.equal(publish.inline, true);
        assert.ok(publish.fields.find((field) => field.id === 'color').options.every((option) => option.color.startsWith('#')));
        assert.ok(notices.refresh);

        // 展会：点开直接是修改页（下架在页内），下方“新增活动”打开空白表单
        const exhibitions = await controller.load('exhibitions');
        const show = exhibitions.sections[0].rows[0];
        assert.equal(show.actions.length, 1);
        assert.equal(show.actions[0].push, true);
        const edit = await controller.handle('action', { actionId: show.actions[0].id });
        assert.equal(edit.form.fields.find((field) => field.id === 'name').value, '例大祭');
        assert.equal(edit.form.actions[0].tone, 'danger');
        const add = await controller.handle('action', { actionId: exhibitions.buttons[0].id });
        assert.equal(add.form.fields.find((field) => field.id === 'name').value, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('Native admin controller smoke tests passed.');
