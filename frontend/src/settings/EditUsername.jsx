import React, { useState, useEffect } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import useDarkMode from "../theme/useDarkMode";
import { t } from '../i18n/index.js';
import { saveUsername } from './accountSettings';

export default function EditUsername({ user, onBack, backendUrl, token, onUpdateUser }) {
    const [username, setUsername] = useState(user ? user.username : '');
    const [loading, setLoading] = useState(false);
    const showTip = useTips();
    const dark = useDarkMode();

    useEffect(() => {
        setUsername(user ? user.username : '');
    }, [user]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            const result = await saveUsername({ backendUrl, token, username });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            // 新住民名写在通行凭证里：用返回的 user 与 token 更新应用状态
            if (onUpdateUser && result.user && result.token) onUpdateUser(result.user, result.token);
            showTip(result.message);
            if (onBack) onBack();
        } catch (ex) {
            showTip(ex.message || t('settings:editUsername.requestFailed'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <PageTemplate
            breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.editUsername') }]}
        >
            <form onSubmit={handleSubmit}>
                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:editUsername.label')}</div>
                    <TextInput
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        style={{ width: '100%' }}
                    />
                </label>



                <div style={{ display: 'flex', gap: 8 }}>
                    <Button themeAware type="submit" disabled={loading} style={{ padding: '8px 12px' }}>{loading ? t('settings:common.status.saving') : t('common:action.save')}</Button>
                    <Button themeAware type="button" onClick={() => { setUsername(user ? user.username : ''); if (onBack) onBack(); }} style={{ padding: '8px 12px' }}>{t('common:action.cancel')}</Button>
                </div>
            </form>
        </PageTemplate>
    );
}
