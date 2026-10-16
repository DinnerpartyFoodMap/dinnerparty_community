import React, { useEffect, useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import SelectInput from "../components/forms/SelectInput";
import { useTips } from "../components/feedback/Tips";
import useDarkMode from "../theme/useDarkMode";
import MotionSettings from './MotionSettings';
import { t } from '../i18n/index.js';
import { readMapSettingsForm, buildMapSettings, saveMapSettings } from './mapSettings';

export default function PersonalizeMap({ user, onBack, backendUrl, token, onUpdateUser }) {
    const [style, setStyle] = useState('standard');
    const [lat, setLat] = useState('');
    const [lng, setLng] = useState('');
    const [zoom, setZoom] = useState('');
    const [loading, setLoading] = useState(false);

    const showTip = useTips();
    const dark = useDarkMode();

    useEffect(() => {
        const form = readMapSettingsForm(user);
        setStyle(form.style);
        setLat(form.lat);
        setLng(form.lng);
        setZoom(form.zoom);
    }, [user]);

    const handleSave = async () => {
        // 支持部分填写：若填写了经纬度需要同时填写经度和纬度；缩放等级可选
        const built = buildMapSettings(user, { style, lat, lng, zoom });
        if (built.error) {
            showTip(built.error);
            return;
        }
        setLoading(true);
        try {
            const result = await saveMapSettings({ backendUrl, token, mapSettings: built.mapSettings });
            if (!result.ok) {
                showTip(result.message);
                return;
            }
            if (result.user && typeof onUpdateUser === 'function') onUpdateUser(result.user, token);
            if (typeof onBack === 'function') onBack();
            showTip(result.message);
        } catch (e) {
            showTip(e.message || t('settings:personalizeMap.saveFailed'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.personalizeMap') }]}>
            <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:personalizeMap.mapStyleLabel')}</div>
                    <SelectInput value={style} onChange={(e) => setStyle(e.target.value)} style={{ width: '100%', padding: '8px 10px', boxSizing: 'border-box', borderRadius: 'var(--radius-sm)' }}>
                        <option value="standard">{t('settings:personalizeMap.mapStyle.standard')}</option>
                        <option value="satellite" disabled>{t('settings:personalizeMap.mapStyle.satellite')}</option>
                        <option value="terrain" disabled>{t('settings:personalizeMap.mapStyle.terrain')}</option>
                    </SelectInput>
                </label>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:personalizeMap.centerLat')}</div>
                    <TextInput value={lat} onChange={(e) => setLat(e.target.value)} placeholder="23.016485" style={{ width: '100%' }} />
                </label>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:personalizeMap.centerLng')}</div>
                    <TextInput value={lng} onChange={(e) => setLng(e.target.value)} placeholder="113.394405" style={{ width: '100%' }} />
                </label>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>{t('settings:personalizeMap.zoom')}</div>
                    <TextInput value={zoom} onChange={(e) => setZoom(e.target.value)} placeholder="24" style={{ width: '100%' }} />
                </label>

                <div style={{ display: 'flex', gap: 8 }}>
                    <Button themeAware type="submit" disabled={loading} style={{ padding: '8px 12px' }}>{loading ? t('settings:common.status.saving') : t('common:action.save')}</Button>
                    <Button themeAware type="button" onClick={() => { if (typeof onBack === 'function') onBack(); }} style={{ padding: '8px 12px' }}>{t('common:action.cancel')}</Button>
                </div>
            </form>
            <MotionSettings />
        </PageTemplate>
    );
}
