// iOS 原生住民主页（NativeProfilePlugin.swift）的网页侧会话。
// 网页取 profile、执行屏蔽 / 偏好 / 小组件请求；原生只显示网页整理好的文案与雷达数据。
// 原生经 profileEvent 发来请求，网页按 requestId 用 respond 回传最新视图模型（profile / community / companion）。
// 2026-11-20 起同好、小伙伴与同好点开的其他住民主页都是原生主页里推入的二级页（不再先关闭主页）：
// loadProfile 读取页面栈里别的住民（values.userId），loadCommunity* / saveCommunitySettings / clearInteractions 驱动同好页，
// loadCompanion / setCompanionEnabled / chooseCompanion 驱动小伙伴，openSettings 让网页在主页之上打开原生住民设置。
// openCommunity / settings / companion 三个结束动作只留给旧安装包。
// companionName / companionEdit：原生小伙伴页的“起名”“编辑”，收起主页后在网页小伙伴页里填（表单只在网页）
export const PROFILE_ACTIONS = Object.freeze(['back', 'openPlace', 'openCommunity', 'openFavorites', 'my-locations', 'settings', 'companion', 'companionName', 'companionEdit', 'logout']);
export const PROFILE_EVENTS = Object.freeze([
    'setTasteLevel', 'saveWidgets', 'setBlocked', 'setCollectionVisibility', 'reload',
    'loadProfile', 'loadCommunity', 'loadCommunitySettings', 'saveCommunitySettings', 'clearInteractions',
    'loadCompanion', 'setCompanionEnabled', 'chooseCompanion', 'openSettings', 'roomNavigate', 'loadRoom', 'reportUser'
]);
const TASTE_AXES = ['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign'];
const WIDGET_KINDS = ['collection', 'recent', 'favorite'];
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

/** 只保留白名单字段；level 为 1–4 或 null（回到自动推断）。 */
export function pickNativeProfileValues(type, values) {
    if (!values || typeof values !== 'object') return null;
    if (type === 'setTasteLevel') {
        const key = clip(values.key, 24);
        if (!TASTE_AXES.includes(key)) return null;
        if (values.level === null || values.level === undefined) return { key, level: null };
        const level = Number(values.level);
        if (!Number.isInteger(level) || level < 1 || level > 4) return null;
        return { key, level };
    }
    if (type === 'saveWidgets') {
        const widgets = (Array.isArray(values.widgets) ? values.widgets : [])
            .filter((kind) => WIDGET_KINDS.includes(kind))
            .slice(0, 3);
        if (widgets.length < 1) return null;
        if (values.hiddenWidgets === undefined) return { widgets };
        if (!Array.isArray(values.hiddenWidgets) || values.hiddenWidgets.some((kind) => kind !== 'recent' && kind !== 'favorite')) return null;
        // “我创建的地点”不能关闭：旧安装包仍可能发来 recent，丢掉
        const hiddenWidgets = ['favorite'].filter((kind) => values.hiddenWidgets.includes(kind));
        return { widgets, hiddenWidgets };
    }
    if (type === 'setBlocked') {
        if (typeof values.blocked !== 'boolean') return null;
        // 页面栈里别的住民：带上对方编号；不带时是会话打开的那位
        // report: false 时只屏蔽不打开举报（小伙伴页的「屏蔽这位住民」）；不带时照旧屏蔽后打开举报
        const report = values.report === false ? { report: false } : {};
        if (values.userId === undefined) return { blocked: values.blocked, ...report };
        const userId = clip(values.userId, 64);
        return userId ? { blocked: values.blocked, userId, ...report } : null;
    }
    if (type === 'setCollectionVisibility') {
        return typeof values.isPublic === 'boolean' ? { isPublic: values.isPublic } : null;
    }
    if (type === 'loadProfile') {
        const userId = clip(values.userId, 64);
        return userId ? { userId } : null;
    }
    if (type === 'saveCommunitySettings') {
        if (['discovery', 'feedback', 'research'].some((key) => typeof values[key] !== 'boolean')) return null;
        if (values.tags !== undefined && typeof values.tags !== 'string') return null;
        return {
            discovery: values.discovery,
            feedback: values.feedback,
            research: values.feedback && values.research,
            tags: clip(values.tags, 500),
            researchChoice: values.researchChoice === true
        };
    }
    if (type === 'setCompanionEnabled') {
        return typeof values.enabled === 'boolean' ? { enabled: values.enabled } : null;
    }
    if (type === 'roomNavigate') {
        // 翻日期、切筛选：date 为空是今天
        const date = values.date === undefined || values.date === null || values.date === '' ? null : clip(values.date, 10);
        if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const filter = values.filter === undefined ? 'all' : clip(values.filter, 16);
        if (!['all', 'moments', 'meets'].includes(filter)) return null;
        return { date, filter };
    }
    if (type === 'loadRoom') {
        // 别人的小伙伴：userId 必填，date 为空是今天
        const userId = clip(values.userId, 64);
        if (!userId || !/^[A-Za-z0-9-]+$/.test(userId)) return null;
        const date = values.date === undefined || values.date === null || values.date === '' ? null : clip(values.date, 10);
        if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const filter = values.filter === undefined ? 'all' : clip(values.filter, 16);
        if (!['all', 'moments', 'meets'].includes(filter)) return null;
        return { userId, date, filter };
    }
    if (type === 'reportUser') {
        const userId = clip(values.userId, 64);
        return userId && /^[A-Za-z0-9-]+$/.test(userId) ? { userId, name: clip(values.name, 64) } : null;
    }
    if (type === 'chooseCompanion') {
        const id = clip(values.id, 64);
        return id ? { id } : null;
    }
    if (['reload', 'loadCommunity', 'loadCommunitySettings', 'clearInteractions', 'loadCompanion', 'openSettings'].includes(type)) return {};
    return null;
}

/** 回传原生的视图模型：只转发这几个对象 */
const RESPONSE_MODELS = ['profile', 'community', 'companion', 'room'];

// 每次打开都有独立 id：关闭旧主页不会收起新主页，异步完成后不再处理已经离开的主页。
export function createNativeProfileSession(plugin, snapshot, { onEvent, onBack, onOpenPlace, onOpenCommunity, onAction, onError, retryDelay = 100 }) {
    const id = `profile-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id) return;
        const requestId = clip(event.requestId, 64);
        if (!requestId || !PROFILE_EVENTS.includes(event.type)) return;
        const values = pickNativeProfileValues(event.type, event.values);
        if (!values) return;
        let result;
        try {
            result = await onEvent?.(event.type, values);
        } catch (error) {
            result = { ok: false, message: error?.message || '' };
        }
        if (stopped) return;
        const payload = {
            id,
            requestId,
            ok: !!result?.ok,
            message: String(result?.message || '').slice(0, 200)
        };
        for (const key of RESPONSE_MODELS) {
            if (result?.[key] && typeof result[key] === 'object') payload[key] = result[key];
        }
        try { await plugin.respond?.(payload); } catch { /* 原生主页已关闭 */ }
    };

    return {
        id,
        async start() {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('profileEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                // 设置页或地点卡片可能还在退场，等呈现器空出来再打开
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise((resolve) => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !PROFILE_ACTIONS.includes(result?.action)) throw new Error('Profile presentation ended');
                if (result.action === 'openPlace') {
                    const placeId = clip(result.values && result.values.placeId, 64);
                    if (placeId) onOpenPlace?.(placeId);
                    else onBack?.();
                } else if (result.action === 'openCommunity') {
                    onOpenCommunity?.();
                } else if (result.action === 'back') {
                    onBack?.();
                } else {
                    // 页面栈里别的住民的“查看全部”带上对方编号
                    const userId = clip(result.values && result.values.userId, 64);
                    onAction?.(result.action, userId ? { userId } : {});
                }
            } catch (error) {
                removeListener();
                if (!stopped) onError?.(error);
            }
        },
        /**
         * 打开后才读到的主页数据（profile）或读取失败的原因（error）；
         * 打开期间主题（theme：住民设置里改了明暗 / 主题色）或小伙伴状态（companion）变化时也经这里推给原生。
         */
        async update({ profile, error, theme, companion } = {}) {
            if (stopped) return;
            const payload = { id };
            if (profile && typeof profile === 'object') payload.profile = profile;
            else if (error !== undefined) payload.error = String(error || '').slice(0, 200);
            if (theme && typeof theme === 'object') payload.theme = theme;
            if (companion && typeof companion === 'object') payload.companion = companion;
            if (Object.keys(payload).length === 1) return;
            try { await plugin.update?.(payload); } catch { /* 原生主页已关闭 */ }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页主页 */ }
        }
    };
}
