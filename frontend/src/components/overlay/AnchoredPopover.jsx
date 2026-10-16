// 锚定弹出层（二级菜单）：从触发位置展开；键盘上下移动、Home/End、Escape 关闭并回到触发点；
// 外部点击关闭；位置按触发元素实时计算，空间不足时翻转方向。
// 窄屏触屏上，较长的动作列表（sheetOnNarrow）改为底部操作面板。

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import MotionSurface from './MotionSurface.jsx';
import ResponsivePanel from './ResponsivePanel.jsx';
import { useLayoutPolicy } from '../../motion/MotionProvider.jsx';
import { transformOriginFor } from '../../motion/presets.js';

const GAP = 6;
const MARGIN = 8;

function computePosition(anchor, popover, placement) {
    const a = anchor.getBoundingClientRect();
    const width = popover ? popover.offsetWidth : 200;
    const height = popover ? popover.offsetHeight : 200;
    const vw = window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    let [side, align = 'center'] = placement.split('-');
    if (side === 'bottom' && a.bottom + GAP + height > vh - MARGIN && a.top - GAP - height > MARGIN) side = 'top';
    else if (side === 'top' && a.top - GAP - height < MARGIN && a.bottom + GAP + height < vh - MARGIN) side = 'bottom';
    let top = side === 'top' ? a.top - GAP - height : a.bottom + GAP;
    let left = align === 'start' ? a.left : align === 'end' ? a.right - width : a.left + a.width / 2 - width / 2;
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - height - MARGIN));
    return { top, left, placement: `${side}-${align}` };
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]):not([disabled])';

/**
 * @param {{ open: boolean, onClose: Function, anchorRef: { current: HTMLElement }, placement?: string,
 *           role?: string, label?: string, children: React.ReactNode, style?: object,
 *           sheetOnNarrow?: boolean, title?: string, autoFocus?: boolean, modal?: boolean }} props
 */
export default function AnchoredPopover({ open, onClose, anchorRef, placement = 'bottom-end', role = 'menu', label, children, style, sheetOnNarrow = false, title, autoFocus = true }) {
    const layout = useLayoutPolicy();
    if (sheetOnNarrow && layout.sheet && layout.touch) {
        return (
            <ResponsivePanel open={open} onClose={onClose} title={title} label={label || title} mobile="sheet" desktop="center" kind="menu" showClose={false}>
                <div role={role} aria-label={label} className="fm-menu" style={{ padding: '4px 8px 12px', display: 'flex', flexDirection: 'column' }}>
                    {children}
                </div>
            </ResponsivePanel>
        );
    }
    return (
        <MotionSurface
            show={open}
            portal
            preset="menu-down"
            overlay={{ onClose, modal: false, kind: 'menu', label }}
            focusTrap={false}
            as="div"
            className="fm-surface fm-menu"
            role={role}
            aria-label={label}
            style={{ position: 'fixed', padding: 6, minWidth: 190, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(420px, calc(100% - 16px))', overflowY: 'auto', boxSizing: 'border-box', ...style }}
        >
            <PopoverBody anchorRef={anchorRef} placement={placement} onClose={onClose} autoFocus={autoFocus}>
                {children}
            </PopoverBody>
        </MotionSurface>
    );
}

/** 定位与键盘逻辑放在 presence 子节点内，退出动画期间保持最后位置。 */
function PopoverBody({ anchorRef, placement, onClose, autoFocus, children }) {
    const bodyRef = useRef(null);
    const [, force] = useState(0);
    const surface = () => bodyRef.current && bodyRef.current.parentElement;

    const place = useCallback(() => {
        const el = surface();
        const anchor = anchorRef && anchorRef.current;
        if (!el || !anchor) return;
        const pos = computePosition(anchor, el, placement);
        el.style.top = `${Math.round(pos.top)}px`;
        el.style.left = `${Math.round(pos.left)}px`;
        el.style.transformOrigin = transformOriginFor(pos.placement);
    }, [anchorRef, placement]);

    useLayoutEffect(() => {
        place();
        force((n) => n + 1);
    }, [place]);

    useEffect(() => {
        const onViewport = () => place();
        window.addEventListener('resize', onViewport);
        window.addEventListener('scroll', onViewport, true);
        const onPointerDown = (event) => {
            const el = surface();
            const anchor = anchorRef && anchorRef.current;
            if (el && el.contains(event.target)) return;
            if (anchor && anchor.contains(event.target)) return;
            onClose && onClose('outside');
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        // 键盘打开时把焦点放到第一项
        if (autoFocus) {
            const first = surface() && surface().querySelector(ITEM_SELECTOR);
            if (first && document.activeElement && anchorRef && anchorRef.current && anchorRef.current.contains(document.activeElement) && document.activeElement.matches(':focus-visible')) {
                first.focus({ preventScroll: true });
            }
        }
        const anchorAtOpen = anchorRef && anchorRef.current;
        return () => {
            window.removeEventListener('resize', onViewport);
            window.removeEventListener('scroll', onViewport, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            // 焦点仍在菜单内时回到触发点
            const active = document.activeElement;
            if (anchorAtOpen && anchorAtOpen.isConnected && (!active || active === document.body || (bodyRef.current && bodyRef.current.contains(active)))) {
                const target = anchorAtOpen.matches('button, [tabindex]') ? anchorAtOpen : anchorAtOpen.querySelector('button, [tabindex]');
                try { target && target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [place]);

    const onKeyDown = (event) => {
        const el = surface();
        if (!el) return;
        const items = Array.from(el.querySelectorAll(ITEM_SELECTOR));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        let next = null;
        if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
        else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
        else if (event.key === 'Home') next = items[0];
        else if (event.key === 'End') next = items[items.length - 1];
        else if (event.key === 'Tab') { onClose && onClose('tab'); return; }
        if (next) {
            event.preventDefault();
            next.focus();
        }
    };

    return (
        <div ref={bodyRef} onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column' }}>
            {children}
        </div>
    );
}
