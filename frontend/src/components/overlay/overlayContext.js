// 浮层上下文与焦点工具（独立模块，避免宿主与浮层组件之间的循环引用）。

import { createContext, useContext } from 'react';

// rootEl 为 undefined 表示没有宿主（独立测试页等），浮层回退渲染到 body
export const OverlayContext = createContext({ rootEl: undefined, setContentEl: () => { } });

export function useOverlayRoot() {
    return useContext(OverlayContext).rootEl;
}

/** 应用内容区的 ref 回调：模态打开时该区域整体 inert。 */
export function useOverlayContentRef() {
    return useContext(OverlayContext).setContentEl;
}

// ---- 焦点工具 ----

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function getFocusable(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
        if (el.closest('[inert]')) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
    });
}

/** Tab / Shift-Tab 在容器内循环。 */
export function trapTabKey(event, container) {
    if (event.key !== 'Tab' || !container) return;
    const items = getFocusable(container);
    if (!items.length) {
        event.preventDefault();
        container.focus?.();
        return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
    }
}
