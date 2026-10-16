// 浮层宿主：提供浮层根节点（与应用内容同一几何区域），并根据浮层栈处理真正模态的背景 inert 与滚动锁。
// 应用内容区通过 useOverlayContentRef 标记，模态打开时整体 inert，读屏与 Tab 焦点不会落到背景。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeOverlays, getOverlayEntries } from './overlayStack.js';
import { ActionSheetHost } from './ActionSheet.jsx';
import { OverlayContext } from './overlayContext.js';
import './overlay.css';

export function OverlayHost({ children }) {
    const [rootEl, setRootEl] = useState(null);
    const contentElRef = useRef(null);
    const setContentEl = useCallback((el) => { contentElRef.current = el; }, []);

    useEffect(() => {
        const apply = (list) => {
            // 最上层的“门户模态”决定 inert 边界：应用内容与它下面的浮层层级都不可交互
            let topModal = null;
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].modal && list[i].portal && list[i].status === 'open') { topModal = list[i]; break; }
            }
            const content = contentElRef.current;
            if (content) {
                if (topModal) content.setAttribute('inert', '');
                else content.removeAttribute('inert');
            }
            if (rootEl) {
                for (const layer of rootEl.querySelectorAll(':scope > [data-overlay-id]')) {
                    const order = Number(layer.dataset.overlayOrder);
                    if (topModal && order < topModal.order) layer.setAttribute('inert', '');
                    else layer.removeAttribute('inert');
                }
            }
            const lock = list.some((entry) => entry.modal && entry.portal);
            if (lock) document.documentElement.dataset.scrollLock = '1';
            else delete document.documentElement.dataset.scrollLock;
        };
        apply(getOverlayEntries());
        return subscribeOverlays(apply);
    }, [rootEl]);

    return (
        <OverlayContext.Provider value={{ rootEl, setContentEl }}>
            {children}
            <div ref={setRootEl} className="fm-overlay-root fm-app-frame" />
            <ActionSheetHost />
        </OverlayContext.Provider>
    );
}

export { useOverlayRoot, useOverlayContentRef, getFocusable, trapTabKey } from './overlayContext.js';
