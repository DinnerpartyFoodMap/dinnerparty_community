// 公共数据的低频轮询（公告、展会）。这些接口由 CDN 和浏览器缓存（backend http/middleware/publicCache.js），
// 每个打开的页面每 30 秒请求一次曾占全站请求的三分之一，现在：
// - 每 intervalMs 请求一次，页面不在前台时跳过；
// - 回到前台 / 窗口获得焦点时补一次，但距上次不足 minGapMs 不重复请求；
// - 管理员改了公告或展会后由 announcePublicUpdate 通知，fresh 请求带一次性参数绕过 CDN 和浏览器缓存。

import { onAppStateChange } from './lifecycle.js';

export const PUBLIC_UPDATE_EVENTS = Object.freeze({ notice: 'notice-updated', exhibition: 'exhibition-updated' });

export const PUBLIC_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const PUBLIC_POLL_MIN_GAP_MS = 60 * 1000;

/** 管理员改了公告（'notice'）或展会（'exhibition'）：本页面立即读取最新内容 */
export function announcePublicUpdate(kind) {
    const type = PUBLIC_UPDATE_EVENTS[kind];
    if (type && typeof window !== 'undefined') window.dispatchEvent(new Event(type));
}

/** 带一次性参数的地址：CDN 缓存键包含查询字符串，这样的请求一定回源 */
export function freshUrl(url) {
    return `${url}${url.includes('?') ? '&' : '?'}fresh=${Date.now()}`;
}

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * 开始轮询。load({ fresh }) 由调用方实现；返回停止函数。
 * @param {(options: { fresh: boolean }) => unknown} load
 * @param {{ intervalMs?: number, minGapMs?: number, updateEvent?: string, now?: () => number }} [options]
 */
export function startPublicPolling(load, { intervalMs = PUBLIC_POLL_INTERVAL_MS, minGapMs = PUBLIC_POLL_MIN_GAP_MS, updateEvent = null, now = () => Date.now() } = {}) {
    let last = -Infinity;
    const run = (fresh = false) => {
        last = now();
        try { load({ fresh }); } catch (error) { console.warn('轮询失败', error); }
    };
    const tick = () => { if (!pageHidden()) run(); };
    const resume = () => { if (!pageHidden() && now() - last >= minGapMs) run(); };
    const update = () => run(true);
    run();
    const timer = typeof window !== 'undefined' ? window.setInterval(tick, intervalMs) : null;
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', resume);
        if (updateEvent) window.addEventListener(updateEvent, update);
    }
    const stopLifecycle = onAppStateChange(({ active }) => { if (active) resume(); });
    return () => {
        if (timer !== null) window.clearInterval(timer);
        if (typeof window !== 'undefined') {
            window.removeEventListener('focus', resume);
            if (updateEvent) window.removeEventListener(updateEvent, update);
        }
        stopLifecycle();
    };
}
