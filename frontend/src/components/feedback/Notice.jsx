import React, { forwardRef } from 'react';
import { t } from "../../i18n/index.js";
import { parseColorToRgb, pickContrastTextColor, srgbToLinear } from "../../theme/theme";

function pickBorderColor(bgColor) {
    const rgb = parseColorToRgb(bgColor);
    if (!rgb) return 'rgba(0, 0, 0, 0.12)';
    const luminance = 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
    return luminance > 0.6 ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.2)';
}

// 语义色提示：淡色底 + 语义色描边，文字用加深的文字色（浅色模式下对比度足够）
const TONE_COLORS = Object.fromEntries(['info', 'warning', 'danger', 'success'].map((tone) => [tone, {
    bg: `color-mix(in srgb, var(--color-${tone}) 12%, var(--color-bg-surface))`,
    border: `var(--color-${tone})`,
    text: `var(--color-${tone}-text)`
}]));

const Notice = forwardRef(function Notice({ title, children, tone = 'info', backgroundColor, canClose = false, onClose, zIndex = 3000, style }, ref) {
    const palette = TONE_COLORS[tone] || TONE_COLORS.info;
    const hasCustomBackground = typeof backgroundColor === 'string' && backgroundColor.trim();
    // 自定义底色是具体色值时按亮度选文字与描边；是 CSS 表达式（公告颜色的 color-mix，深浅自动）时用正文色与普通描边
    const customIsColor = hasCustomBackground && !!parseColorToRgb(backgroundColor);
    const mergedBackground = hasCustomBackground ? backgroundColor : palette.bg;
    const mergedBorder = hasCustomBackground ? (customIsColor ? pickBorderColor(mergedBackground) : 'var(--color-border)') : palette.border;
    const mergedText = hasCustomBackground ? (customIsColor ? pickContrastTextColor(mergedBackground) : 'var(--color-text-primary)') : palette.text;

    const rootStyle = {
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(960px, calc(100% - 24px))',
        maxWidth: '960px',
        minWidth: 0,
        boxSizing: 'border-box',
        zIndex: 2000,
        padding: '12px 16px',
        borderRadius: 'var(--radius-md)',
        background: mergedBackground,
        border: `1px solid ${mergedBorder}`,
        color: mergedText,
        textAlign: 'center',
        boxShadow: 'var(--shadow-surface)',
        ...style
    };

    const closeBtnStyle = {
        position: 'absolute',
        top: 6,
        right: 8,
        border: 'none',
        background: 'transparent',
        color: mergedText,
        fontSize: 16,
        cursor: 'pointer',
        lineHeight: '1'
    };

    return (
        <div ref={ref} className="fm-notice" style={rootStyle}>
            {canClose && (
                <button aria-label={t('common:action.close')} style={closeBtnStyle} onClick={onClose}>×</button>
            )}
            {title && <div style={{ fontWeight: 700 }}>{title}</div>}
            {children && <div style={{ marginTop: title ? 6 : 0 }}>{children}</div>}
        </div>
    );
});

export default Notice;
