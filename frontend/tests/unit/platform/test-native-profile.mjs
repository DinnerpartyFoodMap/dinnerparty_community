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
import {
    buildCommunityPeople,
    buildCommunitySettings,
    buildCompanionViewModel,
    communityEmptyState,
    parseCommunityTags
} from '../../../src/profile/communityViewModel.js';

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
    assert.deepEqual(pickNativeProfileValues('saveWidgets', { widgets: ['recent'], hiddenWidgets: ['favorite', 'favorite'] }),
        { widgets: ['recent'], hiddenWidgets: ['favorite'] });
    assert.equal(pickNativeProfileValues('saveWidgets', { widgets: ['recent'], hiddenWidgets: ['collection'] }), null);
    // “我创建的地点”不能关闭：旧安装包发来的 recent 被丢掉
    assert.deepEqual(pickNativeProfileValues('saveWidgets', { widgets: ['recent'], hiddenWidgets: ['recent', 'favorite'] }),
        { widgets: ['recent'], hiddenWidgets: ['favorite'] });
    assert.equal(pickNativeProfileValues('saveWidgets', { widgets: [] }), null);
    assert.deepEqual(pickNativeProfileValues('setBlocked', { blocked: true }), { blocked: true });
    assert.equal(pickNativeProfileValues('setBlocked', { blocked: 'yes' }), null);
    assert.deepEqual(pickNativeProfileValues('setCollectionVisibility', { isPublic: false }), { isPublic: false });
    assert.equal(pickNativeProfileValues('setCollectionVisibility', { isPublic: 'false' }), null);
    assert.equal(pickNativeProfileValues('other', {}), null);
    // 页面栈：同好里点开的住民、同好页与角色观察屋
    assert.deepEqual(pickNativeProfileValues('setBlocked', { blocked: false, userId: 'u-2' }), { blocked: false, userId: 'u-2' });
    assert.equal(pickNativeProfileValues('setBlocked', { blocked: true, userId: '' }), null);
    assert.deepEqual(pickNativeProfileValues('loadProfile', { userId: 'u-2', extra: 1 }), { userId: 'u-2' });
    assert.equal(pickNativeProfileValues('loadProfile', {}), null);
    assert.deepEqual(pickNativeProfileValues('saveCommunitySettings', { discovery: true, feedback: false, research: true, tags: '面食，火锅', researchChoice: true, extra: 1 }),
        { discovery: true, feedback: false, research: false, tags: '面食，火锅', researchChoice: true }, 'research needs feedback');
    assert.equal(pickNativeProfileValues('saveCommunitySettings', { discovery: 'yes', feedback: true, research: true }), null);
    assert.equal(pickNativeProfileValues('saveCommunitySettings', { discovery: true, feedback: true, research: true, tags: 3 }), null);
    assert.equal(pickNativeProfileValues('saveCommunitySettings', { discovery: true, feedback: true, research: true, tags: 'x'.repeat(900) }).tags.length, 500);
    assert.deepEqual(pickNativeProfileValues('setCompanionEnabled', { enabled: false }), { enabled: false });
    assert.equal(pickNativeProfileValues('setCompanionEnabled', { enabled: 0 }), null);
    assert.deepEqual(pickNativeProfileValues('chooseCompanion', { id: 'reimu' }), { id: 'reimu' });
    assert.equal(pickNativeProfileValues('chooseCompanion', { id: '' }), null);
    for (const type of ['loadCommunity', 'loadCommunitySettings', 'clearInteractions', 'loadCompanion', 'openSettings']) {
        assert.deepEqual(pickNativeProfileValues(type, { anything: true }), {}, type);
    }
}

// 同好与角色观察屋的视图模型（网页同好页与原生二级页共用）
{
    const many = Array.from({ length: 25 }, (_, index) => ({
        id: `u${index}`, username: `同好${index}`, similarity: 0.9 - index / 100, confidence: '参考数据较多',
        shared: index ? [] : ['共同标签：面食'], x: index === 1 ? 3 : 0.5, y: -0.2,
        has_avatar: index === 2, avatar_url: index === 2 ? 'https://oss.example.com/a.webp' : null
    }));
    const people = buildCommunityPeople({ neighbors: many }, { backendUrl: 'https://api.example.com' });
    assert.equal(people.length, 20, 'at most 20 residents, no paging');
    assert.equal(people[0].name, '同好0');
    assert.match(people[0].meta, /90%/);
    assert.match(people[0].meta, /共同标签：面食/);
    assert.equal(people[1].x, 1, 'coordinates stay inside the map');
    assert.equal(people[2].avatarURL, 'https://oss.example.com/a.webp');
    assert.equal(people[0].avatarURL, 'https://api.example.com/users/u0/avatar?fallback=default', 'no avatar → server default');
    assert.match(people[0].accessible, /同好0/);
    assert.equal(communityEmptyState({ profile_status: 'disabled' }).action, 'settings');
    assert.equal(communityEmptyState({ profile_status: 'ready' }).action, '');
    assert.ok(communityEmptyState({ profile_status: 'empty' }).title.length > 0);
    assert.deepEqual(parseCommunityTags(' 面食，火锅,, 甜品 '), ['面食', '火锅', '甜品']);
    assert.equal(parseCommunityTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(',')).length, 20);
    const settings = buildCommunitySettings({ discovery: true, feedback: false, research: false, tags: ['面食', '火锅'] }, { retention_days: 90 });
    assert.equal(settings.tags, '面食，火锅');
    assert.match(settings.retention, /90/);
    assert.equal(buildCommunitySettings(null), null);

    const builtIn = buildCompanionViewModel({ active: 'stick-figure', satiety: 3, owned: [{ id: 'reimu', name: '灵梦' }] }, { enabled: true });
    assert.deepEqual(builtIn.roles.map((role) => role.id), ['stick-figure', 'reimu']);
    assert.equal(builtIn.active, 'stick-figure');
    assert.equal(builtIn.name, '饭桶');
    assert.equal(builtIn.satietyCount, 3);
    assert.match(builtIn.satiety, /3/);
    assert.equal(builtIn.preview, 'companions/dinnerparty-bot/preview.png');
    assert.ok(!Object.hasOwn(builtIn, 'credit'));
    const reimu = buildCompanionViewModel({ active: 'reimu', satiety: 0, owned: [{ id: 'reimu', name: '灵梦' }] }, { enabled: false });
    assert.equal(reimu.name, '灵梦');
    assert.equal(reimu.enabled, false);
    assert.equal(reimu.preview, '');
    assert.equal(buildCompanionViewModel({ active: 'gone', owned: [] }).active, 'stick-figure', 'unknown role falls back to the built-in one');
}

// 原生同好页的请求：读取、保存（带版本、整理标签、通知地图）、清除交互记录、失败时页面内显示原因
{
    const sent = [];
    const published = [];
    let consent = { discovery: true, feedback: true, research: true, tags: ['面食'], version: 3 };
    const fakeRequest = async (base, token, path, options = {}) => {
        sent.push([path, options.method || 'GET', options.body ? JSON.parse(options.body) : null, token]);
        if (path === '/api/community/neighbors') return { profile_status: 'ready', neighbors: [{ id: 'u1', username: '同好', similarity: 0.5, shared: [] }] };
        if (path === '/api/community/consent' && options.method === 'PUT') { consent = { ...JSON.parse(options.body), version: 4 }; return consent; }
        if (path === '/api/community/consent') return consent;
        if (path === '/api/community/feedback' && options.method === 'DELETE') return { ...consent, feedback: false, research: false };
        if (path === '/api/community/feedback') return { retention_days: 90 };
        throw new Error(`unexpected ${path}`);
    };
    const { createCommunityController } = await import('../../../src/profile/communityViewModel.js');
    const controller = createCommunityController({
        backendUrl: 'https://api.example.com', getToken: () => 'tok', getUser: () => ({ id: 'me', has_avatar: false }),
        request: fakeRequest, publishMapConsent: (token, value) => published.push([token, value.version])
    });
    const loaded = await controller.load();
    assert.equal(loaded.neighbors.status, 'ready');
    assert.equal(loaded.neighbors.people[0].name, '同好');
    assert.equal(loaded.me.avatarURL, 'https://api.example.com/users/me/avatar?fallback=default');
    assert.equal(loaded.labels.tabSettings.length > 0, true);
    assert.equal((await controller.loadSettings()).settings.tags, '面食');
    const saved = await controller.save({ discovery: false, feedback: false, research: true, tags: ' 火锅，甜品 ', researchChoice: true });
    const put = sent.find(([path, method]) => path === '/api/community/consent' && method === 'PUT')[2];
    assert.deepEqual(put, { discovery: false, feedback: false, research: false, tags: ['火锅', '甜品'], version: 3, research_choice: true });
    assert.deepEqual(published, [['tok', 4]]);
    assert.equal(saved.settings.discovery, false);
    assert.ok(saved.notice.length > 0);
    assert.equal(saved.neighbors.status, 'ready');
    const cleared = await controller.clear();
    assert.equal(cleared.settings.feedback, false);
    assert.equal(published.length, 2);
    const failing = createCommunityController({
        backendUrl: '', getToken: () => 'tok', getUser: () => null,
        request: async () => { throw new Error('计算服务暂不可用'); }, publishMapConsent: () => {}
    });
    assert.deepEqual((await failing.load()).neighbors, { status: 'error', error: '计算服务暂不可用', people: [], empty: null });
}

// 视图模型：六轴按固定顺序补齐、小组件行带评价文案、自己填的选项
{
    assert.equal(profileSelfLevels().length, 4);
    assert.deepEqual(profileWidgetOptions().map((option) => option.id), ['favorite'], 'only 最喜欢 can be hidden');

    const profile = {
        user: { id: 9, username: '幽幽子', has_avatar: true, avatar_url: 'https://oss.example.com/avatars/9-new.webp' },
        relation: { self: true, can_block: false, blocked: false },
        city: '上海',
        widgets: ['collection', 'recent'],
        collection_visibility: false,
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
        backendUrl: 'https://api.example.com/backend/'
    });
    assert.equal(view.name, '幽幽子');
    assert.equal(view.avatarURL, 'https://oss.example.com/avatars/9-new.webp');
    assert.ok(view.city.includes('上海'));
    assert.equal(view.self, true);
    assert.equal(view.canEditTaste, true);
    assert.equal(view.canEditWidgets, true);
    assert.equal(view.axes.length, 6);
    assert.deepEqual(view.axes.map((axis) => axis.key), ['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign']);
    assert.equal(view.axes[0].value, 0.8);
    assert.equal('estimated' in view.axes[1], false);
    assert.equal('evidence' in view.axes[1], false);
    assert.match(view.axes[1].accessible, /一般/);
    assert.doesNotMatch(view.axes[1].accessible, /待了解|不太喜欢/);
    assert.equal(view.axes[2].value, null);
    assert.equal(view.axes[2].label.length > 0, true);
    assert.equal(view.axes[4].selfLevel, 3);
    assert.deepEqual(view.sections.map((section) => section.kind), ['collection', 'recent', 'favorite']);
    assert.equal(view.sections[0].groups[0].rows[0].name, '烧烤');
    assert.equal(view.sections[1].groups[0].rows[0].name, '小面馆');
    assert.ok(view.sections[0].groups[0].rows[0].meta.length > 0);
    assert.ok(view.sections[1].groups[0].rows[0].meta.length > 0);
    assert.equal(view.canOpenCommunity, true);
    assert.equal(view.canOpenFavorites, true);
    assert.equal(view.canOpenLocations, true);
    assert.equal(view.canUseAccountActions, true);
    assert.equal(view.collectionVisibility, false);
    assert.deepEqual(view.widgets, ['recent']);
    assert.equal(view.widgetSlotLabels.length, 1);
    const visitor = buildProfileViewModel({ ...profile, relation: {}, content: { ...profile.content, collection: [] } });
    assert.deepEqual(visitor.sections.map((section) => section.kind), ['recent', 'favorite']);
    assert.equal(visitor.canUseAccountActions, false);
    assert.equal(visitor.collectionVisibility, null);
    const configured = buildProfileViewModel({ ...profile, hidden_widgets: ['favorite', 'favorite'] }, {
        currentUser: { id: 9, rejected_place_count: 2 }, tokenPresent: true
    });
    assert.deepEqual(configured.hiddenWidgets, ['favorite']);
    assert.deepEqual(configured.sections.map((section) => section.kind), ['collection', 'recent']);
    assert.match(configured.labels.rejectedPlaces, /2 个未通过审核/);
    const legacyHidden = buildProfileViewModel({ ...profile, hidden_widgets: ['recent'] }, { currentUser: { id: 9 }, tokenPresent: true });
    assert.deepEqual(legacyHidden.hiddenWidgets, []);
    assert.ok(legacyHidden.sections.some((section) => section.kind === 'recent'), 'created places always show');
    const blocked = buildProfileViewModel({ ...profile, relation: { blocked: true } });
    assert.deepEqual(blocked.sections, []);
    assert.equal(blocked.canOpenFavorites || blocked.canOpenLocations, false);
    assert.ok(view.labels.blockConfirm.includes('幽幽子'));
    assert.ok(view.labels.blockedNote.length > 0);
}

// Valid low estimates (including zero) survive the shared Web/native presentation.
{
    const { normalizeTaste, axisValueWord, axisEvidenceText } = await import('../../../src/profile/tasteAxes.js');
    for (const value of [0, 0.2, 0.49, 0.5, 0.8]) {
        const [axis] = normalizeTaste([{key:'homestyle',value,basis:'embedding',embedding:{shop_count:3,percentile:value}}]);
        assert.equal(axis.value,value);
        assert.doesNotMatch(axisValueWord(axis),/待了解|不太喜欢/);
        if(value<0.6)assert.equal(axisValueWord(axis),'一般');
        assert.match(axisEvidenceText(axis),/3/);
    }
    const [manual] = normalizeTaste([{key:'homestyle',value:1/3,basis:'self',self_level:2}]);
    assert.equal(axisValueWord(manual),'一般');
    assert.equal(normalizeTaste([])[0].value,null);
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

    // 同好、角色观察屋的回传对象原样转给原生；其他字段不转
    plugin.emit('profileEvent', { id: session.id, type: 'loadCommunity', requestId: 'r4', values: {} });
    await tick();
    assert.deepEqual(calls[3], ['loadCommunity', {}]);

    plugin.openResolve({ id: session.id, action: 'openPlace', values: { placeId: 'p2' } });
    await started;
    assert.deepEqual(calls.at(-1), ['place', 'p2']);
}

{
    const plugin = new FakePlugin();
    const session = createNativeProfileSession(plugin, {}, {
        onEvent: async (type) => (type === 'loadCompanion'
            ? { ok: true, companion: { name: '饭桶' }, secret: 'x' }
            : { ok: true, community: { neighbors: { people: [] } } }),
        onBack: () => {}
    });
    const started = session.start();
    await tick();
    plugin.emit('profileEvent', { id: session.id, type: 'loadCompanion', requestId: 'c1', values: {} });
    plugin.emit('profileEvent', { id: session.id, type: 'loadCommunity', requestId: 'c2', values: {} });
    await tick();
    assert.deepEqual(plugin.responded.find((item) => item.requestId === 'c1'), { id: session.id, requestId: 'c1', ok: true, message: '', companion: { name: '饭桶' } });
    assert.deepEqual(plugin.responded.find((item) => item.requestId === 'c2').community, { neighbors: { people: [] } });

    // update：主题、小伙伴单独推送时不能被当成读取失败
    const updates = [];
    plugin.update = async (payload) => { updates.push(payload); };
    await session.update({ theme: { dark: true, primary: '#112233' } });
    await session.update({ companion: { satietyCount: 4 } });
    await session.update({});
    await session.update({ error: 'x' });
    assert.deepEqual(updates, [
        { id: session.id, theme: { dark: true, primary: '#112233' } },
        { id: session.id, companion: { satietyCount: 4 } },
        { id: session.id, error: 'x' }
    ]);
    plugin.openResolve({ id: session.id, action: 'back' });
    await started;
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

// 导航动作与返回分别交给网页路由；页面栈里别的住民的“查看全部”带上对方编号
for (const [action, values, expected] of [
    ['openFavorites', undefined, {}],
    ['my-locations', { userId: 'u-2' }, { userId: 'u-2' }],
    ['settings', undefined, {}],
    ['companion', undefined, {}],
    ['logout', { userId: '' }, {}]
]) {
    const plugin = new FakePlugin();
    const calls = [];
    const session = createNativeProfileSession(plugin, {}, {
        onBack: () => calls.push('back'),
        onAction: (value, extra) => calls.push([value, extra])
    });
    const started = session.start();
    await tick();
    plugin.openResolve({ id: session.id, action, values });
    await started;
    assert.deepEqual(calls, [[action, expected]]);
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
