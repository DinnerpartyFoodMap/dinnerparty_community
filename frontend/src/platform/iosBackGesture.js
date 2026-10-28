import { backTargetIdentity, dispatchBack } from './backButton.js';
import { getOverlayEntries, subscribeOverlays } from '../components/overlay/overlayStack.js';
import { getMotionPolicy } from '../motion/policy.js';

const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const topOverlay = () => getOverlayEntries().filter(entry => entry.status === 'open' && entry.consumeBack !== false).at(-1);

/** 原生只传进度；网页保留真实页面和输入，确认返回前不调用业务关闭函数。 */
export function createIosBackGesture({ dispatch = dispatchBack, duration = 180 } = {}) {
    let active = null;
    let disposed = false;

    const targetFor = overlay => {
        const surface = overlay ? document.querySelector(`[data-native-back-surface="${overlay.id}"]`)
            : Array.from(document.querySelectorAll('.fm-route-transition')).at(-1) || null;
        return surface?.querySelector('[data-native-back-content]') || surface;
    };
    const unchanged = state => backTargetIdentity() === state.backId && topOverlay()?.id === state.overlayId
        && (!state.target || (state.target.isConnected && targetFor(topOverlay()) === state.target));
    const restoreTarget = state => {
        state.animation?.cancel();
        state.animation = null;
        if (!state.target) return;
        state.target.style.translate = state.original.translate;
        state.target.style.willChange = state.original.willChange;
        state.target.style.pointerEvents = state.original.pointerEvents;
        state.target.style.backgroundColor = state.original.backgroundColor;
        if (state.previous) state.previous.style.visibility = state.previousVisibility;
    };
    const release = state => {
        if (state.released) return;
        state.released = true;
        restoreTarget(state);
        state.indicator.remove();
        if (state.routePreview) window.dispatchEvent(new CustomEvent('foodmap:edge-back-preview', { detail: { active: false } }));
        if (active === state) active = null;
    };
    const paint = (state, progress) => {
        state.progress = clamp(progress);
        if (state.target) state.target.style.translate = `${state.progress * state.width}px 0px`;
        state.indicator.style.opacity = String(0.35 + state.progress * 0.65);
        state.indicator.style.transform = `translateX(${Math.min(18, state.progress * 30)}px) scale(${0.8 + state.progress * 0.2})`;
        state.indicator.style.background = `conic-gradient(var(--theme-primary, #e2789f) ${state.progress * 360}deg, var(--color-bg-surface, #fff) 0deg)`;
        state.indicator.dataset.progress = String(state.progress);
    };
    const animate = async (state, progress) => {
        const ms = getMotionPolicy().reducedMotion ? Math.min(100, duration) : duration;
        if (state.target?.animate && ms > 0) {
            state.animation = state.target.animate([
                { translate: `${state.progress * state.width}px 0px` },
                { translate: `${progress * state.width}px 0px` }
            ], { duration: ms, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' });
            await state.animation.finished.catch(() => {});
        }
        if (active === state && !disposed) paint(state, progress);
    };
    const settle = async (state, committed) => {
        if (state.phase !== 'dragging') return;
        state.phase = 'settling';
        await animate(state, committed ? 1 : 0);
        if (disposed || active !== state) return;
        if (!committed || !unchanged(state)) { release(state); return; }
        state.phase = 'dispatching';
        state.indicator.remove();
        try {
            await dispatch();
            // 面板外壳保留、仅其内容返回上一层：立即回位，不把整个工作区留在屏外。
            if (state.target?.isConnected && active === state && state.overlayId
                && getOverlayEntries().some(entry => entry.id === state.overlayId && entry.status === 'open')) {
                await animate(state, 0);
                return;
            }
            // history.back 与 React 退出是异步的；原页面离场之前保持终点，不再跳回原位。
            if (state.target?.isConnected && active === state) await new Promise(resolve => {
                const observer = new MutationObserver(() => { if (!state.target.isConnected) finish(); });
                const finish = () => { clearTimeout(timer); observer.disconnect(); resolve(); };
                const timer = setTimeout(finish, 450);
                observer.observe(document.body, { childList: true, subtree: true });
                if (!state.target.isConnected) finish();
            });
        } finally { release(state); }
    };
    const unsubscribe = subscribeOverlays(() => {
        const state = active;
        if (!state) return;
        if (state.phase === 'dragging' && !unchanged(state)) void settle(state, false);
        else if (state.phase === 'dispatching' && topOverlay()?.order > state.overlayOrder) {
            // 未保存内容确认等保护弹窗：恢复底下的原页面，等待用户决定。
            // 旧 dispatch 仍可等待确认；新手势必须能返回这层确认，旧 finally 不再干扰它。
            release(state);
        }
    });

    return {
        handle(detail = {}) {
            if (disposed || !['begin', 'change', 'end', 'cancel'].includes(detail.phase)) return;
            if (detail.phase === 'begin') {
                if (active) return;
                const overlay = topOverlay();
                const target = targetFor(overlay);
                const indicator = document.createElement('div');
                indicator.dataset.iosBackProgress = '';
                indicator.setAttribute('aria-hidden', 'true');
                indicator.textContent = '‹';
                Object.assign(indicator.style, {
                    position: 'fixed', zIndex: '2147483646', left: '6px', top: '45%', width: '38px', height: '38px',
                    display: 'grid', placeItems: 'center', borderRadius: '50%', fontSize: '32px', lineHeight: '1',
                    color: 'var(--color-text-primary, #222)', boxShadow: '0 2px 12px #0002', pointerEvents: 'none'
                });
                document.body.appendChild(indicator);
                const previous = target?.parentElement?.querySelector('[data-native-back-previous]');
                const state = { target, indicator, overlayId: overlay?.id, overlayOrder: overlay?.order || 0, backId: backTargetIdentity(), phase: 'dragging',
                    progress: 0, width: target?.getBoundingClientRect().width || window.innerWidth,
                    previous, previousVisibility: previous?.style.visibility, routePreview: !!target?.matches('.fm-route-transition'),
                    original: target ? { translate: target.style.translate, willChange: target.style.willChange, pointerEvents: target.style.pointerEvents, backgroundColor: target.style.backgroundColor } : null };
                active = state;
                if (target) { target.style.willChange = 'translate'; target.style.pointerEvents = 'none'; }
                if (previous) { previous.style.visibility = 'visible'; target.style.backgroundColor = 'var(--color-bg-base)'; }
                if (state.routePreview) window.dispatchEvent(new CustomEvent('foodmap:edge-back-preview', { detail: { active: true } }));
                paint(state, Number(detail.progress));
            } else if (active?.phase === 'dragging') {
                if (detail.phase === 'change') {
                    if (!unchanged(active)) return settle(active, false);
                    paint(active, Number(detail.progress));
                } else {
                    paint(active, Number(detail.progress));
                    return settle(active, detail.phase === 'end' && detail.committed === true && unchanged(active));
                }
            }
        },
        dispose() {
            disposed = true;
            unsubscribe();
            if (active) release(active);
        }
    };
}
