import React, { useEffect, useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import { useTips } from "../components/feedback/Tips";
import { DEFAULT_SKIN_ID, getSkin } from "../skins/registry";
import { activateSkin } from "../skins/skinStore";
import { useActiveSkin } from "../skins/useSkin";
import { rememberSkin } from "../skins/useSkinSession";
import { fetchSkinState, saveActiveSkin } from "../skins/skinApi";
import { loadRemoteSkin } from '../skins/remoteSkin';
import ResourceRedeemForm from '../skins/ResourceRedeemForm';
import { getPlatform } from "../platform/env";
import { t } from '../i18n/index.js';
import StateMessage from "../components/feedback/StateMessage";

// iOS App 不提供兑换码：App Store 审核（3.1.1）不允许 App 内用兑换码这类自有机制解锁内容。
// 那里只列出已拥有的皮肤并切换，页面上也不提兑换
const REDEEM_AVAILABLE = getPlatform() !== 'ios';

// 主题皮肤：已解锁的皮肤（含默认样式）与兑换码输入。解锁与切换都以服务器结果为准，再换到本机
export default function SkinSettings({ user, onBack, backendUrl, token }) {
    const showTip = useTips();
    const [state, setState] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [reload, setReload] = useState(0);
    const [busy, setBusy] = useState(false);
    useActiveSkin();

    const apply = (next) => {
        setState(next);
        activateSkin(next.active);
        rememberSkin(user && user.id, next.active);
    };

    useEffect(() => {
        if (!backendUrl || !token) return undefined;
        const controller = new AbortController();
        setLoading(true);
        setLoadError('');
        fetchSkinState(backendUrl, token, { signal: controller.signal })
            .then((next) => { if (!controller.signal.aborted) apply(next); })
            .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message || String(error)); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, reload]);

    const choose = async (skinId, name) => {
        if (busy) return;
        setBusy(true);
        try {
            if (state?.owned.some((item) => item.id === skinId && item.remote)) await loadRemoteSkin(backendUrl, token, skinId);
            apply(await saveActiveSkin(backendUrl, token, skinId));
            showTip(skinId === DEFAULT_SKIN_ID ? t('settings:skins.switchedDefault') : t('settings:skins.switched', { name }));
        } catch (error) {
            showTip(t('settings:skins.switchFailed', { message: error.message || String(error) }));
        } finally {
            setBusy(false);
        }
    };

    const active = state ? state.active : DEFAULT_SKIN_ID;
    const tiles = [
        { id: DEFAULT_SKIN_ID, name: t('settings:skins.defaultName'), description: t('settings:skins.defaultDescription'), available: true },
        ...((state && state.owned) || []).map((item) => {
            const pack = getSkin(item.id);
            return {
                id: item.id,
                name: item.name,
                description: pack ? pack.description : (item.remote ? t('companion:remoteSkin') : t('settings:skins.needsUpdate')),
                preview: pack ? pack.preview : '',
                unlockedTime: item.unlocked_time,
                available: !!pack || item.remote,
                needsDownload: !!item.remote && !pack
            };
        })
    ];

    const sectionTitle = { fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' };
    const hintStyle = { color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 6, lineHeight: 1.5 };

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.skins') }]}>
            <div style={hintStyle}>{REDEEM_AVAILABLE ? t('settings:skins.intro') : t('settings:skins.introSwitchOnly')}</div>

            <div style={{ marginTop: 18 }}>
                <div style={sectionTitle}>{t('settings:skins.mine')}</div>
                {loading && !state ? (
                    <div role="status" style={hintStyle}>{t('settings:skins.loading')}</div>
                ) : loadError && !state ? (
                    <StateMessage kind="error" onRetry={() => setReload((value) => value + 1)} retryLabel={t('settings:skins.retry')}>
                        {t('settings:skins.loadFailed', { message: loadError })}
                    </StateMessage>
                ) : (
                    <div role="radiogroup" aria-label={t('settings:skins.mine')} style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                        {tiles.map((tile) => {
                            const selected = tile.id === active;
                            return (
                                <div
                                    key={tile.id}
                                    role="radio"
                                    aria-checked={selected}
                                    aria-label={tile.name}
                                    style={{
                                        display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 'var(--radius-md)',
                                        border: `${selected ? 2 : 1}px solid ${selected ? 'var(--theme-primary)' : 'var(--color-border)'}`,
                                        background: 'var(--color-bg-surface)', minWidth: 0
                                    }}
                                >
                                    <div style={{ aspectRatio: '3 / 2', borderRadius: 'var(--radius-sm)', overflow: 'hidden', background: 'var(--color-bg-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        {tile.preview
                                            ? <img src={tile.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            : <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 32, color: tile.available ? 'var(--theme-icon)' : 'var(--color-text-muted)' }}>{tile.available ? 'palette' : 'hourglass_empty'}</span>}
                                    </div>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{tile.name}</div>
                                        {tile.description && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2, lineHeight: 1.45 }}>{tile.description}</div>}
                                        {tile.unlockedTime && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{t('settings:skins.unlockedAt', { date: new Date(tile.unlockedTime).toLocaleDateString() })}</div>}
                                    </div>
                                    {selected && !tile.needsDownload ? (
                                        <div style={{ marginTop: 'auto', fontSize: 13, fontWeight: 700, color: 'var(--theme-primary)' }}>{t('settings:skins.inUse')}</div>
                                    ) : (
                                        <Button disabled={busy || !tile.available} onClick={() => choose(tile.id, tile.name)} style={{ marginTop: 'auto' }}>
                                            {t('settings:skins.use')}
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {REDEEM_AVAILABLE && <ResourceRedeemForm backendUrl={backendUrl} token={token} onRedeemed={(result) => {
                if (result.type === 'skin') apply(result.state);
            }} />}
        </PageTemplate>
    );
}
