import React, { forwardRef } from 'react';
import './field.css';

// 边框、聚焦与错误状态在 field.css（fm-field）：平时中性，聚焦时主题色，aria-invalid 时错误色
const TextInput = forwardRef(({ style = {}, className, ...rest }, ref) => {
    const base = {
        padding: '6px 12px',
        height: 44,
        boxSizing: 'border-box',
        borderRadius: 22
    };

    const merged = { ...base, ...style };
    return <input ref={ref} {...rest} className={className ? `fm-field ${className}` : 'fm-field'} style={merged} />;
});

export default TextInput;
