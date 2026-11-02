import React, { forwardRef } from 'react';

/**
 * 44 圆形图标按钮（设计参考 7.2），与面板关闭钮同一样式（overlay.css 的 .fm-icon-button）。
 * icon 是 Material Symbols 名；label 必填（读屏与悬停提示）；spinning 时图标转圈（刷新进行中，对应 iOS 的 ProgressView）。
 */
const IconButton = forwardRef(function IconButton({ icon, label, onClick, disabled = false, spinning = false, className, type = 'button', ...rest }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={['fm-icon-button', 'fm-pressable', className].filter(Boolean).join(' ')}
            aria-label={label}
            title={label}
            aria-busy={spinning || undefined}
            disabled={disabled}
            onClick={onClick}
            {...rest}
        >
            <span className={`material-symbols-outlined${spinning ? ' fm-icon-button__spin' : ''}`} aria-hidden="true">{icon}</span>
        </button>
    );
});

export default IconButton;
