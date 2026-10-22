import React, { useEffect, useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import { DEFAULT_SKIN_ID, getSkin } from "../skins/registry";
import { activateSkin } from "../skins/skinStore";
import { useActiveSkin } from "../skins/useSkin";
import { rememberSkin } from "../skins/useSkinSession";
import { fetchSkinState, redeemSkinCode, saveActiveSkin } from "../skins/skinApi";
import { getPlatform } from "../platform/env";
import { t } from '../i18n/index.js';

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
    const [code, setCode] = useState('');
    const [redeemError, setRedeemError] = useState('');
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

    const redeem = async (event) => {
        event.preventDefault();
        if (busy) return;
        if (!code.trim()) {
            setRedeemError(t('settings:skins.codeRequired'));
            return;
        }
        setBusy(true);
        setRedeemError('');
        try {
            const next = await redeemSkinCode(backendUrl, token, code);
            apply(next);
            setCode('');
            const name = next.unlocked ? next.unlocked.name : '';
            if (next.already_owned) showTip(t('settings:skins.alreadyOwned', { name }));
            else if (next.unlocked && !getSkin(next.unlocked.id)) showTip(t('settings:skins.unlockedNeedsUpdate', { name }));
            else showTip(t('settings:skins.unlocked', { name }));
        } catch (error) {
            setRedeemError(error.message || String(error));
        } finally {
            setBusy(false);
        }
    };

    const choose = async (skinId, name) => {
        if (busy) return;
        setBusy(true);
        try {
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
                description: pack ? pack.description : t('settings:skins.needsUpdate'),
                preview: pack ? pack.preview : '',
                unlockedTime: item.unlocked_time,
                available: !!pack
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
                    <div style={{ marginTop: 8 }}>
                        <div role="alert" style={{ color: 'var(--color-danger)', fontSize: 13 }}>{t('settings:skins.loadFailed', { message: loadError })}</div>
                        <Button themeAware onClick={() => setReload((value) => value + 1)} style={{ marginTop: 8 }}>{t('settings:skins.retry')}</Button>
                    </div>
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
                                            : <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 36, color: tile.available ? 'var(--theme-icon)' : 'var(--color-text-muted)' }}>{tile.available ? 'palette' : 'hourglass_empty'}</span>}
                                    </div>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{tile.name}</div>
                                        {tile.description && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2, lineHeight: 1.45 }}>{tile.description}</div>}
                                        {tile.unlockedTime && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{t('settings:skins.unlockedAt', { date: new Date(tile.unlockedTime).toLocaleDateString() })}</div>}
                                    </div>
                                    {selected ? (
                                        <div style={{ marginTop: 'auto', fontSize: 13, fontWeight: 700, color: 'var(--theme-primary)' }}>{t('settings:skins.inUse')}</div>
                                    ) : (
                                        <Button themeAware disabled={busy || !tile.available} onClick={() => choose(tile.id, tile.name)} style={{ marginTop: 'auto' }}>
                                            {t('settings:skins.use')}
                                        </Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {REDEEM_AVAILABLE && <form onSubmit={redeem} style={{ marginTop: 24 }}>
                <label htmlFor="skin-code" style={sectionTitle}>{t('settings:skins.redeemTitle')}</label>
                <div style={hintStyle}>{t('settings:skins.redeemHint')}</div>
                <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <TextInput
                        id="skin-code"
                        aria-label={t('settings:skins.codeLabel')}
                        value={code}
                        onChange={(event) => { setCode(event.target.value); setRedeemError(''); }}
                        placeholder={t('settings:skins.codePlaceholder')}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={40}
                        disabled={busy}
                        style={{ flex: '1 1 220px', minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 1 }}
                    />
                    <Button type="submit" themeAware disabled={busy || !token}>
                        {busy ? t('settings:skins.redeeming') : t('settings:skins.redeem')}
                    </Button>
                </div>
                {redeemError && <div role="alert" style={{ marginTop: 8, color: 'var(--color-danger)', fontSize: 13 }}>{redeemError}</div>}
            </form>}
        </PageTemplate>
    );
}
