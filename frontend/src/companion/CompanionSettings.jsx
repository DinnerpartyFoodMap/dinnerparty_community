import React, { useState } from 'react';
import Button from '../components/primitives/Button';
import { useTips } from '../components/feedback/Tips';
import { t } from '../i18n';
import { getPlatform } from '../platform/env';
import ResourceRedeemForm from '../skins/ResourceRedeemForm';
import { saveActiveCompanion } from '../skins/skinApi';
import CompanionFigure from './CompanionFigure';
import CompanionRoom from './CompanionRoom';
import { DEFAULT_COMPANION } from './useCompanion';

export default function CompanionSettings({ backendUrl, token, userId, companion, update, enabled, onEnabledChange, onOpenPlace, onOpenRoom, initialRoomAction = null }) {
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

    async function toggle(nextEnabled) {
        if (busy) return;
        setBusy(true);
        try { await onEnabledChange(nextEnabled); }
        catch (error) { showTip(error.message || t('settings:personalizeMap.saveFailed')); }
        finally { setBusy(false); }
    }

    // 从上到下：舞台和饱食度、起名卡片或时间线（CompanionRoom）、切换角色、兑换码，开关放在最下面；
    // 关掉「开启小伙伴」后只剩开关（见 doc/README.md 的小伙伴页）
    const toggleRow = <label className="fm-companion-settings__toggle">
        <span>{t('companion:enabled')}</span>
        <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => toggle(event.target.checked)} />
    </label>;
    return <div className="fm-companion-settings">
        {enabled && <>
            <section className="fm-companion-room">
                <CompanionFigure backendUrl={backendUrl} token={token} companion={companion} showStatus />
                <p className="fm-companion-room__satiety" aria-live="polite">{t('companion:satiety', { count: companion.satiety })}</p>
                <p>{t('companion:unlockHint')}{t('companion:room.satietyKeep')}</p>
            </section>
            {userId && <CompanionRoom backendUrl={backendUrl} token={token} userId={userId} onOpenPlace={onOpenPlace}
                onOpenRoom={onOpenRoom} initialAction={initialRoomAction} />}
            <div className="fm-companion-room__choices" aria-label={t('companion:role')}>
                {roles.map((role) => <Button key={role.id} variant={role.id === active.id ? 'primary' : 'secondary'}
                    aria-pressed={role.id === active.id} disabled={busy || role.id === active.id} onClick={() => choose(role.id)}>{role.name}</Button>)}
            </div>
            {getPlatform() !== 'ios' && <ResourceRedeemForm backendUrl={backendUrl} token={token} onRedeemed={(result) => {
                if (result.type === 'companion') update(result.state);
            }} />}
        </>}
        {toggleRow}
    </div>;
}
