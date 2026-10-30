// iOS 原生日记 · 同好（NativeJourneyPlugin.swift）的网页侧会话。
// 网页构建页面模型并执行请求；原生回传动作 / 筛选 / 表单值 / 图片请求，网页按 requestId 回传新页面。
// 生成任务的进度由网页通过 update 主动推送到原生。
export const JOURNEY_ACTIONS = Object.freeze(['close']);
const EVENTS = ['action', 'filter', 'submit', 'back'];
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

export function createNativeJourneySession(plugin, snapshot, { onEvent, onLoadImage, onClose, onError, retryDelay = 100 }) {
    const id = `journey-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;
    let closingForNavigation = false;
    let sequenceNo = 0;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    const respond = async (requestId, result, seq) => {
        if (stopped) return;
        const payload = {
            id,
            requestId,
            seq,
            ok: !result?.error,
            message: String(result?.message || '').slice(0, 240),
            error: String(result?.error || '').slice(0, 240)
        };
        if (result?.page && typeof result.page === 'object') payload.page = result.page;
        if (result?.form && typeof result.form === 'object') payload.form = result.form;
        if (result?.imageId) payload.imageId = result.imageId;
        if (result?.imageData) payload.imageData = result.imageData;
        try { await plugin.respond?.(payload); } catch { /* 原生页已关闭 */ }
    };

    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id) return;
        const requestId = clip(event.requestId, 64);
        if (!requestId) return;
        const seq = ++sequenceNo;
        let result;
        try {
            if (event.type === 'loadImage') {
                const imageId = clip(event.imageId, 64);
                result = imageId ? await onLoadImage?.(imageId) : { error: '' };
            } else if (EVENTS.includes(event.type)) {
                result = await onEvent?.(event.type, event);
            } else {
                return;
            }
        } catch (error) {
            result = { error: error?.message || '' };
        }
        await respond(requestId, result || {}, seq);
        if (result?.close) {
            closingForNavigation = true;
            try { await plugin.close?.({ id }); } catch { /* 已关闭 */ }
        }
    };

    return {
        id,
        async start(page) {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('journeyEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, page, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise((resolve) => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !JOURNEY_ACTIONS.includes(result?.action)) throw new Error('Journey presentation ended');
                if (!closingForNavigation) onClose?.();
            } catch (error) {
                removeListener();
                if (!stopped) onError?.(error);
            }
        },
        async update(page) {
            if (stopped || !page) return;
            try { await plugin.update?.({ id, page, seq: ++sequenceNo }); } catch { /* 原生页已关闭 */ }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页日记 */ }
        }
    };
}
