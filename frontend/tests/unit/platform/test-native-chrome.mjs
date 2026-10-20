// 原生地图控件桥接（网页端会话）：npm run test:native-chrome
// 用假插件模拟原生端，覆盖握手、浮层接管、动作回执、会话丢失与故障回退。
import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.document = { visibilityState: 'visible', addEventListener() { } };

const { NativeMapChromeSession, sanitizeItems, sanitizeSearch, sanitizeSheet, sanitizeDrawer, NATIVE_CHROME_PROTOCOL } = await import("../../../src/platform/nativeMapChrome.js");
const { registerOverlay, getOverlayEntries } = await import("../../../src/components/overlay/overlayStack.js");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakePlugin {
    constructor(options = {}) {
        this.options = options;
        this.listeners = {};
        this.calls = [];
        this.acks = [];
        this.state = { session: null, visible: false, suspended: false, revision: 0 };
    }
    async capabilities() { return { protocolVersion: this.options.protocol ?? NATIVE_CHROME_PROTOCOL, supportsGlass: this.options.glass !== false }; }
    async attach({ sessionId, ownerId }) { this.calls.push('attach'); this.state = { ...this.state, session: sessionId, owner: ownerId, visible: false }; return { ready: true }; }
    async setState({ sessionId, revision, items, search, sheet, drawer }) {
        this.calls.push(`setState:${revision}`);
        if (sessionId !== this.state.session) throw new Error('STALE_SESSION');
        this.state.items = items;
        this.state.search = search;
        this.state.sheet = sheet;
        this.state.drawer = drawer;
        this.state.revision = revision;
        if (!this.options.noLayout) {
            setTimeout(() => this.emit('layout', { sessionId, slots: [{ id: 'toolbar', x: 12, y: 740, width: 366, height: 60 }], occupiedRects: [], showing: this.state.visible && !this.state.suspended, bottomOccupied: 104 }), 2);
        }
        return { appliedRevision: revision };
    }
    async suspend({ sessionId }) { this.calls.push('suspend'); if (sessionId !== this.state.session) throw new Error('STALE'); this.state.suspended = true; return { hidden: true }; }
    async resume({ sessionId }) { this.calls.push('resume'); if (sessionId !== this.state.session) throw new Error('STALE'); this.state.visible = true; this.state.suspended = false; return { visible: true }; }
    async ackAction(args) { this.acks.push(args); if (!args.overlayOpened) this.state.suspended = false; return {}; }
    async heartbeat({ sessionId }) { if (this.options.deadHeartbeat || sessionId !== this.state.session) throw new Error('dead'); return { alive: true }; }
    async dispose({ sessionId }) {
        this.calls.push('dispose');
        if (this.options.deadDispose) return new Promise(() => { });
        if (sessionId === this.state.session) this.state = { ...this.state, session: null, visible: false };
        return { disposed: true };
    }
    async addListener(name, fn) {
        (this.listeners[name] ||= []).push(fn);
        return { remove: async () => { this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn); } };
    }
    emit(name, data) { (this.listeners[name] || []).forEach((fn) => fn(data)); }
    tap(actionId, eventId = `e-${Math.random()}`) {
        this.emit('action', { sessionId: this.state.session, ownerId: this.state.owner, revision: this.state.revision, eventId, actionId });
        return eventId;
    }
    search(type, extra = {}) {
        this.emit('search', { sessionId: this.state.session, ownerId: this.state.owner, type, ...extra });
    }
}

const items = [
    { id: 'more', title: '更多', symbol: 'ellipsis.circle', opensOverlay: true },
    { id: 'locate', title: '定位', symbol: 'location', placement: 'floating' },
    { id: 'evil', title: 'x', symbol: 'trash' }
];

// ---- 白名单与字段清洗 ----
assert.deepEqual(sanitizeItems(items).map((i) => i.id), ['more', 'locate']);
assert.equal(sanitizeItems([{ id: 'more', title: 'x'.repeat(100), token: 'secret' }])[0].title.length, 24);
assert.equal('token' in sanitizeItems([{ id: 'more', token: 'secret' }])[0], false);
assert.deepEqual(sanitizeItems([
    { id: 'more' }, { id: 'favorites' }, { id: 'add' }, { id: 'search' },
    { id: 'account', avatarURL: 'https://example.com/users/1/avatar' }
]).map(({ id, placement }) => [id, placement]), [
    ['more', 'toolbar'], ['favorites', 'toolbar'], ['add', 'toolbar'], ['search', 'toolbar'], ['account', 'account']
]);
assert.equal(sanitizeItems([{ id: 'account', avatarURL: 'capacitor://localhost/assets/default.png' }])[0].avatarURL, 'capacitor://localhost/assets/default.png');
for (const avatarURL of ['javascript:alert(1)', 'file:///private/image.png', 'https://user:secret@example.com/avatar', 'broken']) {
    assert.equal(sanitizeItems([{ id: 'account', avatarURL }])[0].avatarURL, undefined);
}

function makeSession(plugin, extra = {}) {
    const modes = [];
    const actions = [];
    const session = new NativeMapChromeSession({
        ownerId: 'map-test',
        plugin,
        available: true,
        timing: { selfHideMs: 30, retryMs: 10000, handshakeMs: 200 },
        onAction: (id) => { actions.push(id); return extra.onAction ? extra.onAction(id) : true; },
        onModeChange: (mode) => modes.push(mode),
        onLayout: () => { }
    });
    return { session, modes, actions };
}

// ---- 握手成功：网页先隐藏，activate 后原生显示 ----
{
    const plugin = new FakePlugin();
    const { session, modes } = makeSession(plugin);
    const ok = await session.start({ items, theme: { primary: '#E2789F' } });
    assert.equal(ok, true);
    assert.deepEqual(modes, ['native']);
    assert.equal(plugin.state.visible, false, '网页工具栏隐藏前原生不可显示');
    await session.activate();
    assert.equal(plugin.state.visible, true);
    assert.deepEqual(plugin.state.items.map((i) => i.id), ['more', 'locate']);

    // 浮层打开 → 收起原生；浮层（含退出阶段）全部结束 → 恢复
    const overlay = registerOverlay({ kind: 'panel', onClose: () => { } });
    await tick(5);
    assert.equal(plugin.state.suspended, true);
    overlay.setStatus('closing');
    await tick(5);
    assert.equal(plugin.state.suspended, true, '退出动画期间保持收起');
    overlay.unregister();
    await tick(5);
    assert.equal(plugin.state.suspended, false);

    // 搜索是栏内动作：必须送达网页，不会收起原生栏；头像是独立动作。
    const received = [];
    session.onAction = (id) => { received.push(id); return true; };
    plugin.tap('search', 'search-1');
    await tick(30);
    assert.deepEqual(received, ['search']);
    assert.equal(plugin.acks.at(-1).overlayOpened, false);
    assert.equal(plugin.state.suspended, false);
    plugin.tap('account', 'account-1');
    await tick(30);
    assert.deepEqual(received, ['search', 'account']);

    // 原生按钮动作：打开了浮层 → 回执 overlayOpened=true；没有打开 → false，原生据此恢复
    let opened = null;
    session.onAction = (id) => { if (id === 'more') opened = registerOverlay({ kind: 'menu', onClose: () => { } }); return true; };
    plugin.state.suspended = true; // 原生点击会打开浮层的按钮时先本地收起
    plugin.tap('more', 'evt-1');
    await tick(30);
    assert.equal(plugin.acks.at(-1).eventId, 'evt-1');
    assert.equal(plugin.acks.at(-1).overlayOpened, true);
    opened.unregister();
    await tick(5);
    plugin.tap('locate', 'evt-2');
    await tick(30);
    assert.equal(plugin.acks.at(-1).overlayOpened, false);
    // 重复事件只处理一次
    const before = plugin.acks.length;
    plugin.tap('locate', 'evt-2');
    await tick(30);
    assert.equal(plugin.acks.length, before);
    // 非白名单动作被忽略
    plugin.tap('rm -rf', 'evt-3');
    await tick(30);
    assert.equal(plugin.acks.length, before);

    // 会话丢失（原生健康超时已自行收起）→ 立即恢复 Web
    plugin.emit('sessionLost', { sessionId: plugin.state.session, reason: 'heartbeat-timeout' });
    assert.equal(session.mode, 'web');
    await session.stop();
    assert.equal(getOverlayEntries().length, 0);
}

// ---- v3 原生搜索栏：状态清洗、随快照下发、输入事件只接受当前会话与白名单类型 ----
{
    assert.deepEqual(sanitizeSearch(undefined), { expanded: false, placeholder: '搜索', hint: '', busyLabel: '', busy: false, text: '', textVersion: 0, focusToken: 0, focus: false });
    const clean = sanitizeSearch({ expanded: 1, text: 'x'.repeat(300), textVersion: -3, focusToken: 2.5, placeholder: 'p'.repeat(80), token: 'secret' });
    assert.equal(clean.expanded, true);
    assert.equal(clean.text.length, 100);
    assert.equal(clean.placeholder.length, 40);
    assert.equal(clean.textVersion, 0);
    assert.equal(clean.focusToken, 0);
    assert.equal('token' in clean, false);

    const plugin = new FakePlugin();
    const events = [];
    const session = new NativeMapChromeSession({
        ownerId: 'map-search', plugin, available: true,
        timing: { selfHideMs: 30, retryMs: 10000, handshakeMs: 200 },
        onAction: () => true, onModeChange: () => { }, onSearch: (event) => events.push(event)
    });
    const search = { expanded: true, text: '火锅', textVersion: 3, focusToken: 1, focus: true, busy: false, placeholder: '搜店名', hint: '输入和回车搜索已收录地点', busyLabel: '查找未收录地点' };
    assert.equal(await session.start({ items, search }), true);
    await session.activate();
    assert.deepEqual(plugin.state.search, { ...search });
    session.update({ items, search: { ...search, busy: true } });
    await tick(5);
    assert.equal(plugin.state.search.busy, true);

    plugin.search('input', { text: '火锅店' });
    plugin.search('submit', { text: '火锅店' });
    plugin.search('focus', { focused: 1, text: '火锅店' });
    plugin.search('close');
    assert.deepEqual(events, [
        { type: 'input', text: '火锅店' },
        { type: 'submit', text: '火锅店' },
        { type: 'focus', focused: true, text: '火锅店' },
        { type: 'close' }
    ]);
    plugin.search('eval', { text: 'x' });
    plugin.emit('search', { sessionId: 'old', ownerId: 'map-search', type: 'input', text: 'stale' });
    plugin.emit('search', { sessionId: plugin.state.session, ownerId: 'other', type: 'input', text: 'other' });
    plugin.search('input', { text: 'y'.repeat(500) });
    assert.equal(events.length, 5, '非白名单、旧会话、其他所有者的事件被忽略');
    assert.equal(events.at(-1).text.length, 100);
    await session.stop();
    plugin.search('input', { text: 'after-stop' });
    assert.equal(events.length, 5, '会话结束后不再处理');
}

// ---- v4 原生面板：快照清洗、随状态下发、事件只接受当前会话与白名单 ----
{
    assert.equal(sanitizeSheet(null), null);
    assert.equal(sanitizeSheet({ id: 'evil', title: 'x' }), null, '非白名单面板不下发');
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `place-${i}`, title: `店 ${i}`, longitude: 113.7, latitude: 23.0 }));
    const clean = sanitizeSheet({
        id: 'favorites', token: 7, title: 't'.repeat(100), size: 'list', messageTone: 'boom',
        sections: [{ id: 'places', style: 'weird', rows: [...many, { id: 'place-1', title: 'dup' }, { title: 'no id' }] }]
    });
    assert.equal(clean.token, 7);
    assert.equal(clean.title.length, 60);
    assert.equal(clean.size, 'list');
    assert.equal(clean.messageTone, undefined);
    assert.equal(clean.sections[0].style, 'list');
    assert.equal(clean.sections[0].rows.length, 300, '行数封顶');
    assert.equal('longitude' in clean.sections[0].rows[0], false, '不向原生传地点坐标');
    assert.equal(new Set(clean.sections[0].rows.map((row) => row.id)).size, 300, '行 id 去重');
    assert.equal(sanitizeSheet({ id: 'account', sections: [{ rows: [{ id: 'x', tone: 'evil' }] }] }).sections[0].rows[0].tone, undefined);
    assert.equal(sanitizeSheet({ id: 'more', title: '更多功能' }), null, 'v6 起“更多”不再是面板');

    // v6 地点卡片：两段停靠（card）、左上角圆钮、操作按钮封顶 6 个、keepsOpen / expands 透传、正文与地址截断、图片只收 https
    const place = sanitizeSheet({
        id: 'place', token: 3, title: '老码头火锅', size: 'card', detail: 'd'.repeat(2600), caption: 'a'.repeat(300),
        leading: { id: 'favorite', title: '收藏', symbol: 'heart.fill', tone: 'accent', keepsOpen: true, latitude: 1 },
        actions: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, title: `操作${i}`, tone: i === 0 ? 'accent' : undefined, keepsOpen: true, expands: i === 3, latitude: 1 })),
        gallery: [
            { id: 'exterior', title: '外观', images: ['https://img.example.com/a.jpg', 'http://img.example.com/b.jpg', 'javascript:alert(1)', 'https://user:pw@img.example.com/c.jpg', 'capacitor://localhost/x.png', ...Array.from({ length: 20 }, (_, i) => `https://img.example.com/${i}.jpg`)] },
            { id: 'menu', title: '菜单', images: ['http://only-http.example.com/m.jpg'] },
            { id: 'x1', images: ['https://a.example.com/1.jpg'] }, { id: 'x2', images: ['https://a.example.com/2.jpg'] },
            { id: 'x3', images: ['https://a.example.com/3.jpg'] }, { id: 'x4', images: ['https://a.example.com/4.jpg'] }
        ]
    });
    assert.equal(place.size, 'card');
    assert.equal(place.detail.length, 2000);
    assert.equal(place.caption.length, 200);
    assert.deepEqual(place.leading, { id: 'favorite', title: '收藏', subtitle: undefined, symbol: 'heart.fill', tone: 'accent', disabled: false, keepsOpen: true, expands: false });
    assert.equal(place.actions.length, 6);
    assert.equal(place.actions[0].tone, 'accent');
    assert.equal(place.actions.every((action) => action.keepsOpen), true);
    assert.deepEqual(place.actions.map((action) => action.expands), [false, false, false, true, false, false]);
    assert.equal('latitude' in place.actions[0], false);
    assert.equal(place.gallery[0].images[0], 'https://img.example.com/a.jpg');
    assert.equal(place.gallery[0].images.length, 12, '每组最多 12 张');
    assert.equal(place.gallery[0].images.every((url) => url.startsWith('https://') && !url.includes('@')), true, '只收不带凭据的 https 图片');
    assert.deepEqual(place.gallery.map((group) => group.id), ['exterior', 'x1', 'x2'], '没有有效图片的组被丢弃，最多 4 组');
    assert.deepEqual(place.gallery[1].thumbnails, ['https://a.example.com/1.jpg'], '未给缩略图时回退为原图');

    // 缩略图与原图逐项对应：原图无效的项连同缩略图一起丢弃，缩略图无效时回退为原图
    const thumbs = sanitizeSheet({
        id: 'place', size: 'card',
        gallery: [{ id: 'exterior', images: ['https://img.example.com/a.jpg', 'http://bad/b.jpg', 'https://img.example.com/c.jpg', 'https://img.example.com/d.jpg'], thumbnails: ['https://img.example.com/a.jpg?x-oss-process=t', 'https://img.example.com/b.jpg?x-oss-process=t', 'javascript:alert(1)'] }]
    }).gallery[0];
    assert.deepEqual(thumbs.images, ['https://img.example.com/a.jpg', 'https://img.example.com/c.jpg', 'https://img.example.com/d.jpg']);
    assert.deepEqual(thumbs.thumbnails, ['https://img.example.com/a.jpg?x-oss-process=t', 'https://img.example.com/c.jpg', 'https://img.example.com/d.jpg']);
    assert.equal(sanitizeSheet({ id: 'place', size: 'huge' }).size, 'fit');
    // 条件行（cond && {...}）为 false / null 时直接跳过，不能变成 id 为 "false" 的按钮
    assert.deepEqual(
        sanitizeSheet({ id: 'place', size: 'card', actions: [{ id: 'navigate', title: '导航' }, false, null, 0, 'oops', { id: 'details', title: '详情' }] }).actions.map((action) => action.id),
        ['navigate', 'details']
    );
    assert.equal(sanitizeSheet({ id: 'account' }).leading, undefined);
    assert.deepEqual(sanitizeSheet({ id: 'account' }).actions, []);
    assert.deepEqual(sanitizeSheet({ id: 'account' }).gallery, []);
    assert.equal('interactive' in sanitizeSheet({ id: 'place', interactive: true }), false, 'v6 由 card 决定地图是否可操作');

    // v7 展会卡片：标题左侧图标只收 https，分段正文最多 4 段、空段丢弃、截断
    assert.equal(NATIVE_CHROME_PROTOCOL, 7);
    const exhibition = sanitizeSheet({
        id: 'exhibition', token: 2, title: '秋日展会', size: 'card', image: 'https://cdn.example.com/icon.png',
        paragraphs: [
            { id: 'description', title: '展会简介', text: 's'.repeat(2600) },
            { id: 'empty', title: '空', text: '   ' },
            false,
            { title: 't'.repeat(60), text: '上海 · 周六' },
            { id: 'p3', text: '3' }, { id: 'p4', text: '4' }, { id: 'p5', text: '5' }
        ]
    });
    assert.equal(exhibition.id, 'exhibition');
    assert.equal(exhibition.image, 'https://cdn.example.com/icon.png');
    assert.deepEqual(exhibition.paragraphs.map((p) => p.id), ['description', 'paragraph-3', 'p3', 'p4']);
    assert.equal(exhibition.paragraphs[0].text.length, 2000);
    assert.equal(exhibition.paragraphs[1].title.length, 40);
    for (const image of ['http://cdn.example.com/icon.png', 'capacitor://localhost/favicon.png', '/uploads/a.png', 'https://u:p@cdn.example.com/a.png']) {
        assert.equal(sanitizeSheet({ id: 'exhibition', image }).image, undefined, `不下发 ${image}`);
    }
    assert.deepEqual(sanitizeSheet({ id: 'place' }).paragraphs, []);

    // v6 更多功能（工具栏上滑）：没有可显示的行时不下发，行数封顶
    assert.equal(sanitizeDrawer(null), null);
    assert.equal(sanitizeDrawer({ sections: [{ id: 'actions', rows: [] }] }), null);
    const drawer = sanitizeDrawer({
        sections: [
            { id: 'actions', title: '更多功能', rows: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, title: `功能${i}`, run: () => { } })) },
            { id: 'about', style: 'footnote', footer: 'v2', rows: [{ id: 'icp', title: '备案', url: 'https://beian.example.com' }] }
        ]
    });
    assert.equal(drawer.sections[0].title, '更多功能');
    assert.equal(drawer.sections[0].rows.length + drawer.sections[1].rows.length, 40, '行数封顶');
    assert.equal('run' in drawer.sections[0].rows[0], false, '不向原生传函数或链接');
    assert.equal(drawer.sections[1].style, 'footnote');

    const plugin = new FakePlugin();
    const events = [];
    const drawerEvents = [];
    const session = new NativeMapChromeSession({
        ownerId: 'map-sheet', plugin, available: true,
        timing: { selfHideMs: 30, retryMs: 10000, handshakeMs: 200 },
        onAction: () => true, onModeChange: () => { }, onSheet: (event) => events.push(event),
        onDrawer: (event) => drawerEvents.push(event)
    });
    assert.equal(await session.start({ items }), true);
    await session.activate();
    assert.equal(plugin.state.sheet, null, '没有面板时下发 null');
    assert.equal(plugin.state.drawer, null, '没有更多功能时下发 null');
    session.update({
        items,
        sheet: { id: 'account', token: 2, title: '住民', sections: [{ id: 'account', rows: [{ id: 'settings', title: '设置', symbol: 'gear' }] }] },
        drawer: { sections: [{ id: 'actions', rows: [{ id: 'random', title: '随机美食', symbol: 'dice' }] }] }
    });
    await tick(5);
    assert.equal(plugin.state.sheet.id, 'account');
    assert.equal(plugin.state.sheet.sections[0].rows[0].symbol, 'gear');
    assert.equal(plugin.state.drawer.sections[0].rows[0].symbol, 'dice');

    const emitSheet = (extra) => plugin.emit('sheet', { sessionId: plugin.state.session, ownerId: 'map-sheet', ...extra });
    emitSheet({ type: 'select', sheetId: 'account', token: 2, rowId: 'settings' });
    emitSheet({ type: 'dismiss', sheetId: 'account', token: 2 });
    emitSheet({ type: 'select', sheetId: 'account', token: 2 });
    emitSheet({ type: 'run', sheetId: 'account', token: 2, rowId: 'settings' });
    emitSheet({ type: 'select', sheetId: 'admin', token: 2, rowId: 'x' });
    emitSheet({ type: 'select', sheetId: 'more', token: 2, rowId: 'random' });
    plugin.emit('sheet', { sessionId: 'old', ownerId: 'map-sheet', type: 'dismiss', sheetId: 'account', token: 2 });
    assert.deepEqual(events, [
        { type: 'select', sheetId: 'account', token: 2, rowId: 'settings' },
        { type: 'dismiss', sheetId: 'account', token: 2 }
    ], '缺行 id、未知类型、非白名单面板、旧会话的事件被忽略');

    const emitDrawer = (extra) => plugin.emit('drawer', { sessionId: plugin.state.session, ownerId: 'map-sheet', ...extra });
    emitDrawer({ type: 'select', rowId: 'random' });
    emitDrawer({ type: 'select' });
    emitDrawer({ type: 'expand', rowId: 'random' });
    emitDrawer({ type: 'select', rowId: 'r'.repeat(100) });
    plugin.emit('drawer', { sessionId: 'old', ownerId: 'map-sheet', type: 'select', rowId: 'random' });
    plugin.emit('drawer', { sessionId: plugin.state.session, ownerId: 'other', type: 'select', rowId: 'random' });
    assert.deepEqual(drawerEvents, [
        { type: 'select', rowId: 'random' },
        { type: 'select', rowId: 'r'.repeat(64) }
    ], '缺行 id、未知类型、旧会话、其他所有者的更多功能事件被忽略');
    await session.stop();
    emitDrawer({ type: 'select', rowId: 'random' });
    assert.equal(drawerEvents.length, 2, '会话结束后不再处理');
}

// ---- 能力不足 / 协议不符 / 没有布局：保持 Web，不留下原生会话 ----
for (const options of [{ glass: false }, { protocol: 1 }, { protocol: 2 }, { protocol: 3 }, { protocol: 4 }, { protocol: 5 }, { protocol: 999 }, { noLayout: true }]) {
    const plugin = new FakePlugin(options);
    const { session, modes } = makeSession(plugin);
    assert.equal(await session.start({ items }), false, JSON.stringify(options));
    assert.deepEqual(modes, []);
    assert.equal(session.mode, 'web');
    assert.equal(plugin.state.session, null, '握手失败后原生会话被销毁');
    await session.stop();
}

// ---- 运行中故障：确认原生已隐藏后才恢复 Web ----
{
    const plugin = new FakePlugin({ deadDispose: true });
    const { session, modes } = makeSession(plugin);
    assert.equal(await session.start({ items }), true);
    await session.activate();
    plugin.options.deadHeartbeat = true;
    session._heartbeat();
    await tick(5);
    assert.equal(session.mode, 'native', 'dispose 无回执时不能立刻恢复 Web');
    await tick(1700); // CALL_TIMEOUT (1.5s) + selfHide (30ms)
    assert.equal(session.mode, 'web');
    assert.deepEqual(modes, ['native', 'web']);
    await session.stop();
}

// ---- 真实 @capacitor/core 插件代理：代理对 then 也返回方法，不能直接作为 Promise 结果 ----
// （曾导致真机上 await loadPlugin() 永远挂起、始终停在网页工具栏；上面的用例注入假插件，测不到这条路径）
{
    const plugin = new FakePlugin();
    globalThis.webkit = { messageHandlers: { bridge: { postMessage() { } } } };
    const promiseMethods = ['capabilities', 'attach', 'setState', 'ackAction', 'suspend', 'resume', 'heartbeat', 'dispose', 'removeAllListeners'];
    globalThis.Capacitor = {
        PluginHeaders: [{
            name: 'NativeMapChrome',
            methods: [...promiseMethods.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener' }, { name: 'removeListener' }]
        }],
        nativePromise: (pluginName, method, options) => plugin[method](options),
        nativeCallback: (pluginName, method, options, callback) => {
            if (method === 'addListener') plugin.addListener(options.eventName, callback);
            return `cb-${options && options.eventName}`;
        }
    };
    const { getNativeChromeStatus } = await import("../../../src/platform/nativeMapChrome.js");
    const { session, modes } = makeSession(null);
    const result = await Promise.race([session.start({ items }), tick(3000).then(() => 'hang')]);
    assert.equal(result, true, '通过真实插件代理握手不能挂起');
    assert.deepEqual(modes, ['native']);
    assert.equal(getNativeChromeStatus().state, 'native');
    await session.activate();
    assert.equal(plugin.state.visible, true);
    await session.stop();
}

// ---- 握手失败会记录原因并退避重试 ----
{
    const { getNativeChromeStatus } = await import("../../../src/platform/nativeMapChrome.js");
    const plugin = new FakePlugin({ noLayout: true });
    const session = new NativeMapChromeSession({
        ownerId: 'map-retry', plugin, available: true,
        timing: { selfHideMs: 30, retryMs: 20, handshakeMs: 30 },
        onAction: () => true, onModeChange: () => { }
    });
    assert.equal(await session.start({ items }), false);
    assert.equal(getNativeChromeStatus().state, 'web');
    assert.match(getNativeChromeStatus().reason, /^layout:/);
    assert.equal(getNativeChromeStatus().retrying, true);
    plugin.options.noLayout = false;
    await tick(120); // 第一次重试在 20ms 后
    assert.equal(session.mode, 'native', '原生恢复后自动重试成功');
    assert.equal(getNativeChromeStatus().state, 'native');
    await session.stop();

    // 不支持的设备：记录原因，不重试
    const old = new FakePlugin({ glass: false });
    const s2 = new NativeMapChromeSession({ ownerId: 'map-old', plugin: old, available: true, timing: { retryMs: 5 }, onAction: () => true, onModeChange: () => { } });
    assert.equal(await s2.start({ items }), false);
    assert.equal(getNativeChromeStatus().state, 'unsupported');
    await tick(30);
    assert.equal(old.calls.filter((c) => c === 'attach').length, 0);
    await s2.stop();
}

console.log('native chrome tests passed');
