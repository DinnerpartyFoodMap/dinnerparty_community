import React, { useState } from 'react';
import Button from '../components/primitives/Button';
import PageTemplate from '../components/layout/PageTemplate';
import { useTips } from '../components/feedback/Tips';
import { t } from '../i18n';
import { getPlatform } from '../platform/env';
import ResourceRedeemForm from '../skins/ResourceRedeemForm';
import { saveActiveCompanion } from '../skins/skinApi';
import CompanionFigure from './CompanionFigure';
import { DEFAULT_COMPANION } from './useCompanion';

export default function CompanionSettings({ backendUrl, token, companion, update, onBack }) {
    const [busy, setBusy] = useState(false);
    const showTip = useTips();
    const roles = [{ id: DEFAULT_COMPANION, name: t('companion:defaultName') }, ...companion.owned];
    const active = roles.find((role) => role.id === companion.active) || roles[0];

    async function choose(id) {
        if (busy) return;
        setBusy(true);
        try { update(await saveActiveCompanion(backendUrl, token, id)); }
        catch (error) { showTip(error.message || t('companion:switchFailed')); }
        finally { setBusy(false); }
    }

    return <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('companion:title') }]}>
        <section className="fm-companion-room">
            <CompanionFigure backendUrl={backendUrl} token={token} companion={companion} showStatus />
            <strong>{active.name}</strong>
            <p className="fm-companion-room__satiety" aria-live="polite">{t('companion:satiety', { count: companion.satiety })}</p>
            <p>{t('companion:unlockHint')}</p>
        </section>
        <div className="fm-companion-room__choices" aria-label={t('companion:role')}>
            {roles.map((role) => <Button key={role.id} variant={role.id === active.id ? 'primary' : 'secondary'}
                aria-pressed={role.id === active.id} disabled={busy || role.id === active.id} onClick={() => choose(role.id)}>{role.name}</Button>)}
        </div>
        {getPlatform() !== 'ios' && <ResourceRedeemForm backendUrl={backendUrl} token={token} onRedeemed={(result) => {
            if (result.type === 'companion') update(result.state);
        }} />}
    </PageTemplate>;
}
