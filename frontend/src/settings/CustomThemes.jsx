import React, { useEffect, useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import SelectInput from "../components/forms/SelectInput";
import { useTips } from "../components/feedback/Tips";
import { applyDarkMode, applyThemeColors, resolveThemePrimary, resolveThemeSecondary, getSystemPrefersDark, DEFAULT_PRIMARY, DEFAULT_SECONDARY, DEFAULT_DARK_PRIMARY, DEFAULT_DARK_SECONDARY } from "../theme/theme";
import useDarkMode from "../theme/useDarkMode";
import { t } from '../i18n/index.js';
import { patchMapSettings } from './accountSettings';
import { STYLE_OPTIONS, DARK_STYLE_IDS, LIGHT_STYLE_IDS, notifyMapStyleChange } from './themeOptions';

export default function CustomThemes({ user, onBack, backendUrl, token, onUpdateUser }) {
    const [darkMode, setDarkMode] = useState(() => getSystemPrefersDark());
    const [darkMapStyle, setDarkMapStyle] = useState('amap://styles/dark');
    const [lightMapStyle, setLightMapStyle] = useState('amap://styles/normal');
    const [loading, setLoading] = useState(false);
    const [themeColor, setThemeColor] = useState(() => resolveThemePrimary(null));
    const [themeSecondary, setThemeSecondary] = useState(() => resolveThemeSecondary(null));
    const showTip = useTips();
    const dark = useDarkMode();

    useEffect(() => {
        let settings = null;
        if (user && user.map_settings) settings = user.map_settings;
        else {
            try {
                const raw = localStorage.getItem('map_settings');
                if (raw) settings = JSON.parse(raw);
            } catch (e) { settings = null; }
        }

        if (settings && typeof settings.dark_mode !== 'undefined') {
            setDarkMode(!!settings.dark_mode);
        }
        if (settings && typeof settings.map_style_dark !== 'undefined') {
            setDarkMapStyle(settings.map_style_dark || 'amap://styles/dark');
        }
        if (settings && typeof settings.map_style_light !== 'undefined') {
            setLightMapStyle(settings.map_style_light || 'amap://styles/normal');
        }
        if (settings && typeof settings.theme_color !== 'undefined') {
            setThemeColor(settings.theme_color || resolveThemePrimary(null));
        }
        if (settings && typeof settings.theme_color_secondary !== 'undefined') {
            setThemeSecondary(settings.theme_color_secondary || resolveThemeSecondary(null));
        }
        try { applyThemeColors(resolveThemePrimary(settings), resolveThemeSecondary(settings)); } catch (e) { }
    }, [user]);

    const persistDarkMode = async (value) => {
        setLoading(true);
        try {
            const result = await patchMapSettings({ user, backendUrl, token, patch: { dark_mode: !!value } });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            if (result.local) {
                setDarkMode(!!value);
                showTip(result.message);
            } else if (result.user) {
                if (typeof onUpdateUser === 'function') onUpdateUser(result.user, token);
                const ms = result.user.map_settings || null;
                if (ms && typeof ms.dark_mode !== 'undefined') setDarkMode(!!ms.dark_mode);
                showTip(result.message);
            }
        } catch (e) {
            showTip(e.message || t('settings:customThemes.saveFailed'));
        } finally {
            setLoading(false);
        }
    };

    const persistThemeColors = async (primary, secondary) => {
        setLoading(true);
        const patch = {};
        if (typeof primary !== 'undefined') patch.theme_color = primary || '';
        if (typeof secondary !== 'undefined') patch.theme_color_secondary = secondary || '';
        try {
            const result = await patchMapSettings({ user, backendUrl, token, patch });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            if (result.local) {
                if (typeof primary !== 'undefined') setThemeColor(primary || resolveThemePrimary(null));
                if (typeof secondary !== 'undefined') setThemeSecondary(secondary || resolveThemeSecondary(null));
                try { applyThemeColors(primary || resolveThemePrimary(null), secondary || resolveThemeSecondary(null)); } catch (e) { }
                showTip(result.message);
            } else if (result.user) {
                if (typeof onUpdateUser === 'function') onUpdateUser(result.user, token);
                const ms = result.user.map_settings || null;
                if (ms && typeof ms.theme_color !== 'undefined') setThemeColor(ms.theme_color || resolveThemePrimary(null));
                if (ms && typeof ms.theme_color_secondary !== 'undefined') setThemeSecondary(ms.theme_color_secondary || resolveThemeSecondary(null));
                try { applyThemeColors(resolveThemePrimary(ms), resolveThemeSecondary(ms)); } catch (e) { }
                showTip(result.message);
            }
        } catch (e) {
            showTip(e.message || t('settings:customThemes.saveFailed'));
        } finally {
            setLoading(false);
        }
    };

    const persistMapStyle = async (which, value) => {
        // which: 'map_style_dark' | 'map_style_light'
        setLoading(true);
        try {
            const result = await patchMapSettings({ user, backendUrl, token, patch: { [which]: value || '' } });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            if (result.local) {
                if (which === 'map_style_dark') setDarkMapStyle(value || '');
                if (which === 'map_style_light') setLightMapStyle(value || '');
                showTip(result.message);
            } else if (result.user) {
                if (typeof onUpdateUser === 'function') onUpdateUser(result.user, token);
                const ms = result.user.map_settings || null;
                if (ms && typeof ms.map_style_dark !== 'undefined') setDarkMapStyle(ms.map_style_dark || '');
                if (ms && typeof ms.map_style_light !== 'undefined') setLightMapStyle(ms.map_style_light || '');
                showTip(result.message);
            }
            // 通知地图立即切换样式
            notifyMapStyleChange(result.settings);
        } catch (e) {
            showTip(e.message || t('settings:customThemes.saveFailed'));
        } finally {
            setLoading(false);
        }
    };

    const handleToggle = (e) => {
        const val = !!e.target.checked;
        setDarkMode(val);
        // apply immediately to UI so user sees feedback even when not logged in yet
        try { applyDarkMode(val); } catch (ex) { /* ignore */ }
        persistDarkMode(val);
    };

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.customThemes') }]}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{t('settings:customThemes.darkMode')}</div>
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('settings:customThemes.darkModeHint')}</div>
                    </div>
                    <div>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 12, cursor: loading ? 'not-allowed' : 'pointer' }}>
                            <div style={{ position: 'relative', width: 56, height: 30 }}>
                                <input
                                    type="checkbox"
                                    checked={darkMode}
                                    onChange={handleToggle}
                                    disabled={loading}
                                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, margin: 0, cursor: loading ? 'not-allowed' : 'pointer' }}
                                />
                                <div style={{
                                    width: '100%',
                                    height: '100%',
                                    background: darkMode ? 'var(--color-primary)' : 'var(--color-border)',
                                    borderRadius: 9999,
                                    transition: 'background .18s'
                                }} />
                                <div style={{
                                    position: 'absolute',
                                    top: 3,
                                    left: darkMode ? 29 : 3,
                                    width: 24,
                                    height: 24,
                                    borderRadius: '50%',
                                    background: 'var(--color-bg-surface)',
                                    boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
                                    transition: 'left .18s'
                                }} />
                            </div>
                            <span style={{ color: 'var(--color-text-secondary)' }}>{darkMode ? t('settings:customThemes.enabled') : t('settings:customThemes.disabled')}</span>
                        </label>
                    </div>
                </div>
            </div>
            <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{t('settings:customThemes.themeColor')}</div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 6 }}>{t('settings:customThemes.themeColorHint')}</div>

                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <input
                        type="color"
                        value={themeColor}
                        onChange={(e) => setThemeColor(e.target.value)}
                        disabled={loading}
                        style={{
                            width: 56,
                            height: 36,
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--color-border)',
                            background: 'var(--color-bg-overlay)',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            padding: 6,
                            boxSizing: 'border-box',
                            outline: 'none'
                        }}
                    />

                    <TextInput
                        value={themeColor}
                        onChange={(e) => setThemeColor(e.target.value)}
                        style={{ width: 160 }}
                    />

                    <Button
                        onClick={() => persistThemeColors(themeColor, themeSecondary)}
                        disabled={loading}
                        style={{
                            background: themeColor,
                            color: '#2B2533',
                            border: 'none',
                            padding: '8px 12px',
                            borderRadius: 'var(--radius-sm)',
                            boxShadow: '0 4px 12px var(--color-glow)',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            opacity: loading ? 0.6 : 1
                        }}
                    >
                        {t('common:action.save')}
                    </Button>
                </div>

                <div style={{ marginTop: 14 }}>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('settings:customThemes.secondaryColorHint')}</div>
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                        <input
                            type="color"
                            value={themeSecondary}
                            onChange={(e) => setThemeSecondary(e.target.value)}
                            disabled={loading}
                            style={{
                                width: 56,
                                height: 36,
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-bg-overlay)',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                padding: 6,
                                boxSizing: 'border-box',
                                outline: 'none'
                            }}
                        />
                        <TextInput
                            value={themeSecondary}
                            onChange={(e) => setThemeSecondary(e.target.value)}
                            style={{ width: 160 }}
                        />
                    </div>
                </div>
            </div>
            <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{t('settings:customThemes.mapStyleTitle')}</div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginTop: 6 }}>{t('settings:customThemes.mapStyleHint')}</div>

                <div style={{ marginTop: 12, minWidth: 260 }}>
                    <div style={{ fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 6 }}>{darkMode ? t('settings:customThemes.darkStyleCurrent') : t('settings:customThemes.lightStyleCurrent')}</div>
                    {(() => {
                        const options = STYLE_OPTIONS.filter(s => darkMode ? DARK_STYLE_IDS.includes(s.id) : LIGHT_STYLE_IDS.includes(s.id));
                        const value = darkMode ? darkMapStyle : lightMapStyle;
                        return (
                            <SelectInput value={value} onChange={(e) => persistMapStyle(darkMode ? 'map_style_dark' : 'map_style_light', e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)' }}>
                                {options.map(s => (
                                    <option key={s.id || s.name} value={s.id}>{s.name}</option>
                                ))}
                            </SelectInput>
                        );
                    })()}
                </div>
            </div>
        </PageTemplate>
    );
}
