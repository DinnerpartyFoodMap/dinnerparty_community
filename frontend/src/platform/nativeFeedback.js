// iOS 原生反馈页（NativeFeedbackPlugin.swift）的网页侧会话。
// 网页下发类型、上限与文案；原生页里填写、选图都在 SwiftUI 完成，点提交时经 feedbackEvent 把输入交回网页，
// 网页发出请求后按 requestId 用 respond 回传结果。原生结束时 open 返回 { id, action: 'submitted' | 'cancel' }。
const ACTIONS = new Set(['submitted', 'cancel']);
// 原生按 2048 长边、JPEG 0.85 编码，单张通常 1MB 以内；这里留足余量，同时挡住异常大的数据
export const MAX_NATIVE_IMAGE_BASE64 = 8_000_000;
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

/** 只保留白名单字段：类型须在下发的类型里，内容截到上限，图片是不超过张数与大小的 base64 字符串；不合法时返回 null */
export function pickSubmission(values, { types, limits }) {
    if (!values || typeof values !== 'object') return null;
    const type = clip(values.type, 32);
    if (!types.includes(type)) return null;
    const content = clip(values.content, limits.contentLength + 100).trim().slice(0, limits.contentLength);
    if (!content) return null;
    const images = Array.isArray(values.images) ? values.images : [];
    if (images.length > limits.images) return null;
    if (images.some((image) => typeof image !== 'string' || !image || image.length > MAX_NATIVE_IMAGE_BASE64)) return null;
    return { type, content, images };
}

// 每次打开都有独立 id：关闭旧页面不会收起新页面，异步完成后不再处理已经离开的页面。
export function createNativeFeedbackSession(plugin, snapshot, { types, limits, onSubmit, onFinish, onError, retryDelay = 100 }) {
    const id = `feedback-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id || event.type !== 'submit') return;
        const requestId = clip(event.requestId, 64);
        if (!requestId) return;
        const values = pickSubmission(event.values, { types, limits });
        let result;
        try {
            result = values ? await onSubmit(values) : { ok: false, message: '' };
        } catch (error) {
            result = { ok: false, message: error?.message || '' };
        }
        if (stopped) return;
        try {
            await plugin.respond?.({ id, requestId, ok: !!result?.ok, message: String(result?.message || '').slice(0, 200) });
        } catch { /* 原生页已关闭 */ }
    };

    return {
        async start() {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('feedbackEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                // “更多功能”抽屉或其他系统面板可能还在退场，等呈现器空出来再打开
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !ACTIONS.has(result?.action)) throw new Error('Feedback presentation ended');
                onFinish(result.action);
            } catch (error) {
                removeListener();
                if (!stopped) onError(error);
            }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页面板 */ }
        }
    };
}
