import React, { forwardRef, useState } from 'react';
import Markdown from "../markdown/Markdown";
import { t } from "../../i18n/index.js";
import './field.css';

// markdown：输入框下方提示支持基础 Markdown，并可切换到预览（预览用 Markdown 组件，HTML 不解析）。
// 预览时输入框仍保留在页面里（只是隐藏），表单状态、ref 与提交都不受影响。
const TextArea = forwardRef(({ style = {}, className, rows, markdown = false, ...rest }, ref) => {
    const [preview, setPreview] = useState(false);

    const base = {
        padding: '6px 12px',
        boxSizing: 'border-box',
        borderRadius: 22,
        // Chrome gives <textarea> a different user-agent font by default.
        // Inherit the application font so edit descriptions match labels and other fields.
        fontFamily: 'inherit',
        fontSize: 16,
        lineHeight: 1.5,
        resize: 'vertical',
        minHeight: 80
    };

    const merged = { ...base, ...style };
    // 边框、聚焦与错误状态在 field.css（fm-field）
    const fieldClass = className ? `fm-field ${className}` : 'fm-field';
    const props = { ref, ...rest, className: fieldClass, style: merged };
    if (rows) props.rows = rows;
    if (!markdown) return <textarea {...props} />;

    const { width, ...fieldStyle } = merged;
    const value = typeof rest.value === 'string' ? rest.value : '';
    return (
        <div style={{ width, maxWidth: '100%', boxSizing: 'border-box' }}>
            <textarea {...props} style={{ ...fieldStyle, width: '100%', display: preview ? 'none' : undefined }} />
            {preview && (
                <div className={fieldClass} role="region" aria-label={t('common:markdown.previewLabel')}
                    style={{ ...fieldStyle, width: '100%', resize: 'none', overflowY: 'auto', fontSize: 15, minHeight: fieldStyle.minHeight }}>
                    <Markdown text={value} fallback={<span style={{ color: 'var(--color-text-muted)' }}>{t('common:markdown.emptyPreview')}</span>} />
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-muted)' }}>{t('common:markdown.hint')}</span>
                <button type="button" aria-pressed={preview} onClick={() => setPreview((value) => !value)}
                    style={{ flexShrink: 0, padding: '2px 8px', border: '1px solid var(--color-border)', borderRadius: 999, background: preview ? 'var(--theme-primary)' : 'transparent',
                        color: preview ? '#FFFFFF' : 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.6, cursor: 'pointer' }}>
                    {preview ? t('common:markdown.edit') : t('common:markdown.preview')}
                </button>
            </div>
        </div>
    );
});

export default TextArea;
