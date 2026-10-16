const ACTIONS = new Set(['back', 'avatar', 'username', 'password', 'themes', 'personalize', 'logoutAll', 'deleteAccount']);
export const MOTION_KEYS = Object.freeze(['clusterMotion', 'webMotion', 'nativeGlass']);
let sequence = 0;

const clip = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const strings = (fields) => (values) => Object.fromEntries(Object.entries(fields).map(([key, limit]) => [key, clip(values[key], limit)]));

// 设置页打开期间，原生子页面发出的请求（编辑在原生里完成，账号请求仍由网页发出）。
// 每类事件只取白名单字段；返回 null 表示字段不合法，直接丢弃。
const REQUESTS = {
    saveMap: strings({ style: 32, lat: 32, lng: 32, zoom: 32 }),
    saveUsername: strings({ username: 64 }),
    savePassword: strings({ current: 128, next: 128, confirm: 128 }),
    // 原生裁剪好的 JPEG（base64），约 4MB 以内
    uploadAvatar: (values) => (typeof values.image === 'string' && values.image.length <= 6_000_000 ? { image: values.image } : null),
    setDarkMode: (values) => (typeof values.value === 'boolean' ? { value: values.value } : null),
    saveThemeColors: strings({ primary: 32, secondary: 32 }),
    setMapStyle: (values) => (['map_style_dark', 'map_style_light'].includes(values.which) ? { which: values.which, value: clip(values.value, 64) } : null)
};

// 回执里允许回传给原生的状态（原生据此刷新住民名、头像、明暗与主题色）
const STATE_FIELDS = { username: 'string', avatarURL: 'string', dark: 'boolean', primary: 'string', secondary: 'string', darkStyle: 'string', lightStyle: 'string' };

function pickState(state) {
    if (!state || typeof state !== 'object') return undefined;
    const out = {};
    for (const [key, type] of Object.entries(STATE_FIELDS)) {
        if (typeof state[key] !== type) continue;
        out[key] = type === 'string' ? state[key].slice(0, 2048) : state[key];
    }
    return Object.keys(out).length ? out : undefined;
}

// 每次打开都有独立 id。关闭旧页面不会收起新页面；异步完成后不再执行已经离开的页面动作。
export function createNativeSettingsSession(plugin, snapshot, { onAction, onError, onEvent, retryDelay = 100 }) {
    const id = `settings-${Date.now()}-${++sequence}`;
    let stopped = false;
    let listener = null;

    const removeListener = () => {
        const handle = listener;
        listener = null;
        try { handle?.remove?.(); } catch { /* 已移除 */ }
    };

    // 只处理本次呈现的白名单事件；请求结果按 requestId 回传原生
    const handleEvent = async (event) => {
        if (stopped || !event || event.id !== id) return;
        if (event.type === 'motion') {
            if (!MOTION_KEYS.includes(event.key) || typeof event.value !== 'boolean') return;
            await onEvent?.({ type: 'motion', key: event.key, value: event.value });
            return;
        }
        const pick = Object.prototype.hasOwnProperty.call(REQUESTS, event.type) ? REQUESTS[event.type] : null;
        const requestId = clip(event.requestId, 64);
        if (!pick || !requestId) return;
        const values = pick(event.values && typeof event.values === 'object' ? event.values : {});
        if (!values) return;
        let result;
        try {
            result = await onEvent?.({ type: event.type, values });
        } catch (error) {
            result = { ok: false, message: error?.message || '' };
        }
        if (stopped) return;
        const payload = { id, requestId, ok: !!result?.ok, message: String(result?.message || '').slice(0, 200) };
        const state = pickState(result?.state);
        if (state) payload.state = state;
        try {
            await plugin.respond?.(payload);
        } catch { /* 原生页已关闭 */ }
    };

    return {
        async start() {
            try {
                if (stopped) return;
                if (typeof plugin.addListener === 'function') {
                    listener = await plugin.addListener('settingsEvent', (event) => { handleEvent(event); });
                    if (stopped) { removeListener(); return; }
                }
                let result;
                // 住民面板可能还在执行系统关闭动画，等它释放呈现器再显示设置。
                for (let attempt = 0; !stopped; attempt += 1) {
                    try { result = await plugin.open({ ...snapshot, id }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    }
                }
                removeListener();
                if (stopped) return;
                if (result?.id !== id || !ACTIONS.has(result?.action)) throw new Error('Settings presentation ended');
                await onAction(result.action);
            } catch (error) {
                removeListener();
                if (!stopped) onError(error);
            }
        },
        async stop() {
            stopped = true;
            removeListener();
            try { await plugin.close({ id }); } catch { /* 旧安装包不支持时使用网页 */ }
        }
    };
}
