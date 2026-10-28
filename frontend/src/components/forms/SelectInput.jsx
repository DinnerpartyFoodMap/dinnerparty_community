import React, { forwardRef } from 'react';
import './field.css';

// 边框、聚焦与错误状态在 field.css（fm-field），与 TextInput 一致
const SelectInput = forwardRef(({ style = {}, className, children, ...rest }, ref) => {
    const base = {
        padding: '6px 12px',
        height: 44,
        boxSizing: 'border-box',
        borderRadius: 22
    };

    const merged = { ...base, ...style };
    return (
        <select ref={ref} {...rest} className={className ? `fm-field ${className}` : 'fm-field'} style={merged}>
            {children}
        </select>
    );
});

export default SelectInput;
