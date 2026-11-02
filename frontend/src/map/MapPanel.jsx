// 地图上的列表面板（收藏、已选地点等）：宽屏从右侧按钮列附近展开，非模态，地图仍可操作；
// 窄屏为底部面板。两种形态都登记到浮层栈（返回键 / Escape 关闭，原生控件收起）。

import React from 'react';
import MotionSurface from '../components/overlay/MotionSurface';
import ResponsivePanel, { PanelHeader } from '../components/overlay/ResponsivePanel';
import { useLayoutPolicy } from '../motion/MotionProvider';
import { t } from '../i18n/index.js';

export default function MapPanel({ open, onClose, title, desktopStyle, children, label, kind = 'map-panel', origin = 'right top', sheetMaxHeight = 'min(72%, 560px)' }) {
    const layout = useLayoutPolicy();
    if (layout.sheet) {
        return (
            <ResponsivePanel open={open} onClose={onClose} title={title} label={label} mobile="sheet" desktop="center" kind={kind} maxHeight={sheetMaxHeight}>
                {children}
            </ResponsivePanel>
        );
    }
    return (
        <MotionSurface
            show={open}
            preset="menu-down"
            overlay={{ onClose, modal: false, kind, label: label || (typeof title === 'string' ? title : undefined) }}
            role="dialog"
            aria-label={label || (typeof title === 'string' ? title : undefined)}
            className="fm-surface"
            style={{ position: 'absolute', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 5000, transformOrigin: origin, ...desktopStyle }}
        >
            <PanelHeader title={title} titleAs="h3" onClose={() => onClose && onClose('button')}
                closeLabel={t('map:panel.close', { title: typeof title === 'string' ? title : '' })} />
            <div className="fm-panel__body">{children}</div>
        </MotionSurface>
    );
}
