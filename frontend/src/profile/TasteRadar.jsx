import React from 'react';
import { axisLabel, valueWord } from './tasteAxes';
import { t } from '../i18n/index.js';

// 六类餐饮偏好的雷达。每轴独立：有依据的轴画一个点和一条从中心出发的线，相邻两轴都有值时用淡线连起来；
// 未知轴不画点；仅在两个相邻已知轴与中心围出的区域填色，避免给未知轴编造数值。估算轴用空心点区分。
// 轴值描述保留在读屏标签中，画面只显示类别名。
const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = 80;
const LABEL_RADIUS = 102;
// 上下各裁掉一截空白，保留六个类别名。
const CROP = 18;
const HEIGHT = SIZE - CROP * 2;

function point(index, ratio) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 6;
    return [CENTER + Math.cos(angle) * RADIUS * ratio, CENTER + Math.sin(angle) * RADIUS * ratio];
}

export default function TasteRadar({ axes, selected, onSelect, accent = 'var(--theme-primary, #e2789f)', size = SIZE }) {
    const rings = [0.25, 0.5, 0.75, 1];
    const polygon = (ratio) => axes.map((_, index) => point(index, ratio).join(',')).join(' ');
    return (
        <svg
            viewBox={`0 ${CROP} ${SIZE} ${HEIGHT}`}
            width={size}
            height={Math.round((size * HEIGHT) / SIZE)}
            role="group"
            aria-label={t('profile:taste.title')}
            style={{ display: 'block', overflow: 'visible', maxWidth: '100%' }}
        >
            {rings.map((ratio) => (
                <polygon key={ratio} points={polygon(ratio)} fill="none" stroke="var(--color-border)" strokeWidth={ratio === 0.5 ? 1.2 : 0.8} strokeDasharray={ratio === 0.5 ? '3 3' : undefined} />
            ))}
            {axes.map((_, index) => {
                const [x, y] = point(index, 1);
                return <line key={index} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="var(--color-border)" strokeWidth={0.8} />;
            })}
            {axes.map((axis, index) => {
                const next = axes[(index + 1) % axes.length];
                if (axis.value === null || next.value === null) return null;
                const [x1, y1] = point(index, axis.value);
                const [x2, y2] = point((index + 1) % axes.length, next.value);
                return <g key={`link-${axis.key}`}>
                    <polygon points={`${CENTER},${CENTER} ${x1},${y1} ${x2},${y2}`} fill={accent} fillOpacity={0.2} />
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent} strokeOpacity={0.65} strokeWidth={1.5} />
                </g>;
            })}
            {axes.map((axis, index) => {
                if (axis.value === null) return null;
                const [x, y] = point(index, axis.value);
                const estimated = axis.basis === 'embedding';
                return (
                    <g key={`value-${axis.key}`}>
                        <line x1={CENTER} y1={CENTER} x2={x} y2={y} stroke={accent} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={estimated ? '4 3' : undefined} />
                        <circle cx={x} cy={y} r={5} fill={estimated ? 'var(--color-bg-surface)' : accent} stroke={accent} strokeWidth={2} />
                    </g>
                );
            })}
            {axes.map((axis, index) => {
                const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 6;
                const x = CENTER + Math.cos(angle) * LABEL_RADIUS;
                const y = CENTER + Math.sin(angle) * LABEL_RADIUS;
                const anchor = Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : (Math.cos(angle) > 0 ? 'start' : 'end');
                const active = selected === axis.key;
                return (
                    <g
                        key={`label-${axis.key}`}
                        role="button"
                        tabIndex={0}
                        aria-pressed={active}
                        aria-label={t('profile:taste.axisAria', { axis: axisLabel(axis.key), value: valueWord(axis.value) })}
                        onClick={() => onSelect?.(axis.key)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onSelect?.(axis.key);
                            }
                        }}
                        style={{ cursor: 'pointer', outline: 'none' }}
                    >
                        <text x={x} y={y - 3} textAnchor={anchor} fontSize={15} fontWeight={active ? 700 : 500} fill={active ? accent : 'var(--color-text-primary)'}>
                            {axisLabel(axis.key)}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
