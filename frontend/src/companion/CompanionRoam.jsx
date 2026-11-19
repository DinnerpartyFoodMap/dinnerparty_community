import React, { useLayoutEffect, useRef, useState } from 'react';
import CompanionFigure from './CompanionFigure';
import { CompanionFlight, companionLift } from './companionFlight';
import { useMotionFlags } from '../motion/MotionProvider';
import './companion.css';

/**
 * 搜索结果列表上沿离地多高。列表从底边展开（出现动画只缩放、底边不动），按布局位置算，不受动画中的 transform 影响；
 * 地面是小伙伴外层（只有左右走的 CSS 动画，没有 transform）的底边。
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

/**
 * 地图底栏上走动的小伙伴。drawer：useMapChrome 的 drawerMotion（iOS 原生控件上拉更多功能时飞起）；
 * searching：搜索已展开，perch 为搜索结果列表元素（没有结果时为 null，在搜索框上方悬停）。
 */
export default function CompanionRoam({ backendUrl, token, companion, bottom, drawer = null, searching = false, perch = null, perchTop = null }) {
    const roam = useRef(null);
    const fly = useRef(null);
    const body = useRef(null);
    const bob = useRef(null);
    const shadow = useRef(null);
    const flight = useRef(null);
    const { reduced } = useMotionFlags();
    const [aloft, setAloft] = useState(false);
    const perchHeight = usePerchHeight(searching ? perch : null, searching ? perchTop : null, roam, bottom);
    const lift = companionLift({ drawer, searchPerch: searching ? perchHeight : null });

    useLayoutEffect(() => {
        const controller = new CompanionFlight({
            roam: roam.current, fly: fly.current, body: body.current, bob: bob.current, shadow: shadow.current,
            onAloftChange: setAloft
        });
        flight.current = controller;
        return () => {
            controller.destroy();
            flight.current = null;
        };
    }, []);

    useLayoutEffect(() => {
        flight.current?.go(lift, { reduced });
    }, [lift, reduced]);

    return <div className="fm-companion-roam" ref={roam} aria-hidden="true" style={{ bottom }}>
        <span className="fm-companion-roam__shadow" ref={shadow} />
        <div className="fm-companion-roam__fly" ref={fly}>
            <div className="fm-companion-roam__body" ref={body}>
                <div className="fm-companion-roam__bob" ref={bob}>
                    <CompanionFigure backendUrl={backendUrl} token={token} companion={companion} mood={aloft ? 'aloft' : null} />
                </div>
            </div>
        </div>
    </div>;
}
