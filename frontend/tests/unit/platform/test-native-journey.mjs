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

// 控制器：入口、素材、地址与日历页面（使用假 fetch；日历数据按请求的月份生成，不依赖今天的日期）
{
    const originalFetch = globalThis.fetch;
    const requests = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
        assert.equal(entry.sections[0].rows.length, 2);
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
        assert.deepEqual(backToEntry.page.sections[0].rows.map((row) => row.title), ['写日记', '日历']);

        // 写日记：自绘页面，输入同步只回 silent，地址是下一级，返回时回到同一份素材
        const composer = await controller.handle('action', { actionId: backToEntry.page.sections[0].rows[0].actions[0].id });
        assert.equal(composer.page.title, '写日记');
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

        assert.equal(leave.page.sections[0].rows.some((row) => row.id === 'community'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// 核对页：草稿列表合成一列；选择店铺（候选、搜索店名）回到核对页时保留修改；公开前确认重复的店
{
    const originalFetch = globalThis.fetch;
    const requests = [];
    const bodies = [];
    let previewCalls = 0;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const draft = {
        journey_id: null, base_revision: 0, revision: 1,
        document: {
            title: '面馆晚饭', start_date: '2026-10-01', end_date: '2026-10-01', summary: '', ai_assisted: true, intended_visibility: 'public',
            entry_media_ids: [], media_meta: {},
            stops: [
                { id: 's1', name: '面馆', lng: null, lat: null, place_id: null, address: '', source: 'manual', confirmed: false, visit_status: 'unknown',
                    at: '2026-10-01T12:00', at_source: 'model', media_ids: [], expenses: [], excerpts: [], excerpt_edited: '',
                    candidates: [{ id: 'local_1', place_id: 1, name: '测试面馆', lng: 120, lat: 30, source: 'local', suggested: true }] },
                { id: 's2', name: '奶茶', lng: null, lat: null, place_id: null, address: '', source: 'manual', confirmed: false, visit_status: 'visited',
                    at: '', media_ids: [], expenses: [], excerpts: [], excerpt_edited: '' }
            ]
        }
    };
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('https://api.example.com', '');
        requests.push(`${options.method || 'GET'} ${path}`);
        if (options.body && typeof options.body === 'string') bodies.push([path, JSON.parse(options.body)]);
        if (path.startsWith('/api/journeys/unfinished')) return json({ material: [], generating: [], review: [{ id: 'd1', title: '面馆晚饭', start_date: '2026-10-01', end_date: '2026-10-01', stop_count: 2, pending: 2, revision: 1 }], editing: [], count: 1 });
        if (path.startsWith('/api/journeys/capabilities')) return json({ text_ai: true, vision_ai: true });
        if (path.startsWith('/api/journeys/calendar')) return json({ entries: [], draft_dates: [] });
        if (path === '/api/journeys/drafts/d1' && !options.method) return json(draft);
        if (path === '/api/journeys/drafts/d1' && options.method === 'PUT') return json({ revision: 2 });
        if (path.startsWith('/api/places/search/fast')) return json([{ id: 7, name: '街角奶茶', longitude: 120.1, latitude: 30.1, address: '大学城路 2 号' }]);
        if (path === '/api/journeys/drafts/d1/map-preview') {
            previewCalls += 1;
            const s2 = bodies.filter(([p]) => p === '/api/journeys/drafts/d1' ).at(-1)?.[1].document.stops.find((stop) => stop.id === 's2');
            const resolved = s2?.duplicate_ack?.includes(9);
            return json({ preview_hash: `h${previewCalls}`, counts: { conflict: resolved ? 0 : 1, link: 1, create: 1 },
                links: resolved ? [] : [{ stop_id: 's2', action: 'conflict', duplicates: [{ id: 9, name: '街角奶茶二店', address: '', distance_m: 80, lng: 120.1, lat: 30.1 }] }] });
        }
        if (path === '/api/journeys/drafts/d1/commit') return json({ journey_id: 'j1', revision: 1, visibility: 'public', linked: 1, created_place_ids: [12] });
        if (path === '/api/journeys/j1') return json({ id: 'j1', revision: 1, visibility: 'public', document: { ...draft.document, stops: [] }, publication: { public_id: 'p1' } });
        return json({}, 404);
    };
    try {
        const controller = createNativeJourneyController({ backendUrl: 'https://api.example.com', token: 't', user: { id: 1 }, onClose: () => {} });
        const entry = await controller.start();
        await controller.handle('action', { actionId: entry.sections[0].rows[1].actions[0].id });
        const unfinished = await controller.handle('custom', { intent: 'unfinished', values: {} });
        const [only] = unfinished.page.sections;
        assert.equal(only.rows.length, 1, 'all drafts sit in one list');
        assert.match(only.rows[0].subtitle, /^待确认 · /, 'each row starts with its status');

        const review = await controller.handle('action', { actionId: only.rows[0].actions[0].id });
        assert.match(review.page.subtitle, /AI 整理/, 'the AI tag appears once, in the subtitle');
        const [first, second] = review.page.sections.find((section) => section.id === 'stops').rows;
        assert.equal(first.actions[0].title, '选择店铺');
        assert.equal(first.badge, '待确认');
        const edit = await controller.handle('action', { actionId: first.actions[1].id });
        const fieldIds = edit.form.fields.map((field) => field.id);
        assert.deepEqual(fieldIds, ['name', 'has_at', 'at', 'text'], 'no coordinates or address to type in');
        assert.ok(!review.page.sections.find((section) => section.id === 'info').form.fields.some((field) => field.id === 'visibility'), 'visibility is chosen by the save buttons only');

        // 编辑后去选店：回来时修改仍在，选定的候选即为已确认
        await controller.handle('submit', { formId: edit.form.id, values: { name: '老面馆', has_at: true, at: '2026-10-01T12:30', text: '一碗牛肉面' } });
        const reviewNow = await controller.handle('action', { actionId: first.actions[0].id });
        const shop = reviewNow.page;
        assert.equal(shop.title, '选择店铺');
        const candidate = shop.sections.find((section) => section.id === 'candidates').rows[0];
        const back = await controller.handle('action', { actionId: candidate.actions[0].id });
        const stops = back.page.sections.find((section) => section.id === 'stops').rows;
        assert.equal(stops[0].title, '1. 测试面馆');
        assert.equal(stops[0].badge, '', 'the chosen shop and the checked time leave nothing to confirm');
        assert.equal(stops[0].detail, '一碗牛肉面', 'edits made before picking are kept');

        // 第二站：按店名搜索地图上已有的店
        const shop2 = await controller.handle('action', { actionId: stops[1].actions[0].id });
        assert.equal(shop2.page.subtitle, '奶茶');
        const searched = await controller.handle('filter', { filterId: 'search', value: '奶茶' });
        assert.ok(requests.some((line) => line.startsWith('GET /api/places/search/fast?q=')));
        const found = searched.page.sections.find((section) => section.id === 'results').rows[0];
        const back2 = await controller.handle('action', { actionId: found.actions[0].id });
        assert.equal(back2.page.sections.find((section) => section.id === 'stops').rows[1].title, '2. 街角奶茶');

        // 公开时有可能重复的店：打开确认页，而不是只报错
        const publish = back2.page.buttons.find((button) => button.title === '保存并公开');
        assert.equal(publish.tone, 'primary');
        assert.equal(back2.page.buttons.find((button) => button.title === '保存为私密').tone, '', 'only one primary save button');
        const duplicates = await controller.handle('action', { actionId: publish.id });
        assert.equal(duplicates.page.title, '确认是不是同一家');
        const row = duplicates.page.sections.find((section) => section.id === 'duplicates').rows[0];
        const different = row.actions.find((item) => item.title === '不是同一家');
        const resolved = await controller.handle('action', { actionId: different.id });
        const save = resolved.page.buttons.find((button) => button.title === '保存并公开');
        assert.ok(save, 'once everything is confirmed the page offers to publish');
        const saved = await controller.handle('action', { actionId: save.id });
        assert.ok(requests.includes('POST /api/journeys/drafts/d1/commit'));
        assert.match(saved.page.sections[0].text, /新增 1 个地点/);
        const committed = bodies.filter(([p]) => p === '/api/journeys/drafts/d1').at(-1)[1].document.stops;
        assert.equal(committed[0].confirmed, true);
        assert.equal(committed[0].at, '2026-10-01T12:30');
        assert.equal(committed[0].at_source, '');
        assert.deepEqual(committed[1].duplicate_ack, [9]);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('Native journey session and controller smoke tests passed.');
