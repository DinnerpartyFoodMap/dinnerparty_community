// 前后台生命周期：网页用页面可见性事件，App 用 Capacitor App 生命周期事件。
// 订阅者只会收到状态变化（active=true 表示回到前台）。

import { isNativePlatform } from './env.js';

const listeners = new Set();
let lastActive = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
let installed = false;
let backgroundSince = null;

function emit(active) {
    if (active === lastActive) return;
    lastActive = active;
    const now = Date.now();
    const info = { active, backgroundMs: active && backgroundSince ? now - backgroundSince : 0 };
    backgroundSince = active ? null : now;
    listeners.forEach((listener) => {
        try { listener(info); } catch (error) { console.warn('生命周期回调失败', error); }
    });
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(active ? 'app:resume' : 'app:pause', { detail: info }));
    }
}

async function install() {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    document.addEventListener('visibilitychange', () => emit(document.visibilityState !== 'hidden'));
    if (isNativePlatform()) {
        try {
            const { App } = await import('@capacitor/app');
            // Android WebView 切后台不一定触发 visibilitychange，以原生事件为准。
            await App.addListener('appStateChange', ({ isActive }) => emit(!!isActive));
        } catch (error) {
            console.warn('无法监听 App 生命周期', error);
        }
    }
}

/**
 * 订阅前后台切换。
 * @param {(info: {active: boolean, backgroundMs: number}) => void} listener
 */
export function onAppStateChange(listener) {
    install();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function isAppActive() {
    return lastActive;
}

export function initLifecycle() {
    return install();
}
