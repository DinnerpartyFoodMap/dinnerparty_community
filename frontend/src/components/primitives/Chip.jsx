import React from 'react';
import './chip.css';

const TONES = new Set(['secondary', 'primary', 'success', 'danger']);

/**
 * 可点的芯片（筛选标签、分类）：selected 决定选中样式，tone 为选中时的色调（默认辅色），icon 是 Material Symbols 名。
 * 无障碍状态（aria-pressed / aria-checked）由调用方按语义传入。
 */
export default function Chip({ selected = false, tone = 'secondary', icon, children, className, type = 'button', ...rest }) {
    const classes = [
        'fm-chip',
        'fm-pressable',
        TONES.has(tone) && tone !== 'secondary' ? `fm-chip--${tone}` : null,
        selected ? 'is-selected' : null,
        className
    ].filter(Boolean).join(' ');
    return (
        <button type={type} className={classes} {...rest}>
            {icon && <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>}
            {children}
        </button>
    );
}
