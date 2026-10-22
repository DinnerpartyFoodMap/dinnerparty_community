// 操作指引：暗色遮罩挖出当前按钮，旁边是“第几步 / 图标 / 说明 / 在哪里 / 上一步·下一步”的卡片。
// 门户模态浮层：返回键与 Escape 等同“跳过”，背景 inert。
// 步骤表与位置计算见 onboarding.js；找不到目标按钮的步骤在打开时跳过，没有目标的步骤居中显示。
// iOS 原生工具栏（keepNative）：原生控件不收起，由原生画高亮圈并回传位置（nativeTour）；遮罩在原生控件下方，
// 这里只挖空它下方的地图，说明卡片避开所有原生控件（原生画在网页之上，会盖住卡片）。

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MotionSurface from '../components/overlay/MotionSurface';
import { findOnboardingTarget, nativeTourRect, placeOnboardingCard, spotlightFor, unionBox } from './onboarding';
import { t } from '../i18n/index.js';
import './onboarding.css';

// 等原生回传当前一步目标位置的最长时间（握手正常时约一两帧加 60ms 的布局合并）
const NATIVE_WAIT_MS = 600;

/**
 * keepNative：iOS 原生工具栏在指引期间保持显示（不按浮层规则收起），由 nativeTour（useMapChrome 的 tour）提供目标位置。
 * onStepChange(step)：当前一步变化时通知（原生据此高亮对应控件）。
 */
export default function MapOnboarding({ open, session = 0, steps, accent, onAccent, onClose, keepNative = false, nativeTour = null, onStepChange }) {
    const primaryRef = useRef(null);
    return (
        <MotionSurface
            show={open}
            portal
            preset="fade"
            overlay={{ modal: true, kind: 'onboarding', label: t('map:onboarding.label'), onClose: () => onClose?.(), dismissOnBackdrop: false, suspendNative: !keepNative }}
            className="fm-onboarding"
            style={{ '--onboarding-accent': accent, '--onboarding-on-accent': onAccent }}
            initialFocusRef={primaryRef}
            aria-labelledby="fm-onboarding-title"
            aria-describedby="fm-onboarding-body fm-onboarding-where"
        >
            <OnboardingTour key={session} steps={steps} primaryRef={primaryRef} onClose={onClose} nativeTour={nativeTour} onStepChange={onStepChange} />
        </MotionSurface>
    );
}

function OnboardingTour({ steps, primaryRef, onClose, nativeTour, onStepChange }) {
    const rootRef = useRef(null);
    const cardRef = useRef(null);
    // 逐帧测量里读最新的原生位置，不因原生每次回传布局重启测量
    const nativeTourRef = useRef(nativeTour);
    nativeTourRef.current = nativeTour;
    const onStepChangeRef = useRef(onStepChange);
    onStepChangeRef.current = onStepChange;
    // 打开时看不见的按钮（布局不同、尚未渲染）不介绍
    const visibleSteps = useMemo(() => steps.filter((step) => !step.target || findOnboardingTarget(step.target)), [steps]);
    const [stepId, setStepId] = useState(() => visibleSteps[0]?.id);
    const found = visibleSteps.findIndex((step) => step.id === stepId);
    const index = found >= 0 ? found : 0;
    const step = visibleSteps[index];
    const target = step?.target || null;
    const [geometry, setGeometry] = useState(null);

    useEffect(() => {
        onStepChangeRef.current?.(step || null);
    }, [step]);

    // 按钮会随动画、键盘、横竖屏移动：逐帧测量，只有变化时才重新渲染
    useLayoutEffect(() => {
        let frame = 0;
        let last = '';
        const startedAt = performance.now();
        const measure = () => {
            const root = rootRef.current;
            const native = step?.native ? nativeTourRef.current : null;
            const nativeRect = nativeTourRect(step, native);
            // 原生目标的位置要等原生高亮后回传：稍等片刻再按“没有目标”居中，免得每换一步高亮框都先缩回中心再展开
            const waiting = !!step?.native?.target && !nativeRect && performance.now() - startedAt < NATIVE_WAIT_MS;
            if (root && !waiting) {
                const box = root.getBoundingClientRect();
                const el = target ? findOnboardingTarget(target) : null;
                const toLayer = (rect) => rect && { left: rect.left - box.left, top: rect.top - box.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
                const next = {
                    bounds: { width: box.width, height: box.height },
                    hole: el ? spotlightFor(el.getBoundingClientRect(), box) : (nativeRect ? spotlightFor(nativeRect, box) : null),
                    native: !!nativeRect,
                    // 原生控件画在网页之上：卡片要连同它们一起避开
                    avoid: native ? toLayer(native.chrome) : null,
                    card: cardRef.current ? { width: cardRef.current.offsetWidth, height: cardRef.current.offsetHeight } : null
                };
                const key = JSON.stringify(next);
                if (key !== last) {
                    last = key;
                    setGeometry(next);
                }
            }
            frame = requestAnimationFrame(measure);
        };
        measure();
        return () => cancelAnimationFrame(frame);
    }, [target, step]);

    // 回到第一步时“上一步”按钮消失，焦点交给主按钮
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !rootRef.current?.contains(active)) {
            primaryRef.current?.focus({ preventScroll: true });
        }
    }, [index, primaryRef]);

    // 练习上滑：用户真的把原生工具栏拉开后进入下一步（布局里的 drawerOpen 只认当前这一步）
    const practiced = !!step?.practice && nativeTour?.step === step.id && !!nativeTour.drawerOpen;
    const nextStepId = visibleSteps[index + 1]?.id;
    useEffect(() => {
        if (practiced && nextStepId) setStepId(nextStepId);
    }, [practiced, nextStepId]);

    if (!step) return null;
    const total = visibleSteps.length;
    const isLast = index === total - 1;
    const go = (delta) => {
        const next = visibleSteps[index + delta];
        if (next) setStepId(next.id);
    };
    const advance = () => (isLast ? onClose?.() : go(1));
    const onKeyDown = (event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); advance(); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    };

    const bounds = geometry?.bounds;
    const hole = geometry?.hole || null;
    // 没有目标时高亮框缩成中心的一点，遮罩铺满全屏；切到有目标的步骤时从中心展开过去
    const spot = hole || (bounds ? { left: bounds.width / 2, top: bounds.height / 2, width: 0, height: 0, radius: 0 } : null);
    // 原生目标还没回传位置时卡片先居中，不贴着原生控件
    const obstacle = hole && geometry.avoid ? unionBox(hole, geometry.avoid) : hole;
    const placement = bounds && geometry.card ? placeOnboardingCard({ hole: obstacle, bounds, card: geometry.card }) : null;

    return (
        <div ref={rootRef} className="fm-onboarding__root" onKeyDown={onKeyDown}>
            <div className="fm-onboarding__blocker" aria-hidden="true" />
            {spot && <div
                className={`fm-onboarding__spot${hole ? '' : ' is-empty'}${geometry.native ? ' is-native' : ''}`}
                aria-hidden="true"
                style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height, borderRadius: spot.radius }}
            />}
            <section
                ref={cardRef}
                className="fm-onboarding__card"
                data-side={placement?.side}
                style={placement ? { left: placement.left, top: placement.top } : { left: 0, top: 0, visibility: 'hidden' }}
            >
                <div className="fm-onboarding__head">
                    <span className="fm-onboarding__icon material-symbols-outlined" aria-hidden="true">{step.icon}</span>
                    <span className="fm-onboarding__count">{t('map:onboarding.progress', { current: index + 1, total })}</span>
                    {!isLast && <button type="button" className="fm-onboarding__skip" onClick={() => onClose?.()}>
                        {t('map:onboarding.skip')}
                    </button>}
                </div>
                <div aria-live="polite">
                    <h2 id="fm-onboarding-title" className="fm-onboarding__title">{step.title}</h2>
                    <p id="fm-onboarding-body" className="fm-onboarding__body">{step.body}</p>
                    {step.where && <p id="fm-onboarding-where" className="fm-onboarding__where">
                        <span className="material-symbols-outlined" aria-hidden="true">{step.where.icon}</span>
                        <span>{step.where.text}</span>
                    </p>}
                    {step.hint && <p className="fm-onboarding__hint">{step.hint}</p>}
                </div>
                <div className="fm-onboarding__footer">
                    <div className="fm-onboarding__dots" aria-hidden="true">
                        {visibleSteps.map((item, i) => <span key={item.id} className={i === index ? 'is-active' : undefined} />)}
                    </div>
                    <div className="fm-onboarding__actions">
                        {index > 0 && <button type="button" className="fm-onboarding__button" onClick={() => go(-1)}>
                            {t('map:onboarding.prev')}
                        </button>}
                        <button ref={primaryRef} type="button" className="fm-onboarding__button fm-onboarding__button--primary" onClick={advance}>
                            {isLast ? t('map:onboarding.done') : t('map:onboarding.next')}
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
}
