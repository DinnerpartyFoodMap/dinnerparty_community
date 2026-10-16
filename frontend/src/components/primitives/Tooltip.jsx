import React, { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getPreset } from "../../motion/presets";
import { useMotionFlags } from "../../motion/MotionProvider";

// 指针悬停或键盘聚焦时显示的短提示；触屏不依赖悬停访问功能（按钮自身带可访问名称）。
export default function Tooltip({ text, children, placement = 'bottom' }) {
    const [show, setShow] = useState(false);
    const flags = useMotionFlags();
    const id = useId();
    const preset = getPreset('tooltip', flags);
    const containerStyle = {
        position: 'relative',
        display: 'inline-block'
    };

    const tooltipStyle = {
        position: 'absolute',
        top: placement === 'bottom' ? 'calc(100% + 6px)' : 'auto',
        bottom: placement === 'top' ? 'calc(100% + 6px)' : 'auto',
        right: 0,
        background: 'var(--color-bg-overlay)',
        color: 'var(--color-text-primary)',
        border: '1px solid var(--color-border)',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        whiteSpace: 'nowrap',
        zIndex: 4000,
        boxShadow: 'var(--shadow-surface)',
        pointerEvents: 'none'
    };

    const canHover = !flags.touch;

    return (
        <div
            style={containerStyle}
            onMouseEnter={() => canHover && setShow(true)}
            onMouseLeave={() => setShow(false)}
            onFocus={(event) => { if (event.target.matches?.(':focus-visible')) setShow(true); }}
            onBlur={() => setShow(false)}
            onPointerDown={() => setShow(false)}
        >
            {children}
            <AnimatePresence>
                {show && text && (
                    <motion.div key="tip" id={id} role="tooltip" style={tooltipStyle} initial={preset.initial} animate={preset.animate} exit={preset.exit}>
                        {text}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
