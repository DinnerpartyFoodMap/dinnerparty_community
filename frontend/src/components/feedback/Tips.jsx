import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getPreset } from "../../motion/presets";
import { useMotionFlags } from "../../motion/MotionProvider";
import { t } from "../../i18n/index.js";

export const TipsContext = createContext({ showTip: () => { }, hideTip: () => { } });

// 提示条：短位移渐变进出；退出动画由 AnimatePresence 保留到结束，不再用定时器猜时长。
export function TipsProvider({ children }) {
    const [tip, setTip] = useState(null);
    const timeoutRef = useRef(null);
    const seqRef = useRef(0);
    const flags = useMotionFlags();

    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    const showTip = (message, opts = {}) => {
        const duration = typeof opts.duration === 'number' ? opts.duration : 4000;
        const closable = typeof opts.closable === 'boolean' ? opts.closable : true;
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        const id = ++seqRef.current;
        setTip({ id, message, closable });
        if (duration > 0) {
            timeoutRef.current = setTimeout(() => {
                setTip((current) => (current && current.id === id ? null : current));
                timeoutRef.current = null;
            }, duration);
        }
    };

    const hideTip = () => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
        setTip(null);
    };

    const preset = getPreset('toast', flags);

    // 位置在 overlay.css 的 .fm-toast-layer：底部居中，窄屏在底部工具栏之上（设计参考 11.7，与 iOS 原生 toast 相同）
    const tipStyle = {
        pointerEvents: 'auto',
        minWidth: 160,
        maxWidth: 'min(560px, 100%)',
        background: 'var(--color-bg-surface)',
        color: 'var(--color-text-primary)',
        padding: '10px 18px',
        paddingRight: tip && tip.closable ? '44px' : '18px',
        borderRadius: 'var(--radius-full)',
        textAlign: 'center',
        fontSize: 'var(--text-body-size)',
        lineHeight: 1.45,
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-surface)',
        position: 'relative',
        boxSizing: 'border-box'
    };

    const closeStyle = {
        position: 'absolute',
        top: 10,
        right: 14,
        border: 'none',
        background: 'transparent',
        color: 'var(--color-text-secondary)',
        fontSize: 18,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1
    };

    return (
        <TipsContext.Provider value={{ showTip, hideTip }}>
            {children}
            <div className="fm-toast-layer" aria-live="polite">
                <AnimatePresence mode="popLayout">
                    {tip && (
                        <motion.div key={tip.id} role="status" className="fm-glass" style={tipStyle} initial={preset.initial} animate={preset.animate} exit={preset.exit}>
                            {tip.closable && <button aria-label={t('common:action.close')} style={closeStyle} onClick={hideTip}>×</button>}
                            <div>{tip.message}</div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </TipsContext.Provider>
    );
}

export function useTips() {
    const ctx = useContext(TipsContext);
    return ctx.showTip;
}

export default TipsProvider;
