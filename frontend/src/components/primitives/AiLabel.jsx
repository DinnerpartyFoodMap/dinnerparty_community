import React from 'react';
import { t } from '../../i18n/index.js';

// 生成式 AI 的显式标识（《人工智能生成合成内容标识办法》）：模型写的文字旁的“AI 生成”标签，
// 以及导出文字时附加的标识。所用已备案模型的名称和备案号公示在用户协议（frontend/terms/，第九部分）。

/** 模型写的文字旁的小标签；label 不传时为“AI 生成” */
export function AiTag({ label, style }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', padding: '0 6px', borderRadius: 999,
            border: '1px solid var(--color-border)', fontSize: 11, fontWeight: 600, lineHeight: '18px',
            color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', verticalAlign: 'middle', ...style
        }}>{label || t('common:ai.generated')}</span>
    );
}

/** 复制、保存或系统分享模型写的文字时，在末尾附上显式标识 */
export function withAiLabel(text) {
    return `${text}\n\n${t('common:ai.exportLabel')}`;
}
