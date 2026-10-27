import React, { useState, useEffect } from 'react';
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { t } from '../i18n/index.js';

// 与后端 qqWhitelist 的 WHITELIST_QQ_PATTERN 一致
const QQ_PATTERN = /^\d{5,15}$/;

// 修改住民绑定的 QQ 号；留空保存即解绑
export default function AdminQqModal({ open, onClose, onConfirm, targetUser, saving = false }) {
    const [qq, setQq] = useState('');

    useEffect(() => {
        if (open) setQq(targetUser?.qq || '');
    }, [open, targetUser]);

    const value = qq.trim();
    const valid = !value || QQ_PATTERN.test(value);
    const unchanged = value === (targetUser?.qq || '');

    return (
        <ResponsivePanel
            open={open}
            onClose={onClose}
            title={t('admin:qqModal.title', { username: targetUser ? targetUser.username : '' })}
            kind="admin-qq"
            desktop="center"
            mobile="sheet"
            width="min(420px, calc(100vw - 24px))"
            bodyStyle={{ padding: 12 }}
        >
            <div>
                <label htmlFor="admin-qq-input" style={{ display: 'block', marginBottom: 6, color: 'var(--color-text-secondary)' }}>{t('admin:qqModal.label')}</label>
                <TextInput
                    id="admin-qq-input"
                    value={qq}
                    onChange={e => setQq(e.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={t('admin:qqModal.placeholder')}
                    style={{ width: '100%' }}
                />
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: valid ? 'var(--color-text-secondary)' : 'var(--color-danger)' }}>
                    {valid ? t('admin:qqModal.hint') : t('admin:qqModal.invalid')}
                </div>
                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Button themeAware onClick={onClose} style={{ background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)' }}>{t('common:action.cancel')}</Button>
                    <Button themeAware onClick={() => onConfirm && onConfirm(value)} disabled={!valid || unchanged || saving}>{t('admin:qqModal.confirm')}</Button>
                </div>
            </div>
        </ResponsivePanel>
    );
}
