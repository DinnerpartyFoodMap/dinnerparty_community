// iOS 原生“顺路吃”面板（NativeAlongRoutePlugin.swift）的网页侧会话。
// 网页下发标签、出行方式、距离档位与全部文案；原生只收集条件并显示结果。
// 原生经 alongRouteEvent 发来 submit / chooseRoute，网页解析行程、规划路线、在地图上画线并查询沿途地点，
// 再按 requestId 用 respond 回传网页格式化好的 state。关闭时 open 返回 { id, action }。
export const ALONG_ROUTE_ACTIONS = Object.freeze(['close', 'select']);
export const ALONG_ROUTE_EVENTS = Object.freeze(['submit', 'chooseRoute']);
const MODES = ['driving', 'transit', 'walking', 'riding'];
const CORRIDORS = [500, 1000, 2000, 3000];
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

/** 只保留白名单字段并截到上限；URL 必须是高德分享链接或普通 http(s) 地址。 */
export function pickNativeAlongRouteValues(values) {
    if (!values || typeof values !== 'object') return null;
    const url = clip(values.url, 2048).trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const corridor = Number(values.corridorMeters);
    return {
        url,
        mode: MODES.includes(values.mode) ? values.mode : 'driving',
        query: clip(values.query, 100).trim(),
        categories: (Array.isArray(values.categories) ? values.categories : [])
            .filter((name) => typeof name === 'string' && name.trim())
            .map((name) => name.trim().slice(0, 24))
            .slice(0, 12),
        corridorMeters: CORRIDORS.includes(corridor) ? corridor : 1000
    };
}

// 每次打开都有独立 id：关闭旧面板不会收起新面板，异步完成后不再处理已经离开的面板。
export function createNativeAlongRouteSession(plugin, snapshot, { onSubmit, onChooseRoute, onSelectPlace, onClose, onError, retryDelay = 100 }) {
    const id = `along-route-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    const respond = async (requestId, result) => {
        if (stopped) return;
        const payload = {
            id,
            requestId,
            ok: !!result?.ok,
            message: String(result?.message || '').slice(0, 200)
        };
        if (result?.state && typeof result.state === 'object') payload.state = result.state;
        try { await plugin.respond?.(payload); } catch { /* 原生面板已关闭 */ }
    };

    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id) return;
        const requestId = clip(event.requestId, 64);
        if (!requestId || !ALONG_ROUTE_EVENTS.includes(event.type)) return;
        const values = pickNativeAlongRouteValues(event.values);
        if (!values) return;
        let result;
        try {
            if (event.type === 'submit') {
                result = await onSubmit?.(values);
            } else {
                const index = Number(event.values && event.values.index);
                if (!Number.isInteger(index) || index < 0 || index > 5) return;
                result = await onChooseRoute?.(index, values);
            }
        } catch (error) {
            result = { ok: false, message: error?.message || '' };
        }
        await respond(requestId, result || { ok: false, message: '' });
    };

    return {
        id,
        async start() {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('alongRouteEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                // 地点卡片等系统面板可能还在退场，等呈现器空出来再打开
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise((resolve) => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !ALONG_ROUTE_ACTIONS.includes(result?.action)) throw new Error('Along-route presentation ended');
                if (result.action === 'select') {
                    const placeId = clip(result.values && result.values.placeId, 64);
                    if (placeId) onSelectPlace?.(placeId);
                    else onClose?.();
                } else {
                    onClose?.();
                }
            } catch (error) {
                removeListener();
                if (!stopped) onError?.(error);
            }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包没有插件时使用网页面板 */ }
        }
    };
}
