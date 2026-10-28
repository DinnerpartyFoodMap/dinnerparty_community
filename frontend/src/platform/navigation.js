// 统一导航：路径读取、跳转、查询参数、返回与外部链接。
// 网页与 App 都使用 History API（Capacitor 本地服务器对无扩展名路径回退到 index.html），
// 同时兼容历史上的 #/path?query 形式链接。

import { isNativePlatform } from './env.js';

const NAV_INDEX_KEY = '__yuyukoNavIndex';

function splitHashRoute() {
    const hash = String(window.location.hash || '');
    if (!hash.startsWith('#/')) return null;
    const [path, query = ''] = hash.slice(1).split('?');
    return { path: path || '/', query };
}

export function getCurrentPath() {
    if (typeof window === 'undefined') return '/';
    const hashRoute = splitHashRoute();
    if (hashRoute) return hashRoute.path;
    return window.location.pathname || '/';
}

/** 合并 location.search 与 #/path?query 中的查询参数（后者优先）。 */
export function getQueryParams() {
    if (typeof window === 'undefined') return new URLSearchParams();
    const params = new URLSearchParams(window.location.search || '');
    const hashRoute = splitHashRoute();
    if (hashRoute && hashRoute.query) {
        new URLSearchParams(hashRoute.query).forEach((value, key) => params.set(key, value));
    }
    return params;
}

function currentIndex() {
    const value = window.history.state && window.history.state[NAV_INDEX_KEY];
    return Number.isInteger(value) ? value : 0;
}

/**
 * 分享链接里的参数值。QQ / 微信打开链接时会在末尾追加自己的参数（如 qq_aio_chat_type=2），
 * 链接已带查询参数时可能被直接拼成 place=42?qq_aio_chat_type=2，只取开头的值。
 */
export function shareParamValue(value) {
    return String(value || '').split(/[?&#]/)[0];
}

/**
 * 地点分享链接 /p/<id> → 地图页 /?place=<id>（导航分享保留 nav=amap），其余参数（QQ 等追加的）全部丢弃。
 * 不是分享链接时返回 null。
 */
export function placeSharePath(pathname, search = '') {
    const match = /^\/p\/(\d+)\/?$/.exec(pathname || '');
    if (!match) return null;
    const params = new URLSearchParams({ place: match[1] });
    if (shareParamValue(new URLSearchParams(search).get('nav')) === 'amap') params.set('nav', 'amap');
    return `/?${params.toString()}`;
}

/** 首次加载时为历史记录打上序号，用于判断“是否还能返回到本应用内的上一页”。 */
export function initNavigationState() {
    if (typeof window === 'undefined') return;
    // 静态服务器把 /p/<id> 回退成 index.html 时（分享链接没有转到后端分享页），就地改成地图页地址，
    // 否则 App.jsx 会把未知路径重定向到 / 并丢掉地点
    const sharePath = splitHashRoute() ? null : placeSharePath(window.location.pathname, window.location.search);
    if (sharePath) {
        window.history.replaceState({ ...(window.history.state || {}), [NAV_INDEX_KEY]: 0 }, '', sharePath);
        return;
    }
    if (!Number.isInteger(window.history.state && window.history.state[NAV_INDEX_KEY])) {
        window.history.replaceState({ ...(window.history.state || {}), [NAV_INDEX_KEY]: 0 }, '', window.location.href);
    }
}

export function canGoBack() {
    if (typeof window === 'undefined') return false;
    return currentIndex() > 0;
}

/**
 * 应用内跳转。传入的 path 可以包含查询参数。
 * @param {string} path
 * @param {{replace?: boolean}} options
 */
export function navigate(path, { replace = false } = {}) {
    if (typeof window === 'undefined') return;
    const target = String(path || '/');
    const index = replace ? currentIndex() : currentIndex() + 1;
    const state = { [NAV_INDEX_KEY]: index };
    if (replace) window.history.replaceState(state, '', target);
    else window.history.pushState(state, '', target);
}

/** 从地址中移除已处理过的一次性查询参数（如分享链接里的 place），避免返回时重复处理。 */
export function removeQueryParams(names) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    let changed = false;
    names.forEach((name) => {
        if (url.searchParams.has(name)) {
            url.searchParams.delete(name);
            changed = true;
        }
    });
    if (changed) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** 用 replaceState 写入查询参数（值为空则移除），不新增历史记录；用于让当前打开的内容（如公开日记）可刷新、收藏与转发。 */
export function replaceQueryParams(values) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    Object.entries(values).forEach(([name, value]) => {
        if (value === null || value === undefined || value === '') url.searchParams.delete(name);
        else url.searchParams.set(name, String(value));
    });
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', next);
}

export function goBack() {
    if (typeof window !== 'undefined') window.history.back();
}

export function onPopState(listener) {
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
}

/**
 * 打开外部链接（地图导航、备案网站等）。
 * App 内交给系统处理（可唤起已安装的地图 App 或系统浏览器）；网页沿用原有行为。
 * fallbackUrl：App 内自定义 scheme（如 iosamap://）没有应用能打开时改开的链接。
 * @returns {Promise<boolean>} 是否已交给系统/浏览器
 */
export async function openExternal(url, { sameWindow = false, fallbackUrl = '' } = {}) {
    if (!url) return false;
    if (isNativePlatform()) {
        let completed = false;
        try {
            const { AppLauncher } = await import('@capacitor/app-launcher');
            const result = await AppLauncher.openUrl({ url });
            completed = !result || result.completed !== false;
        } catch (error) {
            completed = false;
        }
        if (completed) return true;
        // 未安装目标应用或系统拒绝时，https 链接回退到系统浏览器（Capacitor 会把外部域名交给系统打开）
        if (/^https?:/i.test(url)) {
            window.open(url, '_blank');
            return true;
        }
        return fallbackUrl ? openExternal(fallbackUrl) : false;
    }
    if (sameWindow) {
        window.location.href = url;
        return true;
    }
    // noopener 时 window.open 恒返回 null，无法据此判断是否被拦截
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
}
