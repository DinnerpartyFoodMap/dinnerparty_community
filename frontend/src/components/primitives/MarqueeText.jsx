import React, { useLayoutEffect, useRef, useState } from 'react';
import './marquee.css';

// 滚动速度（px/s）与单程最短时间（秒）
const SPEED = 32;
const MIN_TRAVEL = 2;

/**
 * 单行文字（展会名等长标题）：放得下时不动；放不下时来回滚动，两端各停一会儿，鼠标悬停时暂停。
 * 减少动态效果或关闭网页动效时不自动滚动，改为可以手动横向滑动。
 */
export default function MarqueeText({ text, className, style }) {
    const boxRef = useRef(null);
    const trackRef = useRef(null);
    const [distance, setDistance] = useState(0);

    useLayoutEffect(() => {
        const box = boxRef.current;
        const track = trackRef.current;
        if (!box || !track) return undefined;
        // offsetWidth 不受滚动动画的 transform 影响
        const update = () => setDistance(Math.max(0, Math.ceil(track.offsetWidth - box.clientWidth)));
        update();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        observer?.observe(box);
        observer?.observe(track);
        return () => observer?.disconnect();
    }, [text]);

    const scrolling = distance > 1;
    // 每一程：前 15% 停在起点，中间 70% 滚动，后 15% 停在终点；alternate 往返
    const duration = Math.max(MIN_TRAVEL, distance / SPEED) / 0.7;
    return (
        <span ref={boxRef} className={`fm-marquee${className ? ` ${className}` : ''}`} data-overflow={scrolling ? '' : undefined}
            style={scrolling ? { ...style, '--fm-marquee-distance': `${-distance}px`, '--fm-marquee-duration': `${duration.toFixed(2)}s` } : style}>
            <span ref={trackRef} className="fm-marquee__track">{text}</span>
        </span>
    );
}
