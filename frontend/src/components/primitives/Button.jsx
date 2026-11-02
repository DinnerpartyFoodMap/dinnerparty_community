import React from 'react';
import './button.css';

const VARIANTS = new Set(['primary', 'secondary', 'plain', 'destructive', 'menu']);
const SIZES = { sm: 'sm', small: 'sm', md: 'md', lg: 'lg', large: 'lg' };

/**
 * 按钮：variant 为 primary（默认，主题色底）/ secondary / plain（文字按钮）/ destructive / menu（菜单行），
 * size 为 sm / md（默认）/ lg，full 占满一行。样式在 button.css，style 只用来做个别调整。
 */
export default function Button({ children, onClick, disabled, style, title, variant = 'primary', size = 'md', full = false, type = 'button', className, ...rest }) {
    let resolvedVariant = VARIANTS.has(variant) ? variant : 'primary';
    // 调用方自己给了底色（图标按钮、语义色按钮）：按 secondary 的基础样式（正文色文字、细边框），
    // 与旧版一致——主题色底上的文字色放到别的底色上可能看不清
    const customBackground = style && [style.background, style.backgroundColor].find((value) => value !== undefined);
    if (resolvedVariant === 'primary' && customBackground !== undefined && !String(customBackground).includes('--theme-primary')) {
        resolvedVariant = 'secondary';
    }
    const resolvedSize = SIZES[size] || 'md';
    const classes = [
        'fm-button',
        `fm-button--${resolvedVariant}`,
        resolvedSize !== 'md' && resolvedVariant !== 'menu' ? `fm-button--${resolvedSize}` : null,
        full ? 'fm-button--full' : null,
        // 按压反馈：指针设备很轻的缩放，触屏按下跟手、松手回弹（见 overlay.css 的 .fm-pressable）
        resolvedVariant === 'menu' ? null : 'fm-pressable',
        className
    ].filter(Boolean).join(' ');

    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            title={title}
            style={style}
            className={classes}
            {...rest}
        >
            {children}
        </button>
    );
}
