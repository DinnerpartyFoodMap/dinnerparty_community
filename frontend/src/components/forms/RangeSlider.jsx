import React from 'react';
import './rangeSlider.css';

// 双滑块范围拉杆：两个叠放的 range 输入共用一条轨道，键盘、读屏与触摸都由原生输入处理。
// value 是 [低, 高]，两端不会交叉；formatValue 生成每个滑块的读屏文字。
export default function RangeSlider({ min, max, step = 1, value, onChange, labels = [], formatValue = String, accent }) {
    const [low, high] = value;
    const span = Math.max(1, max - min);
    const lowPercent = ((low - min) / span) * 100;
    const highPercent = ((high - min) / span) * 100;
    const setLow = (next) => onChange([Math.min(Number(next), high), high]);
    const setHigh = (next) => onChange([low, Math.max(Number(next), low)]);
    return (
        <div className="fm-range" style={accent ? { '--fm-range-accent': accent } : undefined} data-no-sheet-drag="">
            <div className="fm-range__track" aria-hidden="true">
                <div className="fm-range__fill" style={{ left: `${lowPercent}%`, right: `${100 - highPercent}%` }} />
            </div>
            <input
                type="range" className="fm-range__input" min={min} max={max} step={step} value={low}
                aria-label={labels[0]} aria-valuetext={formatValue(low)}
                // 低端滑块拉到最右时浮到上层，否则会被高端滑块挡住拉不回来
                style={{ zIndex: low >= max - step ? 3 : 2 }}
                onChange={(event) => setLow(event.target.value)}
            />
            <input
                type="range" className="fm-range__input" min={min} max={max} step={step} value={high}
                aria-label={labels[1]} aria-valuetext={formatValue(high)}
                onChange={(event) => setHigh(event.target.value)}
            />
        </div>
    );
}
