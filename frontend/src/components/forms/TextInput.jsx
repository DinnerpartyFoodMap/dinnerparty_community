import React, { forwardRef } from 'react';
import './field.css';

// 边框、聚焦与错误状态在 field.css（fm-field）：平时中性，聚焦时主题色，aria-invalid 时错误色。
// 圆角 md 12（与多行输入框、原生输入框相同）；搜索框（type="search"）是胶囊
const TextInput = forwardRef(({ style = {}, className, ...rest }, ref) => {
    const base = {
        padding: '6px 12px',
        height: 44,
        boxSizing: 'border-box',
        borderRadius: rest.type === 'search' ? 'var(--radius-full)' : 'var(--radius-md)'
    };

    const merged = { ...base, ...style };
    return <input ref={ref} {...rest} className={className ? `fm-field ${className}` : 'fm-field'} style={merged} />;
});

export default TextInput;
