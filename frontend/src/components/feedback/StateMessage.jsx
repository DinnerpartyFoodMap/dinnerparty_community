import React from 'react';
import Button from '../primitives/Button';
import { t } from '../../i18n/index.js';

const ICONS = { empty: 'inbox', loading: 'progress_activity', error: 'error' };

/**
 * 内容区的加载中 / 空 / 出错状态（设计参考 11.5、11.8）：居中的图标 + 说明，出错时下面放 secondary「重试」。
 * kind：'empty'（默认）/ 'loading' / 'error'；onRetry 只在出错时显示按钮，retryLabel 默认为「重试」。
 */
export default function StateMessage({ kind = 'empty', children, onRetry, retryLabel, style }) {
    const error = kind === 'error';
    return (
        <div role={error ? 'alert' : 'status'} className="fm-state-message" style={style}>
            <span className={`material-symbols-outlined${kind === 'loading' ? ' fm-icon-button__spin' : ''}`} aria-hidden="true">{ICONS[kind] || ICONS.empty}</span>
            <div style={{ color: error ? 'var(--color-danger-text)' : 'var(--color-text-secondary)' }}>{children}</div>
            {error && onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>{retryLabel || t('common:action.retry')}</Button>}
        </div>
    );
}
