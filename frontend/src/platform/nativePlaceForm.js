// iOS 原生添加 / 修改地点表单（NativePlaceFormPlugin.swift）的网页侧会话。
// 网页下发分类目录、评价档位、初始内容与文案；原生里填写、选图都在 SwiftUI 完成。
// 原生经 placeFormEvent 发来三种请求，网页处理后按 requestId 用 respond 回传结果：
//   upload（一张已缩放的 JPEG，base64）→ { ok, url }；submit（填写内容）→ { ok, message }；delete → { ok, message }。
// 原生结束时 open 返回 { id, action: 'submitted' | 'deleted' | 'cancel' | 'pickPosition', values }。
export const PLACE_FORM_ACTIONS = Object.freeze(['submitted', 'deleted', 'cancel', 'pickPosition']);
// 原生按 2560 长边、JPEG 0.88 编码，单张通常 1–2MB；这里留足余量，同时挡住异常大的数据
export const MAX_PLACE_IMAGE_BASE64 = 12_000_000;
const MAX_IMAGES = 50;
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const imageList = (value) => (Array.isArray(value) ? value : [])
    .filter((url) => typeof url === 'string' && /^https?:\/\//.test(url) && url.length <= 2048)
    .slice(0, MAX_IMAGES);

/** 只保留白名单字段并截到上限：店名、分类（逗号分隔）、简介、人均（正整数字符串）、评价（1–4）、两组图片地址 */
export function pickPlaceFormValues(values) {
    if (!values || typeof values !== 'object') return null;
    const cost = clip(values.perPersonCost, 8);
    const rating = Number(values.rating);
    return {
        name: clip(values.name, 120).trim(),
        category: clip(values.category, 240).trim(),
        description: clip(values.description, 1000).trim(),
        perPersonCost: /^[1-9]\d*$/.test(cost) ? cost : '',
        rating: Number.isInteger(rating) && rating >= 1 && rating <= 4 ? rating : null,
        exteriorImages: imageList(values.exteriorImages),
        menuImages: imageList(values.menuImages)
    };
}

// 每次打开都有独立 id：关闭旧表单不会收起新表单，异步完成后不再处理已经离开的表单。
export function createNativePlaceFormSession(plugin, snapshot, { onUpload, onSubmit, onDelete, onFinish, onError, retryDelay = 100 }) {
    const id = `place-form-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    const respond = async (requestId, result) => {
        if (stopped) return;
        try {
            await plugin.respond?.({
                id,
                requestId,
                ok: !!result?.ok,
                message: String(result?.message || '').slice(0, 200),
                ...(result?.url ? { url: String(result.url) } : null)
            });
        } catch { /* 原生表单已关闭 */ }
    };

    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id) return;
        const requestId = clip(event.requestId, 64);
        if (!requestId) return;
        let result;
        try {
            if (event.type === 'upload') {
                const image = typeof event.image === 'string' && event.image && event.image.length <= MAX_PLACE_IMAGE_BASE64 ? event.image : null;
                result = image ? await onUpload(image) : { ok: false, message: '' };
            } else if (event.type === 'submit') {
                const values = pickPlaceFormValues(event.values);
                result = values && values.name ? await onSubmit(values) : { ok: false, message: '' };
            } else if (event.type === 'delete') {
                result = onDelete ? await onDelete() : { ok: false, message: '' };
            } else {
                return;
            }
        } catch (error) {
            result = { ok: false, message: error?.message || '' };
        }
        await respond(requestId, result);
    };

    return {
        id,
        async start() {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('placeFormEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                // 地点卡片等系统面板可能还在退场，等呈现器空出来再打开
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !PLACE_FORM_ACTIONS.includes(result?.action)) throw new Error('Place form presentation ended');
                onFinish(result.action, pickPlaceFormValues(result.values));
            } catch (error) {
                removeListener();
                if (!stopped) onError(error);
            }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页表单 */ }
        }
    };
}
