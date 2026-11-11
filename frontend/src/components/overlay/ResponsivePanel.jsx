// 响应式面板：同一份内容在宽屏显示为居中对话框或侧板，在窄屏显示为底部面板（或居中提示框 / 全屏）。
//
// 结构（避免 transform 争用）：
//   门户层 → 背景遮罩
//          → MotionSurface 外层（进出场：缩放 / 位移）
//             → 内层（拖拽位移，仅底部面板）→ 标题 / 内容 / 底部操作

import React, { useRef } from 'react';
import { motion } from 'motion/react';
import MotionSurface from './MotionSurface.jsx';
import { useSheetDrag } from './useSheetDrag.js';
import { useLayoutPolicy, useMotionFlags } from '../../motion/MotionProvider.jsx';
import { getPlatform } from '../../platform/env';
import { t } from '../../i18n/index.js';

const SIDE_TOP = 76;

/**
 * @param {{
 *   open: boolean, onClose: Function, title?: React.ReactNode, children: React.ReactNode, footer?: React.ReactNode,
 *   desktop?: 'center'|'side-left'|'side-right', mobile?: 'sheet'|'center'|'full',
 *   width?: string, maxHeight?: string, sheetHeight?: string, snap?: 'half' | 'third' | null,
 *   modal?: boolean, backdrop?: boolean, dismissOnBackdrop?: boolean, showClose?: boolean, closeLabel?: string,
 *   label?: string, role?: string, kind?: string, suspendNative?: boolean, closeOnEscape?: boolean,
 *   initialFocusRef?: any, bodyStyle?: object, surfaceStyle?: object, surfaceClassName?: string, headerExtra?: React.ReactNode,
 *   bodyProps?: object, onExitComplete?: Function, plain?: boolean, sideInset?: number, sideTop?: number, sideBottom?: number, draggable?: boolean,
 *   expanded?: boolean, onExpandedChange?: (expanded: boolean) => void
 * }} props
 * expanded / onExpandedChange：底部面板的“收起 / 展开”两档（调用方按 expanded 改内容与 maxHeight）。把手可上拉 / 下拉，也可点按切换。
 * draggable=false 关闭底部/全屏面板的下滑关闭（例如正在输入的创作页，避免误触退出）。
 * snap：底部面板先停在较低的位置，用户自己往上拉到完整高度。'half' 往下让出约三分之一屏；
 * 'third' 只露出屏幕下方三分之一（面板本身应为满高，sheetHeight 传 'calc(100% - 24px)'）。
 */
export default function ResponsivePanel({
    open,
    onClose,
    desktop = 'center',
    mobile = 'sheet',
    modal = true,
    backdrop,
    dismissOnBackdrop = true,
    label,
    kind = 'panel',
    suspendNative,
    closeOnEscape,
    initialFocusRef,
    onExitComplete,
    ...rest
}) {
    const layout = useLayoutPolicy();
    const mode = layout.sheet ? mobile : desktop;
    const side = mode === 'side-left' || mode === 'side-right';
    const showBackdrop = backdrop ?? (modal && !side);
    const preset = mode === 'sheet' || mode === 'full' ? 'sheet' : side ? mode : 'modal';
    const layer = mode === 'sheet' || mode === 'full' ? 'sheet' : mode === 'center' ? 'center' : 'none';
    const title = typeof rest.title === 'string' ? rest.title : undefined;

    return (
        <MotionSurface
            show={open}
            portal
            preset={preset}
            layer={layer}
            backdrop={showBackdrop}
            onExitComplete={onExitComplete}
            initialFocusRef={initialFocusRef}
            overlay={{ onClose, modal, kind, label: label || title, dismissOnBackdrop, suspendNative, closeOnEscape }}
            role={rest.role || 'dialog'}
            aria-label={label || title}
            className={`fm-panel-outer fm-panel-outer--${mode}`}
            style={outerStyle(mode, rest)}
        >
            <PanelChrome mode={mode} onClose={onClose} {...rest} />
        </MotionSurface>
    );
}

function outerStyle(mode, { width, maxHeight, sheetHeight, sideInset = 20, sideTop = SIDE_TOP, sideBottom = 24 }) {
    if (mode === 'sheet') return { width: 'min(100%, 640px)', maxHeight: maxHeight || 'calc(100% - 24px)', height: sheetHeight, display: 'flex', flexDirection: 'column', outline: 'none' };
    if (mode === 'full') return { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', outline: 'none' };
    if (mode === 'side-left' || mode === 'side-right') {
        return {
            position: 'absolute',
            top: sideTop,
            bottom: sideBottom,
            [mode === 'side-left' ? 'left' : 'right']: sideInset,
            width: width || 'min(360px, calc(100vw - 40px))',
            display: 'flex',
            flexDirection: 'column',
            outline: 'none'
        };
    }
    return {
        width: width || 'min(520px, calc(100vw - 24px))',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: maxHeight || 'calc(100% - 48px)',
        display: 'flex',
        flexDirection: 'column',
        outline: 'none'
    };
}

/**
 * 面板标题栏（弹窗、侧面板、底部面板，浏览器与 App 相同，与 iOS 原生 NativeSheetHeader 一致）：
 * 左边放操作，标题居中，关闭钮固定右上角；两侧等宽，标题保持居中。
 */
export function PanelHeader({ title, titleId, onClose, closeLabel = t('common:action.close'), right = null, titleAs: Title = 'h2', style }) {
    return (
        <div className="fm-panel__header" data-sheet-header="" style={style}>
            <div className="fm-panel__header-side">{right}</div>
            {title ? <Title id={titleId} className="fm-panel__title">{title}</Title> : <span />}
            <div className="fm-panel__header-side fm-panel__header-side--end">
                {onClose && (
                    <button type="button" className="fm-panel__close fm-pressable" aria-label={closeLabel} onClick={onClose}>
                        <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                )}
            </div>
        </div>
    );
}

function PanelChrome({ mode, onClose, title, children, footer, showClose = true, closeLabel = t('common:action.close'), snap = null, bodyStyle, surfaceStyle, surfaceClassName, headerExtra, bodyProps, plain = false, draggable = true, expanded, onExpandedChange }) {
    const flags = useMotionFlags();
    const sheetRef = useRef(null);
    const iosFull = mode === 'full' && getPlatform() === 'ios';
    const isSheet = (mode === 'sheet' || (mode === 'full' && !iosFull)) && draggable;
    const expandable = mode === 'sheet' && typeof onExpandedChange === 'function';
    const snapOffsets = mode === 'sheet' && (snap === 'half' || snap === 'third') && typeof window !== 'undefined'
        ? [0, snap === 'third' ? Math.max(0, Math.round(window.innerHeight * 2 / 3) - 24) : Math.round(window.innerHeight * 0.32)]
        : null;
    const y = useSheetDrag({
        enabled: isSheet,
        sheetRef,
        onDismiss: () => onClose && onClose('drag'),
        snapOffsets,
        initialSnap: snapOffsets ? 1 : 0,
        reduced: flags.reduced,
        expand: expandable ? { expanded: !!expanded, onExpand: () => onExpandedChange(true), onCollapse: () => onExpandedChange(false) } : null
    });

    const classes = ['fm-surface'];
    if (iosFull) classes.push('fm-full-page');
    if (mode === 'sheet') classes.push('fm-sheet');
    if (surfaceClassName) classes.push(surfaceClassName);
    const style = {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: '1 1 auto',
        overflow: 'hidden',
        ...(mode === 'full' ? { borderRadius: 0, border: 0, height: '100%', paddingBottom: 'var(--safe-bottom, env(safe-area-inset-bottom, 0px))' } : null),
        ...(mode === 'sheet' ? { width: '100%', maxHeight: '100%' } : null),
        ...surfaceStyle
    };

    return (
        <motion.div ref={sheetRef} className={classes.join(' ')} style={isSheet ? { ...style, y } : style}>
            {mode === 'sheet' && (expandable ? (
                <div
                    className="fm-sheet__grabber fm-sheet__grabber--toggle"
                    data-sheet-grabber=""
                    role="button"
                    tabIndex={0}
                    aria-expanded={!!expanded}
                    aria-label={expanded ? t('common:action.collapse') : t('common:action.expand')}
                    onClick={() => {
                        const ended = Number(sheetRef.current?.dataset.sheetDragEnd || 0);
                        if (Date.now() - ended < 350) return;
                        onExpandedChange(!expanded);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        onExpandedChange(!expanded);
                    }}
                />
            ) : <div className="fm-sheet__grabber" data-sheet-grabber="" aria-hidden="true" />)}
            {!plain && (title || showClose || headerExtra) && (
                <PanelHeader title={title} onClose={showClose ? () => onClose && onClose('button') : undefined} closeLabel={closeLabel}
                    right={headerExtra} style={mode === 'sheet' ? { paddingTop: 4 } : undefined} />
            )}
            <div className="fm-panel__body" data-sheet-scroll="" style={bodyStyle} {...bodyProps}>
                {children}
            </div>
            {footer && <div style={{ flexShrink: 0, padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>{footer}</div>}
        </motion.div>
    );
}
