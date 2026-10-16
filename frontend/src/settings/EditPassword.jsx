import React, { useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import useDarkMode from "../theme/useDarkMode";
import { t } from '../i18n/index.js';
import { savePassword } from './accountSettings';

export default function EditPassword({ user, onBack, backendUrl, token, onUpdateUser }) {
    const [currentPwd, setCurrentPwd] = useState('');
    const [newPwd, setNewPwd] = useState('');
    const [confirmPwd, setConfirmPwd] = useState('');
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const dark = useDarkMode();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            const result = await savePassword({ backendUrl, token, currentPassword: currentPwd, newPassword: newPwd, confirmPassword: confirmPwd });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            if (onUpdateUser && result.user && result.token) onUpdateUser(result.user, result.token);

            // 清理表单并返回上一级，随后显示 Tips 提示
            setCurrentPwd('');
            setNewPwd('');
            setConfirmPwd('');
            if (typeof onBack === 'function') onBack();
            // 小延迟以确保路由切换完成后再显示提示（保证可见）
            setTimeout(() => showTip(result.message), 120);
        } catch (ex) {
            showTip(ex.message || t('settings:editPassword.requestFailed'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.editPassword') }]}>
            <form onSubmit={handleSubmit}>
                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:editPassword.current')}</div>
                    <TextInput type="password" value={currentPwd} onChange={(e) => setCurrentPwd(e.target.value)} style={{ width: '100%' }} />
                </label>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:editPassword.new')}</div>
                    <TextInput type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} style={{ width: '100%' }} />
                </label>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:editPassword.confirm')}</div>
                    <TextInput type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} style={{ width: '100%' }} />
                </label>



                <div style={{ display: 'flex', gap: 8 }}>
                    <Button themeAware type="submit" disabled={loading} style={{ padding: '8px 12px' }}>{loading ? t('settings:common.status.saving') : t('common:action.save')}</Button>
                    <Button themeAware type="button" onClick={() => { setCurrentPwd(''); setNewPwd(''); setConfirmPwd(''); if (onBack) onBack(); }} style={{ padding: '8px 12px' }}>{t('common:action.cancel')}</Button>
                </div>
            </form>
        </PageTemplate>
    );
}
