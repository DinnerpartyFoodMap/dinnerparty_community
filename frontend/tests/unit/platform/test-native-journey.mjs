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

// 控制器：入口、素材与日历页面（使用假 fetch）
{
    const originalFetch = globalThis.fetch;
    const requests = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url) => {
        const path = String(url).replace('https://api.example.com', '');
        requests.push(path);
        if (path.startsWith('/api/journeys/unfinished')) return json({ material: [], count: 0 });
        if (path.startsWith('/api/journeys/calendar')) {
            return json({
                entries: [{
                    id: 1, title: '周末小记', start_date: '2026-10-01', end_date: '2026-10-01',
                    stop_count: 2, places: ['面馆'], visibility: 'public', revision: 1, cover_media_id: null
                }],
                draft_dates: ['2026-10-02']
            });
        }
        return json({}, 404);
    };
    try {
        const controller = createNativeJourneyController({
            backendUrl: 'https://api.example.com', token: 't', user: { id: 1 }, onClose: () => {}
        });
        const entry = await controller.start();
        assert.equal(entry.canGoBack, false);
        assert.equal(entry.sections[0].rows.length, 3);
        assert.equal(entry.sections[0].rows[0].id, 'composer');

        const calendarId = entry.sections[0].rows[1].actions[0].id;
        const calendar = await controller.handle('action', { actionId: calendarId });
        assert.ok(calendar.page);
        const block = calendar.page.sections[0].calendar;
        assert.ok(block);
        assert.ok(block.days.some((day) => day.day === 1 && day.count === 1));
        assert.ok(block.days.some((day) => day.day === 2 && day.draft === true));
        assert.equal(calendar.page.sections[1].rows[0].title, '周末小记');

        const backToEntry = await controller.handle('back', {});
        assert.ok(backToEntry.page);
        assert.equal(backToEntry.page.sections[0].rows.length, 3);

        const composerId = backToEntry.page.sections[0].rows[0].actions[0].id;
        const composer = await controller.handle('action', { actionId: composerId });
        assert.ok(composer.page);
        assert.equal(composer.page.title, '图文生成');
        assert.ok(composer.page.buttons.some((button) => button.kind === 'photo'));

        const back = await controller.handle('back', {});
        assert.ok(back.page);
        assert.equal(back.page.sections[0].rows.length, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('Native journey session and controller smoke tests passed.');
