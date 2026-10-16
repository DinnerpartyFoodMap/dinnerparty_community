// 浮层生命周期：closed → opening → open → closing → closed。
//
// - 逻辑关闭可以立即进行（父组件把 show 设为 false、取消网络任务），DOM 与最后有效内容由 AnimatePresence
//   保留到退出动画结束，用动画完成回调清理，而不是靠统一的 setTimeout 猜时长。
// - 打开期间登记到浮层栈：返回键与 Escape 先关最上层；退出途中仍消费返回键、保留遮罩，避免击穿。
// - 真正模态：dialog/aria-modal、焦点圈定、背景 inert（门户模式）、关闭后恢复触发点焦点。
// - 门户模式渲染到浮层根节点（与应用内容同一几何区域）；原位模式保留调用方原有的定位。

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { registerOverlay } from './overlayStack.js';
import { useOverlayRoot, trapTabKey, getFocusable } from './overlayContext.js';
import { getPreset, BACKDROP } from '../../motion/presets.js';
import { useMotionFlags } from '../../motion/MotionProvider.jsx';
import { createBackdropPressGuard } from './backdropPress.js';

const LAYERS = {
    center: 'fm-overlay-center',
    sheet: 'fm-sheet-host'
};

function assignRef(ref, value) {
    if (typeof ref === 'function') ref(value);
    else if (ref) ref.current = value;
}

/**
 * @param {{
 *   show: boolean,
 *   portal?: boolean,
 *   preset?: string,
 *   presetOptions?: object,
 *   variants?: { initial, animate, exit },
 *   overlay?: false | { onClose?: Function, modal?: boolean, kind?: string, label?: string, closeOnEscape?: boolean, consumeBack?: boolean, suspendNative?: boolean, dismissOnBackdrop?: boolean },
 *   layer?: 'center' | 'sheet' | 'none',
 *   backdrop?: boolean,
 *   as?: string,
 *   surfaceRef?: any,
 *   initialFocusRef?: any,
 *   focusTrap?: boolean,
 *   onExitComplete?: Function
 * }} props
 */
export default function MotionSurface({ show, portal = false, onExitComplete, ...props }) {
    const root = useOverlayRoot();
    const node = (
        <AnimatePresence onExitComplete={onExitComplete}>
            {show && <SurfaceInner key="surface" portal={portal} {...props} />}
        </AnimatePresence>
    );
    if (!portal) return node;
    // 未挂载宿主（例如独立测试页）时退回 body；宿主已存在但根节点尚未就绪时等待一帧
    const target = root === undefined ? document.body : root;
    return target ? createPortal(node, target) : null;
}

/**
 * 在 presence 子组件内登记浮层（含退出阶段）；onClose 经 ref 读取最新闭包。
 * 供 MotionSurface 与自定义宿主（例如地图锚定卡片）共用。
 */
export function useOverlayEntry(overlay, { portal = false, isPresent = true } = {}) {
    const handleRef = useRef(null);
    const overlayRef = useRef(overlay);
    overlayRef.current = overlay;
    const [order, setOrder] = useState(0);

    useLayoutEffect(() => {
        if (!overlay) return undefined;
        const handle = registerOverlay({
            kind: overlay.kind || 'panel',
            label: overlay.label,
            modal: !!overlay.modal,
            portal,
            closeOnEscape: overlay.closeOnEscape,
            consumeBack: overlay.consumeBack,
            suspendNative: overlay.suspendNative,
            onClose: (reason) => overlayRef.current && overlayRef.current.onClose ? overlayRef.current.onClose(reason) : undefined
        });
        handleRef.current = handle;
        setOrder(handle.order);
        return () => {
            handleRef.current = null;
            handle.unregister();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [!!overlay]);

    useLayoutEffect(() => {
        handleRef.current && handleRef.current.setStatus(isPresent ? 'open' : 'closing');
    }, [isPresent]);

    // 原生控件收起与否可能随布局变化（例如横竖屏）
    const suspend = overlay ? overlay.suspendNative : undefined;
    useLayoutEffect(() => {
        if (handleRef.current && suspend !== undefined) handleRef.current.update({ suspendNative: suspend });
    }, [suspend]);

    return { handleRef, order };
}

function SurfaceInner({
    portal,
    preset = 'modal',
    presetOptions,
    variants,
    overlay = false,
    layer = 'none',
    backdrop = false,
    backdropStyle,
    as = 'div',
    className,
    style,
    surfaceRef,
    initialFocusRef,
    focusTrap,
    children,
    onKeyDown,
    ...rest
}) {
    const isPresent = useIsPresent();
    const flags = useMotionFlags();
    const surfaceEl = useRef(null);
    const [backdropPress] = useState(createBackdropPressGuard);
    const modal = !!(overlay && overlay.modal);
    const trap = focusTrap ?? modal;
    const { handleRef, order } = useOverlayEntry(overlay, { portal, isPresent });

    // 焦点：模态打开时移入浮层，关闭（卸载）后回到触发点
    useEffect(() => {
        if (!trap) return undefined;
        const previous = document.activeElement;
        const el = surfaceEl.current;
        if (el) {
            // 触屏上不自动聚焦输入框，避免一打开就弹出键盘
            const target = (initialFocusRef && initialFocusRef.current)
                || (flags.touch ? null : getFocusable(el).find((item) => !item.matches('input, textarea, select')))
                || el;
            try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        return () => {
            if (previous && previous.isConnected && typeof previous.focus === 'function' && !previous.closest('[inert]')) {
                try { previous.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleKeyDown = useCallback((event) => {
        if (trap) trapTabKey(event, surfaceEl.current);
        onKeyDown && onKeyDown(event);
    }, [trap, onKeyDown]);

    const def = variants || getPreset(preset, { touch: flags.touch, reduced: flags.reduced, ...presetOptions });
    const Component = motion[as] || motion.div;
    const setSurface = (el) => {
        surfaceEl.current = el;
        assignRef(surfaceRef, el);
    };
    const surface = (
        <Component
            ref={setSurface}
            className={className}
            initial={def.initial}
            animate={def.animate}
            exit={def.exit}
            tabIndex={trap && rest.tabIndex === undefined ? -1 : rest.tabIndex}
            role={rest.role || (modal ? 'dialog' : undefined)}
            aria-modal={modal ? true : undefined}
            {...rest}
            // 退出中的浮层不再响应操作，避免重复提交
            style={{ ...style, pointerEvents: isPresent ? style && style.pointerEvents : 'none' }}
            onKeyDown={handleKeyDown}
        >
            {children}
        </Component>
    );

    if (!portal) return surface;
    const backdropDef = flags.reduced ? getPreset('fade', { reduced: true }) : BACKDROP;
    const onBackdropClick = (event) => {
        if (!backdropPress.consumeClick(event)) return;
        if (overlay && overlay.dismissOnBackdrop === false) return;
        handleRef.current && handleRef.current.requestClose('backdrop');
    };
    return (
        <div className="fm-overlay-layer" data-overlay-id={handleRef.current ? handleRef.current.id : ''} data-overlay-order={order} style={{ zIndex: order || 1 }}>
            {backdrop && (
                <motion.div
                    className="fm-overlay-backdrop"
                    style={backdropStyle}
                    aria-hidden="true"
                    initial={backdropDef.initial}
                    animate={backdropDef.animate}
                    exit={backdropDef.exit}
                    onPointerDown={backdropPress.onPointerDown}
                    onPointerUp={backdropPress.onPointerUp}
                    onPointerCancel={backdropPress.onPointerCancel}
                    onPointerLeave={backdropPress.onPointerLeave}
                    onClick={onBackdropClick}
                />
            )}
            {LAYERS[layer] ? <div className={LAYERS[layer]}>{surface}</div> : surface}
        </div>
    );
}
