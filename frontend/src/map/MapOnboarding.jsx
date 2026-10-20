// 操作指引：暗色遮罩挖出当前按钮，旁边是“第几步 / 图标 / 说明 / 上一步·下一步”的卡片。
// 门户模态浮层：返回键与 Escape 等同“跳过”，背景 inert，iOS 原生控件按浮层规则收起。
// 步骤表与位置计算见 onboarding.js；找不到目标按钮的步骤在打开时跳过，没有目标的步骤居中显示。

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MotionSurface from '../components/overlay/MotionSurface';
import { findOnboardingTarget, placeOnboardingCard, spotlightFor } from './onboarding';
import { t } from '../i18n/index.js';
import './onboarding.css';

export default function MapOnboarding({ open, session = 0, steps, accent, onAccent, onClose }) {
    const primaryRef = useRef(null);
    return (
        <MotionSurface
            show={open}
            portal
            preset="fade"
            overlay={{ modal: true, kind: 'onboarding', label: t('map:onboarding.label'), onClose: () => onClose?.(), dismissOnBackdrop: false }}
            className="fm-onboarding"
            style={{ '--onboarding-accent': accent, '--onboarding-on-accent': onAccent }}
            initialFocusRef={primaryRef}
            aria-labelledby="fm-onboarding-title"
            aria-describedby="fm-onboarding-body"
        >
            <OnboardingTour key={session} steps={steps} primaryRef={primaryRef} onClose={onClose} />
        </MotionSurface>
    );
}

function OnboardingTour({ steps, primaryRef, onClose }) {
    const rootRef = useRef(null);
    const cardRef = useRef(null);
    // 打开时看不见的按钮（布局不同、尚未渲染）不介绍
    const visibleSteps = useMemo(() => steps.filter((step) => !step.target || findOnboardingTarget(step.target)), [steps]);
    const [stepId, setStepId] = useState(() => visibleSteps[0]?.id);
    const found = visibleSteps.findIndex((step) => step.id === stepId);
    const index = found >= 0 ? found : 0;
    const step = visibleSteps[index];
    const target = step?.target || null;
    const [geometry, setGeometry] = useState(null);

    // 按钮会随动画、键盘、横竖屏移动：逐帧测量，只有变化时才重新渲染
    useLayoutEffect(() => {
        let frame = 0;
        let last = '';
        const measure = () => {
            const root = rootRef.current;
            if (root) {
                const box = root.getBoundingClientRect();
                const el = target ? findOnboardingTarget(target) : null;
                const next = {
                    bounds: { width: box.width, height: box.height },
                    hole: el ? spotlightFor(el.getBoundingClientRect(), box) : null,
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
    }, [target]);

    // 回到第一步时“上一步”按钮消失，焦点交给主按钮
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !rootRef.current?.contains(active)) {
            primaryRef.current?.focus({ preventScroll: true });
        }
    }, [index, primaryRef]);

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
    const placement = bounds && geometry.card ? placeOnboardingCard({ hole, bounds, card: geometry.card }) : null;

    return (
        <div ref={rootRef} className="fm-onboarding__root" onKeyDown={onKeyDown}>
            <div className="fm-onboarding__blocker" aria-hidden="true" />
            {spot && <div
                className={`fm-onboarding__spot${hole ? '' : ' is-empty'}`}
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
