// 动效与布局策略的 React 入口。
// - 动效政策（减少动态效果、用户开关、页面可见性、降级级别）来自 motion/policy.js，与地图标记层共享。
// - 布局策略集中判断窄屏与输入方式：以 640px 为窄屏基线，结合 pointer/hover 能力；
//   窄屏不等于 iPhone，触屏设备也不一定是窄屏。

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { getMotionPolicy, subscribeMotionPolicy } from './policy.js';

export const NARROW_QUERY = '(max-width: 640px)';
const COARSE_QUERY = '(pointer: coarse)';
const HOVER_QUERY = '(hover: hover)';

function readQuery(query) {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch (e) {
        return false;
    }
}

function readLayout() {
    const narrow = readQuery(NARROW_QUERY);
    const coarse = readQuery(COARSE_QUERY);
    const hover = readQuery(HOVER_QUERY);
    return Object.freeze({
        narrow,
        coarse,
        hover,
        // 触屏反馈与手势：粗指针或无悬停能力
        touch: coarse || !hover,
        // 浮层形态：窄屏使用底部面板，宽屏（含平板横屏）使用居中/侧边/锚定形态
        sheet: narrow
    });
}

const MotionContext = createContext({ policy: getMotionPolicy(), layout: readLayout() });

export function MotionProvider({ children }) {
    const [policy, setPolicy] = useState(() => getMotionPolicy());
    const [layout, setLayout] = useState(readLayout);

    useEffect(() => subscribeMotionPolicy(setPolicy), []);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const queries = [NARROW_QUERY, COARSE_QUERY, HOVER_QUERY].map((q) => window.matchMedia(q));
        const update = () => setLayout((prev) => {
            const next = readLayout();
            return prev.narrow === next.narrow && prev.coarse === next.coarse && prev.hover === next.hover ? prev : next;
        });
        queries.forEach((mq) => (mq.addEventListener ? mq.addEventListener('change', update) : mq.addListener(update)));
        return () => queries.forEach((mq) => (mq.removeEventListener ? mq.removeEventListener('change', update) : mq.removeListener(update)));
    }, []);

    const value = useMemo(() => ({ policy, layout }), [policy, layout]);
    // Motion 组件按同一政策决定是否做位移/缩放：系统减少动态效果或用户关闭网页动效时只保留透明度过渡
    const reducedMotion = policy.reducedMotion || !policy.webMotion ? 'always' : 'never';

    return (
        <MotionContext.Provider value={value}>
            <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
        </MotionContext.Provider>
    );
}

export function useMotionPolicy() {
    return useContext(MotionContext).policy;
}

export function useLayoutPolicy() {
    return useContext(MotionContext).layout;
}

/** 预设选择所需的组合标志。 */
export function useMotionFlags() {
    const { policy, layout } = useContext(MotionContext);
    return { reduced: policy.reducedMotion || !policy.webMotion, touch: layout.touch, sheet: layout.sheet, narrow: layout.narrow };
}
