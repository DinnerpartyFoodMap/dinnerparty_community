import React from 'react';
import './segmented.css';

/**
 * 分段控件（单选）：options 为 [value, label] 或 { value, label }，选中项调用 onChange(value)。
 * role 默认 radiogroup（各项为 radio / aria-checked）；切换页面内容时用 tablist（各项为 tab / aria-selected）。
 * size="sm" 为紧凑的行内版本。iOS 原生对应 .pickerStyle(.segmented)。
 */
export default function Segmented({ options, value, onChange, label, role = 'radiogroup', size = 'md', disabled = false, className, style }) {
    const tabs = role === 'tablist';
    const classes = ['fm-segmented', size === 'sm' ? 'fm-segmented--sm' : null, className].filter(Boolean).join(' ');
    return (
        <div className={classes} role={role} aria-label={label} style={style}>
            {options.map((option) => {
                const [optionValue, optionLabel] = Array.isArray(option) ? option : [option.value, option.label];
                const selected = optionValue === value;
                return (
                    <button
                        type="button"
                        key={String(optionValue)}
                        className="fm-segmented__item"
                        role={tabs ? 'tab' : 'radio'}
                        {...(tabs ? { 'aria-selected': selected } : { 'aria-checked': selected })}
                        disabled={disabled}
                        onClick={() => onChange && onChange(optionValue)}
                    >
                        {optionLabel}
                    </button>
                );
            })}
        </div>
    );
}
