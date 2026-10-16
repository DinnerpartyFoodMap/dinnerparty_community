// 统一动效政策：减少动态效果偏好、页面可见性、用户开关（聚合动效 / 网页动效 / 原生玻璃）与性能降级级别。
// 非 React 模块：地图标记控制器、平台桥接和 React 组件读取同一份状态。
// 关闭动效只影响过渡表现，新的同步与数据正确性修复始终生效。

const STORAGE_KEY = 'yuyuko.motion.v1';
const DEFAULT_PREFERENCES = Object.freeze({ clusterMotion: true, webMotion: true, nativeGlass: true });
const listeners = new Set();

function readStoredPreferences() {
    try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        const out = {};
        for (const key of Object.keys(DEFAULT_PREFERENCES)) {
            if (typeof parsed?.[key] === 'boolean') out[key] = parsed[key];
        }
        return out;
    } catch (e) {
        return {};
    }
}

function matchMedia(query) {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
    } catch (e) {
        return null;
    }
}

const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
const transparencyQuery = matchMedia('(prefers-reduced-transparency: reduce)');

const state = {
    preferences: { ...DEFAULT_PREFERENCES, ...readStoredPreferences() },
    systemReducedMotion: !!reducedQuery?.matches,
    systemReducedTransparency: !!transparencyQuery?.matches,
    pageVisible: typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
    // 0 = 正常；1 = 持续掉帧，减少残影、回弹与背景模糊
    degradeLevel: 0
};

let snapshot = null;

function derive() {
    const reduced = state.systemReducedMotion;
    return Object.freeze({
        reducedMotion: reduced,
        reducedTransparency: state.systemReducedTransparency,
        pageVisible: state.pageVisible,
        degradeLevel: state.degradeLevel,
        preferences: Object.freeze({ ...state.preferences }),
        clusterMotion: state.preferences.clusterMotion && !reduced,
        webMotion: state.preferences.webMotion && !reduced,
        nativeGlass: state.preferences.nativeGlass
    });
}

function applyDocumentFlags(policy) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    root.dataset.motion = policy.reducedMotion ? 'reduced' : (policy.webMotion ? 'full' : 'off');
    root.dataset.degrade = String(policy.degradeLevel);
    root.dataset.transparency = policy.reducedTransparency ? 'reduced' : 'full';
}

function emit() {
    snapshot = derive();
    applyDocumentFlags(snapshot);
    for (const listener of Array.from(listeners)) {
        try { listener(snapshot); } catch (e) { console.warn('动效政策监听失败', e); }
    }
}

export function getMotionPolicy() {
    if (!snapshot) {
        snapshot = derive();
        applyDocumentFlags(snapshot);
    }
    return snapshot;
}

export function subscribeMotionPolicy(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setMotionPreferences(patch) {
    const next = { ...state.preferences };
    for (const key of Object.keys(DEFAULT_PREFERENCES)) {
        if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
    }
    state.preferences = next;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
    emit();
}

/** 由帧监测调用：持续掉帧时提高降级级别（只升不降，页面重载后恢复）。 */
export function reportSustainedJank() {
    if (state.degradeLevel >= 1) return;
    state.degradeLevel = 1;
    emit();
}

function bindMedia(query, key) {
    if (!query) return;
    const onChange = (event) => {
        state[key] = !!event.matches;
        emit();
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else if (typeof query.addListener === 'function') query.addListener(onChange);
}

bindMedia(reducedQuery, 'systemReducedMotion');
bindMedia(transparencyQuery, 'systemReducedTransparency');

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        state.pageVisible = document.visibilityState !== 'hidden';
        emit();
    });
}

/**
 * 帧间隔监测：只在转场期间运行，记录 p95 帧间隔；连续多次超预算则请求降级。
 * 返回 stop()，调用后得到 { frames, p95, max }。
 */
let jankStreak = 0;
export function startFrameProbe() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return () => ({ frames: 0, p95: 0, max: 0 });
    }
    const deltas = [];
    let last = performance.now();
    let raf = 0;
    let running = true;
    const tick = (now) => {
        if (!running) return;
        deltas.push(now - last);
        last = now;
        raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
        running = false;
        window.cancelAnimationFrame(raf);
        if (!deltas.length) return { frames: 0, p95: 0, max: 0 };
        const sorted = deltas.slice(1).sort((a, b) => a - b);
        if (!sorted.length) return { frames: deltas.length, p95: 0, max: 0 };
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        const max = sorted[sorted.length - 1];
        if (sorted.length >= 6 && p95 > 34) {
            jankStreak += 1;
            if (jankStreak >= 3) reportSustainedJank();
        } else {
            jankStreak = 0;
        }
        return { frames: deltas.length, p95, max };
    };
}
