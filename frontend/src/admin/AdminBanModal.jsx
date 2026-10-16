import React, { useState, useEffect } from 'react';
import Button from "../components/primitives/Button";
import SelectInput from "../components/forms/SelectInput";
import TextArea from "../components/forms/TextArea";
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { t } from '../i18n/index.js';

export default function AdminBanModal({ open, onClose, onConfirm, targetUser }) {
    const [reason, setReason] = useState('');
    const [duration, setDuration] = useState('7'); // default 7 days

    useEffect(() => {
        if (open) {
            setReason('');
            setDuration('7');
        }
    }, [open, targetUser]);

    const handleConfirm = () => {
        let durationDays = null;
        if (duration === 'perm') durationDays = 0; // indicate permanent
        else durationDays = Number(duration) || null;
        onConfirm && onConfirm({ reason: reason.trim() || null, durationDays });
    };

    return (
        <ResponsivePanel
            open={open}
            onClose={onClose}
            title={t('admin:banModal.title', { username: targetUser ? targetUser.username : '' })}
            kind="admin-ban"
            desktop="center"
            mobile="sheet"
            width="min(420px, calc(100vw - 24px))"
            bodyStyle={{ padding: 12 }}
        >
                <div>
                    <div style={{ marginBottom: 10, padding: 9, borderRadius: 8, background: 'var(--color-bg-overlay)', color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
                        {t('admin:banModal.targetLabel')}<strong style={{ color: 'var(--color-text-primary)' }}>{targetUser?.username || targetUser?.id || t('admin:banModal.unknownUser')}</strong>{t('admin:banModal.effect')}
                    </div>
                    <div style={{ marginBottom: 8 }}>
                        <label style={{ display: 'block', marginBottom: 6, color: 'var(--color-text-secondary)' }}>{t('admin:banModal.duration')}</label>
                        <SelectInput value={duration} onChange={e => setDuration(e.target.value)} style={{ width: '100%', padding: 8, borderRadius: 'var(--radius-sm)' }}>
                            <option value="1">{t('admin:banModal.days1')}</option>
                            <option value="7">{t('admin:banModal.days7')}</option>
                            <option value="30">{t('admin:banModal.days30')}</option>
                            <option value="perm">{t('admin:banModal.permanent')}</option>
                        </SelectInput>
                    </div>

                    <div>
                        <label style={{ display: 'block', marginBottom: 6, color: 'var(--color-text-secondary)' }}>{t('admin:banModal.reason')}</label>
                        <TextArea value={reason} onChange={e => setReason(e.target.value)} placeholder={t('admin:banModal.reasonPlaceholder')} style={{ width: '100%', minHeight: 80, padding: 8, boxSizing: 'border-box' }} />
                    </div>

                    <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Button themeAware onClick={onClose} style={{ background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)' }}>{t('common:action.cancel')}</Button>
                        <Button themeAware onClick={handleConfirm} style={{ background: 'var(--color-warning)', color: 'var(--color-on-emphasis)', borderColor: 'var(--color-warning)' }}>{t('admin:banModal.confirm')}</Button>
                    </div>
                </div>
        </ResponsivePanel>
    );
}
