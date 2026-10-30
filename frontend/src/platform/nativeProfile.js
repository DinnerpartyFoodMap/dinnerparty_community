// iOS 原生住民主页（NativeProfilePlugin.swift）的网页侧会话。
// 网页取 profile、执行屏蔽 / 偏好 / 小组件请求；原生只显示网页整理好的文案与雷达数据。
// 原生经 profileEvent 发来 setTasteLevel / saveWidgets / setBlocked，网页按 requestId 用 respond 回传最新视图模型。
export const PROFILE_ACTIONS = Object.freeze(['back', 'openPlace']);
export const PROFILE_EVENTS = Object.freeze(['setTasteLevel', 'saveWidgets', 'setBlocked']);
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
        return { widgets };
    }
    if (type === 'setBlocked') {
        return typeof values.blocked === 'boolean' ? { blocked: values.blocked } : null;
    }
    return null;
}

// 每次打开都有独立 id：关闭旧主页不会收起新主页，异步完成后不再处理已经离开的主页。
export function createNativeProfileSession(plugin, snapshot, { onEvent, onBack, onOpenPlace, onError, retryDelay = 100 }) {
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
        if (result?.profile && typeof result.profile === 'object') payload.profile = result.profile;
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
                } else {
                    onBack?.();
                }
            } catch (error) {
                removeListener();
                if (!stopped) onError?.(error);
            }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页主页 */ }
        }
    };
}
