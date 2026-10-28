import React from 'react';
import { axisLabel, valueWord } from './tasteAxes';
import { t } from '../i18n/index.js';

// 六类餐饮偏好的雷达。每轴独立：有依据的轴画一个点和一条从中心出发的线，相邻两轴都有值时用淡线连起来；
// “待了解”的轴不画点（不当成 0），轴名旁写“待了解”。不填充面积、不算总分。估算出来的轴用空心点区分。
// 画布按 300 设计、按显示宽度缩放：轴名 15、评价 12.5，在 300px 宽时就是实际字号
const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = 80;
const LABEL_RADIUS = 102;
// 上下各裁掉一截空白（最上面的轴名约从 y=30 开始，最下面的评价到 y≈270）
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
                return <line key={`link-${axis.key}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={accent} strokeOpacity={0.35} strokeWidth={1.5} />;
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
                        <text x={x} y={y + 13} textAnchor={anchor} fontSize={12.5} fill="var(--color-text-muted)">
                            {axis.value === null ? t('profile:taste.unknown') : valueWord(axis.value)}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
