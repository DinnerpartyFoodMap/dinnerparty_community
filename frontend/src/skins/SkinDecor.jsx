import React from 'react';
import { useSkinSlot } from './useSkin.js';

/**
 * 主题边框：九宫格图片（border-image）盖在卡片边缘，不截获点按。父元素需要 position: relative。
 * disabled：液态玻璃面板上不画，外框保持玻璃材质。
 */
export function SkinFrame({ slot, disabled = false }) {
    const frame = useSkinSlot(slot);
    if (!frame || disabled) return null;
    return (
        <span
            aria-hidden="true"
            className="fm-skin-frame"
            style={{
                position: 'absolute', inset: -frame.outset, zIndex: 1, pointerEvents: 'none', boxSizing: 'border-box',
                borderStyle: 'solid', borderColor: 'transparent', borderWidth: frame.width,
                borderImageSource: `url("${frame.image}")`, borderImageSlice: frame.slice, borderImageRepeat: frame.repeat
            }}
        />
    );
}

/** 皮肤里有这个边框时卡片需要的定位 */
export function useSkinFrameActive(slot, disabled = false) {
    return !!useSkinSlot(slot) && !disabled;
}

function Ornament({ value, side }) {
    if (!value) return null;
    return (
        <span
            aria-hidden="true"
            className={`fm-skin-ornament fm-skin-ornament--${side}`}
            style={{
                position: 'absolute', top: value.y, [side === 'start' ? 'left' : 'right']: value.x, width: value.width, height: value.height,
                backgroundImage: `url("${value.image}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat',
                backgroundPosition: side === 'start' ? 'left bottom' : 'right bottom', pointerEvents: 'none', zIndex: 1
            }}
        />
    );
}

/** 底栏两端装饰：以底栏左上角 / 右上角为原点，x 向内为正，y 向下为正 */
export function SkinOrnaments({ prefix }) {
    const start = useSkinSlot(`${prefix}.ornamentStart`);
    const end = useSkinSlot(`${prefix}.ornamentEnd`);
    if (!start && !end) return null;
    return <>
        <Ornament value={start} side="start" />
        <Ornament value={end} side="end" />
    </>;
}
