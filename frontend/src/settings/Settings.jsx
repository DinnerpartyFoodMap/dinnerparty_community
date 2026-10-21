import React, { useEffect, useState } from 'react';
import Button from "../components/primitives/Button";
import Tooltip from "../components/primitives/Tooltip";
import defaultAvatar from "../img/default.png";
import { TipsContext } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import { clearLocalDraftsForUser } from "../platform/localDraftStore";
import useNativeSettings from "./useNativeSettings";
import { t } from "../i18n/index.js";

// headless：App 内原生设置打开期间不渲染任何网页内容（地图留在底下，原生页直接从地图上弹起）；
// 原生不可用或异常结束时通过 onNativeUnavailable 让 App 切回网页版设置页，此后以 nativeDisabled 渲染、不再重试原生。
export default function Settings({ user, onBack, onOpenEditAvatar, onOpenEditUsername, onOpenEditPassword, onOpenPersonalize, onOpenThemes, onOpenSkins, backendUrl, token, onLogout, onUpdateUser, headless = false, nativeDisabled = false, onNativeUnavailable }) {
    const [deleting, setDeleting] = useState(false);
    const { showTip } = React.useContext(TipsContext);
    const confirm = useConfirm();

    const rootStyle = { minHeight: 'var(--app-height, 100vh)', background: 'var(--color-bg-base)', padding: 20, boxSizing: 'border-box', color: 'var(--color-text-primary)' };
    const container = { maxWidth: 960, margin: '0 auto' };
    const titleRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 };
    const captionStyle = { marginBottom: 14, color: 'var(--color-text-secondary)', fontSize: 16 };
    const cardStyle = { background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-md)', padding: 16, border: '1px solid var(--color-border)', boxShadow: '0 8px 24px var(--color-glow)' };
    const sepBg = 'var(--color-border)';

    const [loggingOutAll, setLoggingOutAll] = useState(false);
    // 退出全部设备：撤销该住民在网页、手机等所有设备上的登录（含当前设备）
    const handleLogoutAll = async (confirmed = false) => {
        if (!token || !backendUrl) return;
        if (confirmed !== true && !(await confirm(t('settings:main.confirmLogoutAll')))) return;
        setLoggingOutAll(true);
        try {
            const res = await fetch(`${backendUrl}/users/logout-all`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok && res.status !== 401) {
                const data = await res.json().catch(() => null);
                showTip((data && data.error) || t('settings:main.logoutAllFailed', { status: res.status }));
                return;
            }
            showTip(t('settings:main.loggedOutAll'));
            if (onLogout) await onLogout();
        } catch (e) {
            showTip(t('settings:main.requestFailed', { message: e && e.message ? e.message : String(e) }));
        } finally {
            setLoggingOutAll(false);
        }
    };

    const handleDeleteAccount = async (confirmed = false) => {
        if (!token || !backendUrl) {
            if (onLogout) onLogout();
            return;
        }
        if (confirmed !== true && !(await confirm(t('settings:main.confirmDeleteAccount')))) return;
        setDeleting(true);
        try {
            const res = await fetch(`${backendUrl}/users/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
                // 账号已注销：清除本机保存的该账号行程草稿
                await clearLocalDraftsForUser(user && user.id);
                showTip(t('settings:main.accountDeleted'));
                if (onLogout) await onLogout();
            } else {
                let data = null;
                try { data = await res.json(); } catch (e) { }
                const msg = data && data.error ? data.error : t('settings:main.deleteFailed', { status: res.status });
                showTip(msg);
                if (res.status === 401 && onLogout) onLogout();
            }
        } catch (e) {
            showTip(t('settings:main.deleteRequestFailed', { message: e && e.message ? e.message : String(e) }));
        } finally {
            setDeleting(false);
        }
    };

    const nativeSettings = useNativeSettings({ user, backendUrl, token, onUpdateUser, disabled: nativeDisabled, actions: {
        back: onBack, avatar: onOpenEditAvatar, username: onOpenEditUsername, password: onOpenEditPassword,
        themes: onOpenThemes, personalize: onOpenPersonalize, skins: onOpenSkins,
        logoutAll: () => handleLogoutAll(true), deleteAccount: () => handleDeleteAccount(true)
    } });

    useEffect(() => {
        if (headless && !nativeSettings) onNativeUnavailable?.();
    }, [headless, nativeSettings]);

    if (headless) return null;
    if (nativeSettings) return <div className="fm-native-settings-placeholder" role="status">{deleting || loggingOutAll ? t('settings:main.processing') : t('settings:main.opening')}</div>;

    return (
        <div style={rootStyle}>
            <div style={container}>
                <div className="fm-legacy-page-heading" style={{ ...titleRow, marginTop: 50 }}>
                    <h2 style={{ margin: 0 }}>{t('common:nav.accountSettings')}</h2>
                    <Button
                        themeAware
                        onClick={onBack}
                        style={{ minHeight: 40, padding: '7px 11px', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: 19 }}>arrow_back</span>
                        {t('common:action.backToMap')}
                    </Button>
                </div>

                <div className="fm-legacy-page-heading" style={captionStyle}>
                    <span>{t('settings:common.nav.settings')}</span> <span style={{ margin: '0 8px', color: 'var(--color-text-muted)' }}>{'>'}</span>
                </div>

                <div className="fm-page-card" style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <strong>{t('settings:main.avatar')}</strong>
                            {user && user.has_avatar ? (
                                <img src={`${backendUrl}/users/${user.id}/avatar?t=${Date.now()}`} alt="Avatar" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
                            ) : (
                                <img src={defaultAvatar} alt="Default Avatar" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
                            )}
                        </div>
                        <div>
                            <Tooltip text={t('common:nav.editAvatar')} placement="top">
                                <Button themeAware onClick={onOpenEditAvatar} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                    <span className="material-symbols-outlined">chevron_right</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </div>

                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: 0 }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 12 }}>
                        <div><strong>{t('settings:main.currentUsername')}</strong>{user ? user.username : '-'}</div>
                        <div>
                            <Tooltip text={t('common:nav.editUsername')} placement="top">
                                <Button themeAware onClick={onOpenEditUsername} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                    <span className="material-symbols-outlined">chevron_right</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </div>

                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: 0 }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 12 }}>
                        <div><strong>{t('common:nav.editPassword')}</strong></div>
                        <div>
                            <Tooltip text={t('common:nav.editPassword')} placement="top">
                                <Button themeAware onClick={onOpenEditPassword} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                    <span className="material-symbols-outlined">chevron_right</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </div>

                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: 0 }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 12 }}>
                        <div><strong>{t('common:nav.customThemes')}</strong></div>
                        <div>
                            <Tooltip text={t('common:nav.customThemes')} placement="top">
                                <Button themeAware onClick={onOpenThemes} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                    <span className="material-symbols-outlined">chevron_right</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </div>

                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: 0 }} />

                    {onOpenSkins && <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 12 }}>
                            <div><strong>{t('common:nav.skins')}</strong></div>
                            <div>
                                <Tooltip text={t('common:nav.skins')} placement="top">
                                    <Button themeAware onClick={onOpenSkins} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                        <span className="material-symbols-outlined">chevron_right</span>
                                    </Button>
                                </Tooltip>
                            </div>
                        </div>

                        <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: 0 }} />
                    </>}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 12 }}>
                        <div><strong>{t('common:nav.personalizeMap')}</strong></div>
                        <div>
                            <Tooltip text={t('common:nav.personalizeMap')} placement="top">
                                <Button themeAware onClick={onOpenPersonalize} style={{ padding: '8px 12px', border: 0, alignItems: 'center', display: 'inline-flex', gap: 4, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)' }}>
                                    <span className="material-symbols-outlined">chevron_right</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </div>
                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: '12px 0' }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 12, gap: 12 }}>
                        <div>
                            <div style={{ fontWeight: 600 }}>{t('settings:main.logoutAll.title')}</div>
                            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{t('settings:main.logoutAll.hint')}</div>
                        </div>
                        <div>
                            <Button themeAware onClick={handleLogoutAll} style={{ padding: '8px 12px', border: 0, background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }} disabled={loggingOutAll}>
                                {loggingOutAll ? t('settings:main.logoutAll.processing') : t('settings:main.logoutAll.button')}
                            </Button>
                        </div>
                    </div>

                    <div style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 2, background: sepBg, margin: '12px 0' }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                        <div>
                            <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>{t('settings:main.deleteAccount.title')}</div>
                            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{t('settings:main.deleteAccount.hint')}</div>
                        </div>
                        <div>
                            <Tooltip text={t('settings:main.deleteAccount.tooltip')} placement="top">
                                <Button themeAware onClick={handleDeleteAccount} style={{ padding: '8px 12px', border: 0, background: 'var(--color-danger)', color: 'var(--color-on-emphasis)' }} disabled={deleting}>
                                    {deleting ? t('settings:main.deleteAccount.deleting') : t('settings:main.deleteAccount.button')}
                                </Button>
                            </Tooltip>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
