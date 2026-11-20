import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import CompanionFigure from './CompanionFigure';
import { companionLift } from './companionFlight';
import { CompanionActor } from './companionActor';
import { BOX } from './companionBehavior';
import { CompanionDirector } from './companionDirector';
import { subscribeCompanionActivity } from './companionActivity';
import { useMotionFlags } from '../motion/MotionProvider';
import './companion.css';

/**
 * 搜索结果列表上沿离地多高。列表从底边展开（出现动画只缩放、底边不动），按布局位置算，不受动画中的 transform 影响；
 * 地面是小伙伴外层（没有 transform）的底边。
 */
function usePerchHeight(perch, perchTop, groundRef, bottom) {
    const [height, setHeight] = useState(0);
    useLayoutEffect(() => {
        if (!perch && perchTop == null) {
            setHeight(0);
            return undefined;
        }
        const measure = () => {
            const ground = groundRef.current?.getBoundingClientRect().bottom;
            const parent = perch?.offsetParent;
            const top = perchTop ?? (parent ? parent.getBoundingClientRect().top + perch.offsetTop : null);
            if (!Number.isFinite(ground) || top == null) return;
            setHeight(Math.max(0, Math.round(ground - top)));
        };
        measure();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        if (perch) observer?.observe(perch);
        window.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [perch, perchTop, groundRef, bottom]);
    return height;
}

/** 网页控件时右侧按钮组：标了 data-companion-perch 的元素合起来的外框 */
function domColumn() {
    let box = null;
    for (const element of document.querySelectorAll('[data-companion-perch]')) {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        box = box
            ? { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom) }
            : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return box;
}

/**
 * 地图底栏上的小伙伴：游走、发呆、爬右侧按钮、睡觉、饿和饱由 CompanionDirector 决定（见 companionDirector.js）。
 * drawer：useMapChrome 的 drawerMotion（iOS 原生控件上拉更多功能时飞起）；searching 搜索已展开，perch / perchTop 为结果列表位置。
 * column：右侧按钮组外框（iOS 原生控件由原生回传；不传时找页面上标了 data-companion-perch 的按钮，传 null 表示没有）。
 */
export default function CompanionRoam({ backendUrl, token, companion, bottom, drawer = null, searching = false, perch = null, perchTop = null, column }) {
    const roam = useRef(null);
    const layers = { x: useRef(null), fly: useRef(null), body: useRef(null), bob: useRef(null), shadow: useRef(null), heart: useRef(null) };
    const zzz = [useRef(null), useRef(null), useRef(null)];
    const director = useRef(null);
    const columnRef = useRef(column);
    columnRef.current = column;
    const { reduced } = useMotionFlags();
    const perchHeight = usePerchHeight(searching ? perch : null, searching ? perchTop : null, roam, bottom);
    const lift = companionLift({ drawer, searchPerch: searching && (perch || perchTop != null) ? perchHeight : null });

    useLayoutEffect(() => {
        const actor = new CompanionActor({
            x: layers.x.current, fly: layers.fly.current, body: layers.body.current, bob: layers.bob.current,
            shadow: layers.shadow.current, heart: layers.heart.current, zzz: zzz.map((ref) => ref.current)
        });
        const measure = () => {
            const rect = roam.current.getBoundingClientRect();
            const width = roam.current.offsetParent?.clientWidth || window.innerWidth;
            return { left: rect.left, ground: rect.bottom, width, column: columnRef.current === undefined ? domColumn() : columnRef.current };
        };
        const controller = new CompanionDirector({ actor, measure });
        director.current = controller;
        // 开发时给预览页（tests/integration/companion-roam.html）调状态用
        if (import.meta.env?.DEV) window.__foodmapCompanion = controller;
        controller.start();
        const onVisibility = () => controller.setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', onVisibility);
        const unsubscribe = subscribeCompanionActivity(() => controller.noteActivity());
        return () => {
            unsubscribe();
            document.removeEventListener('visibilitychange', onVisibility);
            controller.destroy();
            actor.destroy();
            director.current = null;
        };
    }, []);

    useLayoutEffect(() => {
        director.current?.update({ lift, reduced, fedAt: companion.fed_at ?? null, adoptedAt: companion.adopted_at ?? null });
    }, [lift, reduced, companion.fed_at, companion.adopted_at]);

    useEffect(() => {
        director.current?.geometryChanged();
    }, [column?.left, column?.top, column?.right, column?.bottom, column === null, bottom, searching]);

    return <div className="fm-companion-roam" ref={roam} aria-hidden="true" style={{ bottom, width: BOX.width, height: BOX.height }}>
        <div className="fm-companion-roam__x" ref={layers.x}>
            <span className="fm-companion-roam__shadow" ref={layers.shadow} />
            <div className="fm-companion-roam__fly" ref={layers.fly}>
                <div className="fm-companion-roam__body" ref={layers.body}>
                    <div className="fm-companion-roam__bob" ref={layers.bob}>
                        <CompanionFigure backendUrl={backendUrl} token={token} companion={companion} reactToFeed={false}
                            onScene={(scene) => director.current?.setScene(scene)} />
                    </div>
                </div>
                <span className="fm-companion-roam__heart" ref={layers.heart}>♥</span>
                {zzz.map((ref, index) => <span key={index} className={`fm-companion-roam__z fm-companion-roam__z--${index}`} ref={ref}>z</span>)}
            </div>
        </div>
    </div>;
}
