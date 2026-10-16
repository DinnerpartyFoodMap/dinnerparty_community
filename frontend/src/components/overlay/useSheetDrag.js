// 底部面板拖动：拖动时不播放缓动，直接跟随手指；释放时结合位移比例与速度判断关闭、切换停靠或回弹。
//
// 规则：
// - 只在内容滚动到顶部、且从允许区域开始时接管向下的拖动；把手和标题区任何时候都可拖。
// - 先做方向判定：横向手势（以及地图手势）不被抢占。
// - 输入框、按钮、链接与 [data-no-sheet-drag] 区域不会被拖动手势误捕获。
// - touchcancel / pointercancel 一律回弹，不执行关闭。
// - 使用原生 touch 事件并显式 { passive: false }：只有这样才能在决定拖动后阻止内容滚动
//   （main.jsx 会把未声明 passive 的 touch 监听器默认改成 passive）。

import { useEffect, useRef } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { SPRING } from '../../motion/presets.js';

const IGNORE = 'input, textarea, select, button, a[href], [contenteditable="true"], [data-no-sheet-drag]';
const LOCK_DISTANCE = 6;
const DISMISS_RATIO = 0.3;
const DISMISS_VELOCITY = 0.55; // px/ms

/**
 * @param {{ enabled: boolean, sheetRef: { current: HTMLElement }, onDismiss: () => void,
 *           snapOffsets?: number[] | null, initialSnap?: number, reduced?: boolean }} options
 * snapOffsets：可选停靠位置（相对完全展开的向下偏移，px，升序，第一个通常为 0）。
 */
export function useSheetDrag({ enabled, sheetRef, onDismiss, snapOffsets = null, initialSnap = 0, reduced = false }) {
    const y = useMotionValue(snapOffsets ? snapOffsets[initialSnap] || 0 : 0);
    const optionsRef = useRef({ onDismiss, snapOffsets, reduced });
    optionsRef.current = { onDismiss, snapOffsets, reduced };

    useEffect(() => {
        const sheet = sheetRef.current;
        if (!enabled || !sheet) return undefined;
        let state = null;
        let animation = null;

        const settleTo = (target) => {
            animation && animation.stop();
            animation = optionsRef.current.reduced
                ? animate(y, target, { duration: 0.12 })
                : animate(y, target, SPRING.settle);
        };

        const begin = (target, x0, y0, id) => {
            if (target.closest(IGNORE)) return;
            const fromHandle = !!target.closest('[data-sheet-grabber], [data-sheet-header]');
            const scroller = target.closest('[data-sheet-scroll]');
            if (!fromHandle && scroller && scroller.scrollTop > 0) return;
            animation && animation.stop();
            state = { id, x0, y0, offset0: y.get(), fromHandle, scroller, locked: false, samples: [{ t: performance.now(), y: y0 }] };
        };

        const move = (x, yy, event) => {
            if (!state) return;
            const dx = x - state.x0;
            const dy = yy - state.y0;
            if (!state.locked) {
                if (Math.hypot(dx, dy) < LOCK_DISTANCE) return;
                const snaps = optionsRef.current.snapOffsets;
                const canExpand = !!snaps && state.offset0 > snaps[0];
                if (Math.abs(dy) <= Math.abs(dx) || (dy < 0 && !state.fromHandle && !canExpand)) {
                    state = null; // 横向或向上滚动内容：交还给浏览器
                    return;
                }
                if (!state.fromHandle && state.scroller && state.scroller.scrollTop > 0) {
                    state = null;
                    return;
                }
                state.locked = true;
            }
            if (event && event.cancelable) event.preventDefault();
            const snaps = optionsRef.current.snapOffsets;
            const min = snaps ? snaps[0] : 0;
            let next = state.offset0 + dy;
            if (next < min) next = min - Math.pow(min - next, 0.7); // 越过展开位置时的阻尼
            y.set(next);
            state.samples.push({ t: performance.now(), y: yy });
            if (state.samples.length > 6) state.samples.shift();
        };

        const end = (cancelled) => {
            const s = state;
            state = null;
            if (!s || !s.locked) return;
            const snaps = optionsRef.current.snapOffsets;
            const current = y.get();
            if (cancelled) {
                settleTo(snaps ? nearest(snaps, s.offset0) : 0);
                return;
            }
            const first = s.samples[0];
            const last = s.samples[s.samples.length - 1];
            const dt = Math.max(1, last.t - first.t);
            const velocity = (last.y - first.y) / dt;
            const height = sheet.getBoundingClientRect().height || 1;
            const lastSnap = snaps ? snaps[snaps.length - 1] : 0;
            const travelled = current - lastSnap;
            if ((travelled > (height - lastSnap) * DISMISS_RATIO && velocity > -0.1) || velocity > DISMISS_VELOCITY) {
                if (snaps && velocity > DISMISS_VELOCITY && current < lastSnap) {
                    // 快速下滑但还在较高的停靠位：先落到下一档
                    settleTo(snaps.find((o) => o > current) ?? lastSnap);
                    return;
                }
                optionsRef.current.onDismiss && optionsRef.current.onDismiss();
                return;
            }
            if (snaps) {
                const projected = current + velocity * 120;
                settleTo(nearest(snaps, projected));
            } else {
                settleTo(0);
            }
        };

        const onTouchStart = (event) => {
            if (event.touches.length !== 1) { state = null; return; }
            const t = event.touches[0];
            begin(event.target, t.clientX, t.clientY, 'touch');
        };
        const onTouchMove = (event) => {
            if (!state || event.touches.length !== 1) return;
            const t = event.touches[0];
            move(t.clientX, t.clientY, event);
        };
        const onTouchEnd = () => end(false);
        const onTouchCancel = () => end(true);

        // 鼠标（窄窗口桌面）只允许从把手拖动
        const onPointerDown = (event) => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            if (!event.target.closest('[data-sheet-grabber], [data-sheet-header]')) return;
            begin(event.target, event.clientX, event.clientY, event.pointerId);
            if (state) sheet.setPointerCapture && sheet.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event) => {
            if (!state || state.id !== event.pointerId) return;
            move(event.clientX, event.clientY, event);
        };
        const onPointerUp = (event) => { if (state && state.id === event.pointerId) end(false); };
        const onPointerCancel = (event) => { if (state && state.id === event.pointerId) end(true); };

        sheet.addEventListener('touchstart', onTouchStart, { passive: true });
        sheet.addEventListener('touchmove', onTouchMove, { passive: false });
        sheet.addEventListener('touchend', onTouchEnd);
        sheet.addEventListener('touchcancel', onTouchCancel);
        sheet.addEventListener('pointerdown', onPointerDown);
        sheet.addEventListener('pointermove', onPointerMove);
        sheet.addEventListener('pointerup', onPointerUp);
        sheet.addEventListener('pointercancel', onPointerCancel);
        return () => {
            animation && animation.stop();
            sheet.removeEventListener('touchstart', onTouchStart);
            sheet.removeEventListener('touchmove', onTouchMove);
            sheet.removeEventListener('touchend', onTouchEnd);
            sheet.removeEventListener('touchcancel', onTouchCancel);
            sheet.removeEventListener('pointerdown', onPointerDown);
            sheet.removeEventListener('pointermove', onPointerMove);
            sheet.removeEventListener('pointerup', onPointerUp);
            sheet.removeEventListener('pointercancel', onPointerCancel);
        };
    }, [enabled, sheetRef, y]);

    return y;
}

function nearest(list, value) {
    let best = list[0];
    for (const item of list) if (Math.abs(item - value) < Math.abs(best - value)) best = item;
    return best;
}
