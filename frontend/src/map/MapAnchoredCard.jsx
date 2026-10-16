// 地图锚定卡片（宽屏）：用 AMap 覆盖物容器承载 React portal，卡片与地点图标由地图在同一帧定位，
// 拖动、惯性与缩放时不会追赶或抖动；内层只负责进出场（从锚点展开）。
//
// - 卡片根节点阻止 mousedown/touchstart/pointerdown/wheel/dblclick 继续冒泡到地图，避免在卡片上拖动或滚轮时移动地图；
//   click 不拦截，React 事件照常工作。
// - 打开后若卡片超出地图可见区域，自动平移地图让卡片完整显示。
// - 每个地点一个 presence key：切换地点时旧卡片在旧锚点退出，新卡片在新锚点展开。

import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useOverlayEntry } from '../components/overlay/MotionSurface';
import { getPreset } from '../motion/presets';
import { useMotionFlags } from '../motion/MotionProvider';
import { getMapSafeInsets } from './viewport';

const STOP_EVENTS = ['mousedown', 'touchstart', 'pointerdown', 'wheel', 'dblclick', 'contextmenu'];
const EDGE = 12;

export default function MapAnchoredCard({ show, cardKey, ...props }) {
    return (
        <AnimatePresence>
            {show && <CardHost key={cardKey} {...props} />}
        </AnimatePresence>
    );
}

function CardHost({ map, coordinate, offsetY = 53, onClose, label, children, autoPan = true, onAutoPan }) {
    const isPresent = useIsPresent();
    const flags = useMotionFlags();
    const host = useMemo(() => {
        const el = document.createElement('div');
        el.className = 'fm-card-host';
        el.style.cssText = 'position:relative;width:0;height:0;overflow:visible;';
        return el;
    }, []);
    const cardRef = useRef(null);
    useOverlayEntry({ onClose, modal: false, kind: 'place-card', label, suspendNative: false }, { isPresent });

    useLayoutEffect(() => {
        if (!map || !window.AMap) return undefined;
        const marker = new window.AMap.Marker({
            position: coordinate,
            content: host,
            anchor: 'top-left',
            offset: new window.AMap.Pixel(0, 0),
            zIndex: 900,
            bubble: false
        });
        const stop = (event) => event.stopPropagation();
        STOP_EVENTS.forEach((type) => host.addEventListener(type, stop, { passive: true }));
        try { map.add(marker); } catch (e) { marker.setMap(map); }
        return () => {
            STOP_EVENTS.forEach((type) => host.removeEventListener(type, stop));
            try { map.remove(marker); } catch (e) { marker.setMap(null); }
        };
        // 每个 presence 实例固定一个锚点；地点变化时由 cardKey 创建新实例
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map, host]);

    // 打开后让卡片完整落在可见区域内（避开顶部栏等遮挡）
    useLayoutEffect(() => {
        if (!autoPan || !map) return undefined;
        const raf = requestAnimationFrame(() => {
            // 量外层定位容器：内层正在做进场缩放，变换后的尺寸不能代表最终位置
            const card = cardRef.current && cardRef.current.parentElement;
            const container = map.getContainer && map.getContainer();
            if (!card || !container) return;
            const box = container.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            const insets = getMapSafeInsets(container);
            let dx = 0;
            let dy = 0;
            if (rect.left < box.left + EDGE) dx = box.left + EDGE - rect.left;
            else if (rect.right > box.right - EDGE) dx = box.right - EDGE - rect.right;
            const top = box.top + insets.top + EDGE;
            if (rect.top < top) dy = top - rect.top;
            if (dx || dy) {
                onAutoPan && onAutoPan();
                try { map.panBy(Math.round(dx), Math.round(dy)); } catch (e) { /* ignore */ }
            }
        });
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const preset = getPreset('card', flags);
    return createPortal(
        <div style={{ position: 'absolute', left: 0, bottom: offsetY, transform: 'translateX(-50%)', pointerEvents: isPresent ? 'auto' : 'none' }}>
            <motion.div
                ref={cardRef}
                role="dialog"
                aria-label={label}
                initial={preset.initial}
                animate={preset.animate}
                exit={preset.exit}
                style={{ transformOrigin: '50% 100%' }}
            >
                {children}
            </motion.div>
        </div>,
        host
    );
}
