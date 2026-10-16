import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/tokens.css";
import { initPlatform } from "./platform/nativeShell";
import { getRuntimeConfig } from "./platform/runtimeConfig";
import { loadAmap } from "./platform/amapLoader";
import { t } from './i18n/index.js';

/**
 * Patch EventTarget.prototype.addEventListener to make touch and wheel events passive by default.
 * This fixes the "[Violation] Added non-passive event listener to a scroll-blocking..." warnings in Chrome
 * usually caused by third-party map libraries like AMap.
 *
 * 显式传入 { passive: false } 的监听器不受影响（面板拖动等需要 preventDefault 的场景应这样注册）。
 * 真机排查地图手势问题时，可在控制台执行 localStorage.setItem('debug.passivePatch', 'off') 后重启以关闭补丁做对比。
 */
(function () {
    let disabled = false;
    try { disabled = window.localStorage.getItem('debug.passivePatch') === 'off'; } catch (e) { /* ignore */ }
    if (disabled || typeof EventTarget === 'undefined') return;
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        const passiveEvents = ['touchstart', 'touchmove', 'mousewheel', 'wheel'];
        if (passiveEvents.includes(type)) {
            if (typeof options === 'boolean') {
                options = { capture: options, passive: true };
            } else if (typeof options === 'object' && options !== null) {
                if (typeof options.passive === 'undefined') {
                    options = { ...options, passive: true };
                }
            } else {
                options = { passive: true };
            }
        }
        return originalAddEventListener.call(this, type, listener, options);
    };
})();

function ConfigErrorScreen({ errors }) {
    return (
        <div style={{ minHeight: '100vh', padding: '48px 24px', boxSizing: 'border-box', background: 'var(--color-bg-base)', color: 'var(--color-text-primary)', fontFamily: 'system-ui, sans-serif' }}>
            <h2 style={{ marginTop: 0 }}>{t('common:app.configError.title')}</h2>
            <p style={{ color: 'var(--color-text-secondary)' }}>{t('common:app.configError.body')}</p>
            <ul style={{ color: 'var(--color-danger)', fontSize: 14 }}>
                {errors.map((item) => <li key={item}>{item}</li>)}
            </ul>
        </div>
    );
}

initPlatform();
const config = getRuntimeConfig();
const root = createRoot(document.getElementById("root"));

if (config.errors.length) {
    console.error('运行配置错误', config.errors);
    root.render(<ConfigErrorScreen errors={config.errors} />);
} else {
    // 尽早开始加载地图 SDK（失败时由地图页提供重试）
    loadAmap().catch((error) => console.warn('地图 SDK 首次加载失败', error));
    root.render(<App />);
}
