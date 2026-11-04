import assert from 'node:assert/strict';
import { createNativeJourneySession } from '../../../src/platform/nativeJourney.js';
import { createNativeJourneyController } from '../../../src/journey/nativeJourneyController.js';

class FakePlugin {
    constructor() {
        this.listeners = new Map();
        this.responded = [];
        this.closed = [];
        this.updated = [];
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
    async update(payload) { this.updated.push(payload); }
    async close(payload) { this.closed.push(payload); }
    emit(name, data) { this.listeners.get(name)?.(data); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 会话：动作、筛选、表单、返回、图片与生成进度
{
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeJourneySession(plugin, {}, {
        onEvent: async (type, event) => {
            calls.push([type, event.actionId || event.filterId || event.formId]);
            return type === 'action' ? { page: { id: 'next' }, message: 'ok' } : {};
        },
        onLoadImage: async (imageId) => ({ ok: true, imageId, imageData: 'data:image/png;base64,AAA' }),
        onClose: () => calls.push('close'),
        onError: (error) => calls.push(['error', error.message])
    });
    const started = session.start({ id: 'entry' });
    await tick();

    plugin.emit('journeyEvent', { id: session.id, type: 'action', requestId: 'r1', actionId: 'a1' });
    await tick();
    assert.deepEqual(calls[0], ['action', 'a1']);
    assert.equal(plugin.responded[0].page.id, 'next');
    assert.equal(plugin.responded[0].message, 'ok');

    plugin.emit('journeyEvent', { id: session.id, type: 'filter', requestId: 'r2', filterId: 'tabs', value: 'public' });
    await tick();
    assert.deepEqual(calls[1], ['filter', 'tabs']);

    plugin.emit('journeyEvent', { id: session.id, type: 'loadImage', requestId: 'r3', imageId: 'journey:7' });
    await tick();
    assert.equal(plugin.responded[2].imageId, 'journey:7');

    await session.update({ id: 'pushed' });
    assert.equal(plugin.updated[0].page.id, 'pushed');

    plugin.openResolve({ id: session.id, action: 'close' });
    await started;
    assert.equal(calls.at(-1), 'close');
}

// 控制器：入口、素材、地址、日历与同好页面（使用假 fetch；日历数据按请求的月份生成，不依赖今天的日期）
{
    const originalFetch = globalThis.fetch;
    const requests = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const collections = [{ id: 5, title: '常去的面馆', is_public: true, places: [{ id: 9, name: '老王面馆', category: '面馆' }] }];
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('https://api.example.com', '');
        requests.push(`${options.method || 'GET'} ${path}`);
        if (path.startsWith('/api/journeys/unfinished')) return json({ material: [], count: 2 });
        if (path.startsWith('/api/journeys/capabilities')) return json({ text_ai: true, vision_ai: true });
        if (path.startsWith('/api/journeys/calendar')) {
            const from = new URL(`https://x${path}`).searchParams.get('from');
            const second = `${from.slice(0, 8)}02`;
            return json({
                entries: [{
                    id: 1, title: '周末小记', start_date: from, end_date: from,
                    stop_count: 2, places: ['面馆'], visibility: 'public', revision: 1, cover_media_id: null
                }],
                draft_dates: [second]
            });
        }
        if (path.startsWith('/api/journeys/1') && options.method === 'DELETE') return new Response(null, { status: 204 });
        if (path.startsWith('/api/journeys/compose-drafts/') && options.method === 'PUT') return json({ revision: 1 });
        if (path === '/api/community/consent') return json({ tags: ['面'], discovery: true, feedback: false, research: false });
        if (path === '/api/community/collections') return json(collections);
        if (path === '/api/favorites') return json([{ place_id: 9, name: '老王面馆' }, { place_id: 10, name: '糖水铺' }]);
        if (path === '/api/community/neighbors') return json({ profile_status: 'ready', notice: '说明', neighbors: [{ id: 'u2', username: '咲夜', similarity: 0.8, confidence: '参考数据较多', shared: [] }] });
        if (path === '/api/community/feedback') return json({ counts: [{ kind: 'click', count: 3 }] });
        return json({}, 404);
    };
    try {
        const controller = createNativeJourneyController({
            backendUrl: 'https://api.example.com', token: 't', user: { id: 1 }, onClose: () => {}, onOpenPlace: () => {}
        });
        // 入口：第 0 级，三行都打开下一级（原生先推入占位页）
        const initial = controller.initialPage();
        assert.equal(initial.level, 0);
        const entry = await controller.start();
        assert.equal(entry.canGoBack, false);
        assert.equal(entry.sections[0].rows.length, 3);
        assert.equal(entry.sections[0].rows[0].id, 'composer');
        assert.ok(entry.sections[0].rows.every((row) => row.actions[0].push === true));

        // 日历：自绘页面数据
        const calendar = await controller.handle('action', { actionId: entry.sections[0].rows[1].actions[0].id });
        assert.equal(calendar.page.level, 1);
        const custom = calendar.page.custom;
        assert.equal(custom.type, 'calendar');
        assert.ok(custom.days.some((day) => day.day === 1 && day.count === 1));
        assert.ok(custom.days.some((day) => day.day === 2 && day.draft === true));
        assert.equal(custom.entries[0].title, '周末小记');
        assert.equal(custom.entries[0].isPublic, true);
        assert.match(custom.unfinishedTitle, /2/);
        assert.match(custom.labels.deleteSelected, /%d/, 'the native view fills in the selected count');
        // 选一天、换月、搜索都原地刷新（同一级）
        const day = await controller.handle('custom', { intent: 'day', values: {}, date: custom.days[0].date });
        assert.equal(day.page.custom.selectedDay, custom.days[0].date);
        const prev = await controller.handle('custom', { intent: 'month', values: {}, delta: -1 });
        assert.notEqual(prev.page.custom.month, custom.month);
        assert.equal(prev.page.custom.selectedDay, '');
        // 多选删除
        const removed = await controller.handle('custom', { intent: 'delete', values: {}, ids: ['1'] });
        assert.ok(requests.some((line) => line.startsWith('DELETE /api/journeys/1')));
        assert.match(removed.message, /1/);
        // 打开一篇：推入详情（下一级）
        assert.ok(controller.handle);

        const backToEntry = await controller.handle('back', { level: 0 });
        assert.equal(backToEntry.page.level, 0);
        assert.equal(backToEntry.page.sections[0].rows.length, 3);

        // 图文生成：自绘页面，输入同步只回 silent，地址是下一级，返回时回到同一份素材
        const composer = await controller.handle('action', { actionId: backToEntry.page.sections[0].rows[0].actions[0].id });
        assert.equal(composer.page.title, '图文生成');
        assert.equal(composer.page.custom.type, 'composer');
        const key = composer.page.custom.key;
        assert.ok(composer.page.custom.buttons.some((button) => button.id === 'generate' && button.style === 'primary'));
        assert.ok(composer.page.custom.labels.keyboardDone, 'the native keyboard gets a done button');
        const synced = await controller.handle('custom', { intent: 'sync', values: { text: '中午吃了面', start_date: '2026-10-01', end_date: '2026-10-01', visibility: 'private' } });
        assert.deepEqual(synced, { silent: true });
        const address = await controller.handle('custom', { intent: 'address', values: {} });
        assert.equal(address.page.level, 2);
        const fromAddress = await controller.handle('back', { level: 1 });
        assert.equal(fromAddress.page.level, 1);
        assert.equal(fromAddress.page.custom.key, key, 'the same draft comes back');
        assert.equal(fromAddress.page.custom.text, '中午吃了面');
        assert.equal(fromAddress.page.custom.visibility, 'private');
        const leave = await controller.handle('back', { level: 0 });
        assert.equal(leave.page.level, 0);
        assert.ok(requests.some((line) => line.startsWith('PUT /api/journeys/compose-drafts/')), 'leaving the composer saves the draft');

        // 同好：头像（服务器默认头像兜底）、收藏夹数量在右侧、点开看地点；编辑收藏夹里有删除；发现设置直接编辑
        const community = await controller.handle('action', { actionId: leave.page.sections[0].rows[2].actions[0].id });
        const neighbor = community.page.sections[0].rows[0];
        assert.equal(neighbor.imageShape, 'circle');
        assert.match(neighbor.image, /\/users\/u2\/avatar\?fallback=default$/);
        assert.ok(community.page.tabs.every((tab) => tab.title.length <= 6), 'short titles keep the tabs one segmented control');
        const collectionsTab = await controller.handle('filter', { filterId: 'tabs', value: 'collections' });
        const row = collectionsTab.page.sections[0].rows[0];
        assert.equal(row.trailing, '1');
        assert.equal(row.subtitle, undefined);
        const collection = await controller.handle('action', { actionId: row.actions[0].id });
        assert.equal(collection.page.level, 2);
        assert.equal(collection.page.sections[0].rows[0].title, '老王面馆');
        assert.equal(collection.page.subtitle, '', 'no “已公开……” line on top');
        const edit = await controller.handle('action', { actionId: collection.page.buttons[0].id });
        assert.equal(edit.form.title, '编辑收藏夹');
        assert.equal(edit.form.actions[0].tone, 'danger');
        const backToCollections = await controller.handle('back', { level: 1 });
        assert.equal(backToCollections.page.selectedTab, 'collections', 'returning keeps the tab');
        const settings = await controller.handle('filter', { filterId: 'tabs', value: 'settings' });
        const form = settings.page.sections[0].form;
        assert.equal(form.inline, true);
        assert.equal(form.fields.find((field) => field.id === 'research').requires, 'feedback');
        assert.ok(!settings.page.sections.some((section) => section.id === 'stats'), 'no interaction stats');
        assert.equal(settings.page.buttons.length, 0, 'no clear-interactions button');
        assert.ok(requests.some((line) => line.includes('/api/community/feedback')), 'settings reads retention metadata');
        assert.ok(settings.page.sections[0].text.includes('90'), 'native settings explains the retention boundary');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('Native journey session and controller smoke tests passed.');
