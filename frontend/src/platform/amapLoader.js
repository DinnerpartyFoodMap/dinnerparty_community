// 高德 JS API 加载器：与 React 共用 runtimeConfig，保证 _AMapSecurityConfig 先于 SDK 生效，
// 并提供失败重试与状态订阅，避免加载失败时只留下空白地图。

import { getRuntimeConfig } from './runtimeConfig.js';
import { getPlatform } from './env.js';
import { t } from '../i18n/index.js';
import { readPrivacyConsent } from './privacyConsent.js';

const AMAP_PLUGINS = ['AMap.PlaceSearch', 'AMap.Geolocation'];
const LOAD_TIMEOUT_MS = 20000;

let pending = null;
let scriptEl = null;
let state = { status: typeof window !== 'undefined' && window.AMap ? 'ready' : 'idle', error: null, attempts: 0 };
const listeners = new Set();

function setState(patch) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => {
        try { listener(state); } catch (e) { /* ignore */ }
    });
}

export function getAmapState() {
    return state;
}

export function subscribeAmap(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function applySecurityConfig(config) {
    // 必须在 SDK 脚本执行前设置；SDK 会据此把瓦片与服务请求转发到后端代理（注入 jscode）。
    window._AMapSecurityConfig = { serviceHost: config.amapServiceHost };
}

/**
 * 高德 SDK 只对 UA 含 Chrome / Firefox / Safari（Version/x）/ Edge / 微信 / 钉钉 的浏览器启用 WebGL，
 * 其余退回 DOM 栅格渲染；此时 setMapStyle 只记录样式（getMapStyle 照常返回），地图始终是默认样式。
 * iOS App 的 WKWebView 与 QQ 等内置浏览器 UA 不带 "Version/… Safari"，会被误判。iOS 上所有浏览器都是
 * 同一个 WebKit，WebGL 能力与 Safari 相同；forceWebGL 只跳过这份 UA 白名单，SDK 仍会实测 WebGL 是否可用。
 */
export function shouldForceAmapWebGL({ platform, userAgent = '', maxTouchPoints = 0 }) {
    if (platform === 'ios') return true;
    if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
    // iPadOS 13+ 默认以 Macintosh 身份上报 UA，靠触点数区分
    return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

function applyRenderHints() {
    // 必须在 SDK 脚本执行前设置：SDK 加载时一次性判定渲染方式。
    const nav = window.navigator || {};
    if (shouldForceAmapWebGL({ platform: getPlatform(), userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints })) {
        window.forceWebGL = true;
    }
}

export function loadAmap() {
    if (readPrivacyConsent() !== 'accepted') {
        const error = new Error(t('common:privacy.consentRequired'));
        error.code = 'PRIVACY_CONSENT_REQUIRED';
        return Promise.reject(error);
    }
    if (typeof window === 'undefined') return Promise.reject(new Error(t('platform:amapLoader.notBrowser')));
    if (window.AMap) {
        if (state.status !== 'ready') setState({ status: 'ready', error: null });
        return Promise.resolve(window.AMap);
    }
    if (pending) return pending;

    const config = getRuntimeConfig();
    if (config.errors.length) {
        const error = new Error(t('platform:amapLoader.configIncomplete', { errors: config.errors.join(t('platform:amapLoader.errorSeparator')) }));
        error.code = 'CONFIG_INVALID';
        setState({ status: 'error', error });
        return Promise.reject(error);
    }

    applySecurityConfig(config);
    applyRenderHints();
    setState({ status: 'loading', error: null, attempts: state.attempts + 1 });

    pending = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        scriptEl = script;
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (!error && window.AMap) {
                setState({ status: 'ready', error: null });
                resolve(window.AMap);
                return;
            }
            const failure = error || new Error(t('platform:amapLoader.amapMissing'));
            failure.code = failure.code || 'AMAP_LOAD_FAILED';
            try { script.remove(); } catch (e) { /* ignore */ }
            if (scriptEl === script) scriptEl = null;
            pending = null;
            setState({ status: 'error', error: failure });
            reject(failure);
        };
        const timer = window.setTimeout(() => {
            const error = new Error(t('platform:amapLoader.timeout'));
            error.code = 'AMAP_TIMEOUT';
            finish(error);
        }, LOAD_TIMEOUT_MS);

        const params = new URLSearchParams({ v: '2.0', key: config.amapJsKey, plugin: AMAP_PLUGINS.join(',') });
        script.src = `https://webapi.amap.com/maps?${params.toString()}`;
        script.async = true;
        script.onload = () => finish(null);
        script.onerror = () => {
            const error = new Error(t('platform:amapLoader.connectFailed'));
            error.code = 'AMAP_NETWORK';
            finish(error);
        };
        document.head.appendChild(script);
    });
    return pending;
}

/** 失败后手动重试；成功或正在加载时直接复用当前结果。 */
export function retryAmap() {
    if (state.status === 'error') pending = null;
    return loadAmap();
}

export function describeAmapError(error) {
    if (!error) return '';
    if (error.code === 'CONFIG_INVALID') return error.message;
    if (error.code === 'AMAP_TIMEOUT') return t('platform:amapLoader.describe.timeout');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return t('platform:amapLoader.describe.offline');
    return t('platform:amapLoader.describe.unavailable');
}
