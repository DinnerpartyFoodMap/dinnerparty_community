// 操作面板：窄屏为底部操作面板，宽屏为小型居中列表。
// 也提供命令式入口 requestActionSheet，供非 React 模块（例如选图来源）纳入统一浮层。

import React, { useEffect, useState } from 'react';
import ResponsivePanel from './ResponsivePanel.jsx';
import { t } from '../../i18n/index.js';

const listeners = new Set();
let current = null;
let seq = 0;

/** 宿主是否已挂载（未挂载时调用方应使用自己的降级实现）。 */
export function hasActionSheetHost() {
    return listeners.size > 0;
}

/**
 * @param {{ title?: string, actions: Array<{ value: any, label: string, tone?: 'danger' }>, cancelLabel?: string }} request
 * @returns {Promise<any>} 选中的 value；取消返回 null
 */
export function requestActionSheet(request) {
    return new Promise((resolve) => {
        if (current) current.resolve(null);
        current = { ...request, id: ++seq, resolve };
        for (const listener of listeners) listener(current);
    });
}

export function ActionSheetHost() {
    const [request, setRequest] = useState(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const listener = (next) => {
            setRequest(next);
            setOpen(true);
        };
        listeners.add(listener);
        return () => listeners.delete(listener);
    }, []);

    const finish = (value) => {
        if (!request) return;
        if (current && current.id === request.id) {
            current.resolve(value);
            current = null;
        }
        setOpen(false);
    };

    return (
        <ActionSheet
            open={open}
            title={request?.title}
            actions={request?.actions || []}
            cancelLabel={request?.cancelLabel}
            onSelect={(value) => finish(value)}
            onClose={() => finish(null)}
        />
    );
}

export default function ActionSheet({ open, title, actions, cancelLabel = t('common:action.cancel'), onSelect, onClose }) {
    return (
        <ResponsivePanel
            open={open}
            onClose={onClose}
            title={title}
            label={title || t('common:actionSheet.defaultTitle')}
            showClose={false}
            desktop="center"
            mobile="sheet"
            width="min(360px, calc(100vw - 24px))"
            kind="action-sheet"
        >
            <div role="menu" className="fm-menu" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
                {actions.map((action) => (
                    <button
                        key={String(action.value)}
                        type="button"
                        role="menuitem"
                        className="fm-pressable"
                        onClick={() => onSelect(action.value)}
                        style={{
                            padding: 14,
                            fontSize: 16,
                            borderRadius: 10,
                            border: '1px solid var(--color-border)',
                            background: 'var(--color-bg-overlay)',
                            color: action.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-text-primary)',
                            cursor: 'pointer',
                            transition: 'transform 120ms ease'
                        }}
                    >
                        {action.label}
                    </button>
                ))}
                <button
                    type="button"
                    className="fm-pressable"
                    onClick={onClose}
                    style={{ padding: 14, fontSize: 16, borderRadius: 10, border: 0, background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                >
                    {cancelLabel}
                </button>
            </div>
        </ResponsivePanel>
    );
}
