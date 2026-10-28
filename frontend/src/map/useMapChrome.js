// 地图控件所有权：决定当前由网页工具栏还是 iOS 原生玻璃控件负责地图浮动按钮与底部工具栏。
// 只有主地图（App 中常驻的 MapView、窄屏布局、非选点器）可以持有原生会话，防止原生工具栏同时订阅多张地图；
// 地图页被其他页面盖住时（visible 为假）会话保留、原生控件收起，回到地图页不必重新握手。

import { useEffect, useRef, useState } from 'react';
import { NativeMapChromeSession, canUseNativeMapChrome, expectNativeMapChrome, getNativeChromeStatus, readTourLayout, subscribeNativeChromeStatus } from '../platform/nativeMapChrome';
import { useMotionPolicy } from '../motion/MotionProvider';

let ownerSeq = 0;
// 首次握手期间最多这么久不显示网页工具栏；超时仍未接管就先显示网页工具栏（之后接管会再切换一次）
const WEB_HOLD_MS = 1500;
// pending：本次启用后的首次握手还没有结果（成功、回退网页或等待超时）
const INITIAL_STATE = Object.freeze({ mode: 'web', bottomOccupied: 0, pending: true, tour: null, showing: false });

/**
 * @param {{ enabled: boolean, visible?: boolean, items: Array, theme: object, floatingGap?: number, search?: object, sheet?: object|null,
 *           drawer?: object|null, skin?: object, tour?: object|null, onAction: (id: string) => (boolean|void), onSearch?: (event: object) => void,
 *           onSheet?: (event: object) => void, onDrawer?: (event: object) => void }} options
 * enabled 决定是否持有原生会话；visible 为假时（地图页被盖住）原生控件收起但会话保留。
 * items 中 sheetWhenNative 为真的按钮在原生模式下打开系统面板而不是网页浮层：不需要先收起工具栏等回执。
 * skin：原生控件的皮肤装饰（skins/nativeSkin.js 的 nativeSkinChrome），按当前深浅色取值。
 * tour：操作指引当前一步要原生指出的控件（{ step, target, drawer }，见 sanitizeTour），没有指引时为 null。
 * @returns {{ mode: 'web'|'native', bottomOccupied: number, connecting: boolean, holdWeb: boolean, tour: object|null }}
 * tour（返回值）：原生回传的指引位置（readTourLayout），供指引挖空遮罩、摆放卡片。
 * connecting：可以使用原生控件、握手还没有结果（成功或回退网页）；依赖当前按钮布局的界面（操作指引）等它结束。
 * holdWeb：预计原生会接管、首次握手还没有结果：网页工具栏先不显示，免得启动时先闪一下网页工具栏再换成原生控件。
 */
export function useMapChrome({ enabled, visible = true, items, theme, floatingGap = 14, search, sheet = null, drawer = null, skin, tour = null, onAction, onSearch, onSheet, onDrawer }) {
    const policy = useMotionPolicy();
    const active = !!enabled && policy.nativeGlass && canUseNativeMapChrome();
    const [state, setState] = useState(INITIAL_STATE);
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
    const snapshot = { items: resolvedItems, theme, floatingGap, search, sheet: nativeMode ? sheet : null, drawer: nativeMode ? drawer : null, skin, tour: nativeMode ? tour : null };
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
                const tourLayout = readTourLayout(layout);
                const tourChanged = JSON.stringify(tourLayout) !== JSON.stringify(prev.tour);
                const showing = !!layout.showing;
                if (prev.bottomOccupied === bottom && !tourChanged && prev.showing === showing) return prev;
                return { ...prev, bottomOccupied: bottom, tour: tourChanged ? tourLayout : prev.tour, showing };
            })
        });
        sessionRef.current = session;
        const settle = () => {
            if (sessionRef.current === session) setState((prev) => (prev.pending ? { ...prev, pending: false } : prev));
        };
        session.start(snapshotRef.current).then(settle, settle);
        return () => {
            sessionRef.current = null;
            session.stop();
            setState(INITIAL_STATE);
        };
    }, [active]);

    // 在会话创建之后执行：新会话也立即知道地图页当前是否被盖住
    useEffect(() => {
        sessionRef.current && sessionRef.current.setPageHidden(!visible);
    }, [active, visible]);

    useEffect(() => {
        if (!active) return undefined;
        setHandshake(getNativeChromeStatus().state);
        return subscribeNativeChromeStatus((status) => setHandshake(status.state));
    }, [active]);

    const holdWeb = active && state.pending && state.mode !== 'native' && expectNativeMapChrome();
    useEffect(() => {
        if (!holdWeb) return undefined;
        const timer = setTimeout(() => setState((prev) => (prev.pending ? { ...prev, pending: false } : prev)), WEB_HOLD_MS);
        return () => clearTimeout(timer);
    }, [holdWeb]);

    // 业务状态变化只更新按钮快照（忙碌、禁用、选中、角标、搜索栏）
    const signature = JSON.stringify(snapshot);
    useEffect(() => {
        sessionRef.current && sessionRef.current.update(snapshotRef.current);
    }, [signature]);

    // 网页工具栏在本次提交中已隐藏，再让原生控件出现：任何时刻只有一组可交互
    useEffect(() => {
        if (state.mode === 'native') sessionRef.current && sessionRef.current.activate();
    }, [state.mode]);

    // pending 覆盖“上一个会话留下的状态还是 native、新会话刚开始握手”的情形
    const connecting = active && state.mode !== 'native' && (state.pending || handshake === 'idle' || handshake === 'connecting');
    return { mode: state.mode, bottomOccupied: state.bottomOccupied, connecting, holdWeb, tour: state.mode === 'native' ? state.tour : null, showing: state.mode === 'native' && state.showing };
}
