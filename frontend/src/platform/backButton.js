// 返回键处理栈：按“关闭当前弹层 → 返回页面 → 处理根页面”的顺序响应系统返回
// （Android 返回键/手势、iOS 左边缘侧滑）。
// 弹层通过 useBackHandler 登记；页面级处理（App.jsx）以较低优先级登记。

import { useEffect, useRef } from 'react';

export const BACK_PRIORITY = { PAGE: 0, PANEL: 50, OVERLAY: 100, DIALOG: 200 };

let seq = 0;
const handlers = [];
const targetListeners = new Set();
let notifyScheduled = false;

function notifyBackTargetChanged() {
    // 同一帧内的多次登记/注销合并通知
    if (notifyScheduled) return;
    notifyScheduled = true;
    Promise.resolve().then(() => {
        notifyScheduled = false;
        const available = hasBackTarget();
        for (const listener of Array.from(targetListeners)) {
            try { listener(available); } catch (e) { console.warn('返回状态监听失败', e); }
        }
    });
}

/**
 * 登记返回处理函数，返回注销函数。handler 返回 false 表示未处理，交给下一层。
 * canHandle（可选）同步判断此刻是否有东西可返回，供 iOS 侧滑决定是否接管左边缘；缺省视为可以。
 */
export function pushBackHandler(handler, priority = BACK_PRIORITY.OVERLAY, canHandle = null) {
    const entry = { id: ++seq, handler, priority, canHandle };
    handlers.push(entry);
    notifyBackTargetChanged();
    return () => {
        const index = handlers.indexOf(entry);
        if (index >= 0) handlers.splice(index, 1);
        notifyBackTargetChanged();
    };
}

/** 依次调用处理函数（优先级高者优先，同级后登记者优先）。返回是否已处理。 */
export async function dispatchBack() {
    const ordered = [...handlers].sort((a, b) => (b.priority - a.priority) || (b.id - a.id));
    for (const entry of ordered) {
        try {
            const result = await entry.handler();
            if (result !== false) return true;
        } catch (error) {
            console.warn('返回键处理失败', error);
            return true;
        }
    }
    return false;
}

/** 当前是否有东西可返回（弹层或非根页面）。 */
export function hasBackTarget() {
    return handlers.some((entry) => {
        if (typeof entry.canHandle !== 'function') return true;
        try { return !!entry.canHandle(); } catch (e) { return true; }
    });
}

/** 订阅“是否有东西可返回”的变化；canHandle 依赖的外部状态变化时调用 refreshBackTarget()。 */
export function subscribeBackTarget(listener) {
    targetListeners.add(listener);
    return () => targetListeners.delete(listener);
}

export function refreshBackTarget() {
    notifyBackTargetChanged();
}

/**
 * React 钩子：active 为真时登记返回处理。handler、canHandle 总是读取最新的闭包。
 */
export function useBackHandler(active, handler, priority = BACK_PRIORITY.OVERLAY, canHandle = null) {
    const ref = useRef(handler);
    ref.current = handler;
    const canRef = useRef(canHandle);
    canRef.current = canHandle;
    const hasCanHandle = typeof canHandle === 'function';
    useEffect(() => {
        if (!active) return undefined;
        return pushBackHandler(
            () => ref.current(),
            priority,
            hasCanHandle ? () => canRef.current() : null
        );
    }, [active, priority, hasCanHandle]);
}
