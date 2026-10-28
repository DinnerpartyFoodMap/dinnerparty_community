// 页面层级转场：触屏为方向相反的 push/pop，桌面为小位移渐变。
// 主地图常驻（不参与转场、不为转场克隆第二张地图）：子页面覆盖在地图之上进出，
// 地图只在子页面完全进入后才隐藏，返回时在子页面开始离场前重新显示。

import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getPageVariants } from './presets.js';
import { useMotionFlags } from './MotionProvider.jsx';

const DEPTH = (path) => {
    if (!path || path === '/') return 0;
    return path.split('/').filter(Boolean).length;
};

/** 根据新旧路径判断方向：层级更深为 push，更浅为 pop。 */
export function navigationDirection(prev, next) {
    if (prev === next) return 'none';
    return DEPTH(next) >= DEPTH(prev) ? 'push' : 'pop';
}

/**
 * @param {{ pageKey: string | null, direction: 'push'|'pop'|'none', children: React.ReactNode,
 *           onCoveredChange?: (covered: boolean) => void }} props
 * pageKey 为 null 表示当前在地图页（没有覆盖页面）。
 */
export default function PageTransition({ pageKey, direction, children, onCoveredChange }) {
    const flags = useMotionFlags();
    const variants = getPageVariants({ touch: flags.touch, reduced: flags.reduced });
    const coverRef = useRef(onCoveredChange);
    coverRef.current = onCoveredChange;

    // 回到地图：在子页面离场前立即显示地图
    useEffect(() => {
        if (pageKey === null) coverRef.current && coverRef.current(false);
    }, [pageKey]);

    // 直接打开子页面（例如刷新 /admin）：首屏不播进入动画（initial={false}），不会有 onAnimationComplete，
    // 直接算已覆盖，否则地图和它的浮动按钮会一直显示在页面上
    useEffect(() => {
        if (pageKey !== null) coverRef.current && coverRef.current(true);
        // 只看首次挂载
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <AnimatePresence custom={direction} initial={false}>
            {pageKey !== null && (
                <motion.div
                    className="fm-route-transition"
                    key={pageKey}
                    custom={direction}
                    variants={variants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={(definition) => {
                        if (definition === 'animate') coverRef.current && coverRef.current(true);
                    }}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overscrollBehavior: 'contain',
                        WebkitOverflowScrolling: 'touch',
                        background: 'var(--color-bg-base)',
                        // 推入时在左侧投下阴影，增强层级感
                        boxShadow: flags.touch && !flags.reduced ? '-8px 0 24px rgba(0,0,0,0.08)' : undefined,
                        zIndex: 1
                    }}
                    data-app-scroll=""
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}
