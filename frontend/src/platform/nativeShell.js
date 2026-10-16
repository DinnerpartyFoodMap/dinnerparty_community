// App 容器初始化：系统返回键、键盘避让、应用链接打开、生命周期。
// 网页端只做导航状态初始化，不加载任何原生插件。

import { isNativePlatform, getPlatform } from './env.js';
import { dispatchBack, hasBackTarget, subscribeBackTarget } from './backButton.js';
import { initNavigationState, placeSharePath } from './navigation.js';
import { initLifecycle } from './lifecycle.js';
import { getRuntimeConfig } from './runtimeConfig.js';
import { startGlassRefraction } from './glassRefraction.js';

function setKeyboardInset(height) {
    const root = document.documentElement;
    root.style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(height || 0))}px`);
    root.classList.toggle('keyboard-open', height > 0);
}

// App 内禁止整页缩放（WKWebView 遵守 user-scalable=no）。Capacitor 只在第一次缩放开始时关掉 WebView 的捏合识别器，
// WebKit 之后又会按 viewport 设置重新打开：地图上的双指缩放偶尔变成整页缩放，视口尺寸一变，地图跟着重新居中、漂走。
// 网页端保留浏览器缩放（无障碍），地图手势由 .fm-map-canvas 的 touch-action: none 隔离。
function lockViewportScale() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const content = meta.getAttribute('content') || '';
    if (/user-scalable\s*=\s*no/i.test(content)) return;
    meta.setAttribute('content', `${content}, minimum-scale=1, maximum-scale=1, user-scalable=no`);
}

/** 把指向本站公开网页的链接（含 /p/:id 分享链接）转换为应用内路径。 */
export function toInAppPath(rawUrl, base = getRuntimeConfig().publicWebBaseUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return null; }
    let baseHost = '';
    try { baseHost = new URL(base).hostname; } catch (e) { /* ignore */ }
    const sameSite = baseHost && (url.hostname === baseHost || url.hostname.endsWith(`.${baseHost.replace(/^www\./, '')}`));
    if (!sameSite) return null;
    return placeSharePath(url.pathname, url.search) || `${url.pathname || '/'}${url.search}`;
}

// iOS 没有系统返回键：FoodMapBridgeViewController 识别左边缘侧滑后派发 foodmap:edge-back，
// 走与 Android 返回键相同的 dispatchBack。只在有东西可返回时让原生接管左边缘，
// 根页面不拦截，地图从左边缘开始的拖动不受影响。
function setupIosEdgeBack() {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foodMapEdgeBack;
    if (!handler) return;
    let last = null;
    const report = (enabled) => {
        if (enabled === last) return;
        last = enabled;
        try { handler.postMessage({ enabled }); } catch (e) { /* 原生未注册时忽略 */ }
    };
    subscribeBackTarget(report);
    report(hasBackTarget());
    window.addEventListener('foodmap:edge-back', () => { dispatchBack(); });
}

async function setupNative() {
    const { App } = await import('@capacitor/app');

    // 返回：关闭当前弹层 → 返回页面（App.jsx 登记的页面级处理）→ 根页面时退到后台
    await App.addListener('backButton', async () => {
        if (await dispatchBack()) return;
        if (getPlatform() === 'android') {
            try { await App.minimizeApp(); } catch (e) { await App.exitApp(); }
        }
    });

    if (getPlatform() === 'ios') setupIosEdgeBack();

    // 通过 App Link / Universal Link 打开时，转换为应用内导航
    await App.addListener('appUrlOpen', ({ url }) => {
        const path = toInAppPath(url);
        if (!path) return;
        window.dispatchEvent(new CustomEvent('app:open-path', { detail: { path } }));
    });

    try {
        const { Keyboard } = await import('@capacitor/keyboard');
        await Keyboard.addListener('keyboardWillShow', (info) => setKeyboardInset(info && info.keyboardHeight));
        await Keyboard.addListener('keyboardDidShow', (info) => setKeyboardInset(info && info.keyboardHeight));
        await Keyboard.addListener('keyboardWillHide', () => setKeyboardInset(0));
        await Keyboard.addListener('keyboardDidHide', () => setKeyboardInset(0));
    } catch (error) {
        console.warn('键盘插件不可用', error);
    }
}

export async function initPlatform() {
    initNavigationState();
    initLifecycle();
    if (typeof document !== 'undefined') {
        document.documentElement.dataset.platform = getPlatform();
        // 安卓 WebView（Chromium）支持 backdrop-filter 里的 SVG 滤镜：玻璃边缘真正折射背后的地图
        if (getPlatform() === 'android') startGlassRefraction();
        setKeyboardInset(0);
    }
    if (!isNativePlatform()) return;
    if (typeof document !== 'undefined') lockViewportScale();
    try {
        await setupNative();
    } catch (error) {
        console.error('原生容器初始化失败', error);
    }
}
