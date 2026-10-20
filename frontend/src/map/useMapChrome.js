// 地图控件所有权：决定当前由网页工具栏还是 iOS 原生玻璃控件负责地图浮动按钮与底部工具栏。
// 只有主地图（App 中常驻的 MapView、地图页可见、窄屏布局、非选点器）可以成为所有者，
// 防止原生工具栏同时订阅多张地图。

import { useEffect, useRef, useState } from 'react';
import { NativeMapChromeSession, canUseNativeMapChrome, getNativeChromeStatus, subscribeNativeChromeStatus } from '../platform/nativeMapChrome';
import { useMotionPolicy } from '../motion/MotionProvider';

let ownerSeq = 0;

/**
 * @param {{ enabled: boolean, items: Array, theme: object, floatingGap?: number, search?: object, sheet?: object|null, drawer?: object|null,
 *           onAction: (id: string) => (boolean|void), onSearch?: (event: object) => void, onSheet?: (event: object) => void,
 *           onDrawer?: (event: object) => void }} options
 * items 中 sheetWhenNative 为真的按钮在原生模式下打开系统面板而不是网页浮层：不需要先收起工具栏等回执。
 * @returns {{ mode: 'web'|'native', bottomOccupied: number, connecting: boolean }}
 * connecting：可以使用原生控件、握手还没有结果（成功或回退网页）；依赖当前按钮布局的界面（操作指引）等它结束。
 */
export function useMapChrome({ enabled, items, theme, floatingGap = 14, search, sheet = null, drawer = null, onAction, onSearch, onSheet, onDrawer }) {
    const policy = useMotionPolicy();
    const active = !!enabled && policy.nativeGlass && canUseNativeMapChrome();
    const [state, setState] = useState({ mode: 'web', bottomOccupied: 0 });
    const ownerRef = useRef(null);
    if (!ownerRef.current) ownerRef.current = `map-${++ownerSeq}`;
    const sessionRef = useRef(null);
    const [handshake, setHandshake] = useState(() => getNativeChromeStatus().state);
    const onActionRef = useRef(onAction);
    onActionRef.current = onAction;
    const onSearchRef = useRef(onSearch);
    onSearchRef.current = onSearch;
    const onSheetRef = useRef(onSheet);
    onSheetRef.current = onSheet;
    const onDrawerRef = useRef(onDrawer);
    onDrawerRef.current = onDrawer;
    const nativeMode = state.mode === 'native';
    const resolvedItems = items.map(({ sheetWhenNative, ...item }) => (
        sheetWhenNative && nativeMode ? { ...item, opensOverlay: false } : item
    ));
    const snapshot = { items: resolvedItems, theme, floatingGap, search, sheet: nativeMode ? sheet : null, drawer: nativeMode ? drawer : null };
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;

    useEffect(() => {
        if (!active) return undefined;
        const session = new NativeMapChromeSession({
            ownerId: ownerRef.current,
            onAction: (id) => onActionRef.current && onActionRef.current(id),
            onSearch: (event) => onSearchRef.current && onSearchRef.current(event),
            onSheet: (event) => onSheetRef.current && onSheetRef.current(event),
            onDrawer: (event) => onDrawerRef.current && onDrawerRef.current(event),
            onModeChange: (mode) => setState((prev) => (prev.mode === mode ? prev : { ...prev, mode })),
            onLayout: (layout) => setState((prev) => {
                const bottom = Math.round(Number(layout.bottomOccupied) || 0);
                return prev.bottomOccupied === bottom ? prev : { ...prev, bottomOccupied: bottom };
            })
        });
        sessionRef.current = session;
        session.start(snapshotRef.current);
        return () => {
            sessionRef.current = null;
            session.stop();
            setState({ mode: 'web', bottomOccupied: 0 });
        };
    }, [active]);

    useEffect(() => {
        if (!active) return undefined;
        setHandshake(getNativeChromeStatus().state);
        return subscribeNativeChromeStatus((status) => setHandshake(status.state));
    }, [active]);

    // 业务状态变化只更新按钮快照（忙碌、禁用、选中、角标、搜索栏）
    const signature = JSON.stringify(snapshot);
    useEffect(() => {
        sessionRef.current && sessionRef.current.update(snapshotRef.current);
    }, [signature]);

    // 网页工具栏在本次提交中已隐藏，再让原生控件出现：任何时刻只有一组可交互
    useEffect(() => {
        if (state.mode === 'native') sessionRef.current && sessionRef.current.activate();
    }, [state.mode]);

    const connecting = active && state.mode !== 'native' && (handshake === 'idle' || handshake === 'connecting');
    return { ...state, connecting };
}
