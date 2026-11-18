import React, { useId, useState } from 'react';
import Button from '../components/primitives/Button';
import TextInput from '../components/forms/TextInput';
import { useTips } from '../components/feedback/Tips';
import { redeemResourceCode } from './skinApi';
import { t } from '../i18n';

export default function ResourceRedeemForm({ backendUrl, token, onRedeemed }) {
    const id = useId();
    const showTip = useTips();
    const [code, setCode] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function redeem(event) {
        event.preventDefault();
        if (busy || !token) return;
        if (!code.trim()) {
            setError(t('settings:skins.codeRequired'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const result = await redeemResourceCode(backendUrl, token, code);
            setCode('');
            onRedeemed?.(result);
            const { name } = result.unlocked;
            showTip(result.already_owned ? t('settings:skins.alreadyOwned', { name }) : t('settings:skins.unlocked', { name }));
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    }

    return <form onSubmit={redeem} style={{ marginTop: 24 }}>
        <label htmlFor={id}>{t('settings:skins.redeemTitle')}</label>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextInput id={id} value={code} onChange={(event) => { setCode(event.target.value); setError(''); }}
                placeholder={t('settings:skins.codePlaceholder')} autoComplete="off" autoCapitalize="characters"
                spellCheck={false} maxLength={40} disabled={busy} style={{ flex: '1 1 220px', minWidth: 0 }} />
            <Button type="submit" disabled={busy || !token}>{busy ? t('settings:skins.redeeming') : t('settings:skins.redeem')}</Button>
        </div>
        {error && <div role="alert" style={{ marginTop: 8, color: 'var(--color-danger)' }}>{error}</div>}
    </form>;
}
