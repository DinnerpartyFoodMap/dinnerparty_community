import React, { useEffect, useRef, useState } from 'react';
import Button from '../components/primitives/Button';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import TextInput from '../components/forms/TextInput';
import TextArea from '../components/forms/TextArea';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import { useAuth } from '../auth/AuthContext';
import { FullScreenMapPicker } from '../map/MapView';
import { exhibitionCenter } from '../map/exhibition';
import { t } from '../i18n/index.js';

const TEXT_FIELDS = ['name', 'description', 'information', 'icon_url', 'location_name'];
const EMPTY = { name: '', description: '', information: '', icon_url: '', location_name: '', latitude: null, longitude: null };
const formFrom = (exhibition) => {
    const form = { ...EMPTY, ...exhibition };
    for (const key of TEXT_FIELDS) form[key] = form[key] || '';
    return form;
};

export default function AdminExhibitions({ backendUrl }) {
    const { token, onRequireAuth } = useAuth();
    const showTip = useTips();
    const confirm = useConfirm();
    const fileRef = useRef(null);
    const [form, setForm] = useState(EMPTY);
    const [current, setCurrent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [loadFailed, setLoadFailed] = useState(false);
    const [reload, setReload] = useState(0);
    const [pickerOpen, setPickerOpen] = useState(false);
    const center = exhibitionCenter(form);

    async function request(path, options = {}) {
        const res = await fetch(`${backendUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, ...options.headers }
        });
        const data = await res.json();
        if (!res.ok) {
            if (res.status === 401) onRequireAuth?.();
            throw new Error(data.error || t('admin:exhibitions.requestFailed'));
        }
        return data;
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setLoadFailed(false);
        setError('');
        request('/admin/exhibitions/current', { signal: controller.signal }).then(data => {
            if (controller.signal.aborted) return;
            setCurrent(data.exhibition);
            setForm(data.exhibition ? formFrom(data.exhibition) : EMPTY);
        }).catch(e => {
            if (controller.signal.aborted) return;
            setLoadFailed(true);
            setError(e.message);
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, reload]);

    const change = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
    const disabled = loading || busy || loadFailed;

    async function uploadIcon(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) {
            setError(t('admin:exhibitions.invalidImage'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const body = new FormData();
            body.append('image', file);
            const data = await request('/upload', { method: 'POST', body });
            if (!data.url) throw new Error(t('admin:exhibitions.requestFailed'));
            setForm(prev => ({ ...prev, icon_url: data.url }));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    }

    // 选中站内地点时顺带填入场馆名（未填写时）；选图钉位置只更新坐标
    function pickLocation(point) {
        const latitude = Number(point?.lat ?? point?.latitude);
        const longitude = Number(point?.lng ?? point?.longitude);
        setPickerOpen(false);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        setForm(prev => ({ ...prev, latitude, longitude,
            location_name: prev.location_name.trim() || String(point?.name || '').trim().slice(0, 80) }));
    }

    async function publish(event) {
        event.preventDefault();
        if (disabled) return;
        const fields = {
            ...Object.fromEntries(TEXT_FIELDS.map(key => [key, form[key].trim()])),
            latitude: center ? center.lat : null,
            longitude: center ? center.lng : null
        };
        if (!fields.name || !fields.description || !fields.information) {
            setError(t('admin:exhibitions.fillRequired'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const data = await request('/admin/exhibitions', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
            });
            setCurrent({ ...fields, id: data.id });
            setForm(fields);
            window.dispatchEvent(new Event('exhibition-updated'));
            showTip(t('admin:exhibitions.published'));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    }

    async function unpublish() {
        if (disabled || !await confirm(t('admin:exhibitions.confirmUnpublish'))) return;
        setBusy(true);
        setError('');
        try {
            await request('/admin/exhibitions/current', { method: 'DELETE' });
            setCurrent(null);
            window.dispatchEvent(new Event('exhibition-updated'));
            showTip(t('admin:exhibitions.unpublished'));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    }

    return <section aria-labelledby="exhibition-settings-title">
        <h3 id="exhibition-settings-title" style={{ marginTop: 0 }}>{t('admin:exhibitions.title')}</h3>
        <p aria-live="polite" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
            {loading ? t('admin:exhibitions.loading') : current
                ? t('admin:exhibitions.current', { name: current.name }) : t('admin:exhibitions.empty')}
        </p>
        <form onSubmit={publish} style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <ExhibitionIcon url={form.icon_url} backendUrl={backendUrl} />
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                    aria-label={t('admin:exhibitions.addIcon')} hidden disabled={disabled} onChange={uploadIcon} />
                <Button themeAware disabled={disabled} onClick={() => fileRef.current?.click()}>
                    <span aria-hidden="true">＋ </span>{t('admin:exhibitions.addIcon')}
                </Button>
                {form.icon_url && <Button themeAware disabled={disabled} onClick={() => setForm(prev => ({ ...prev, icon_url: '' }))}>
                    {t('admin:exhibitions.removeIcon')}
                </Button>}
                <small style={{ color: 'var(--color-text-secondary)' }}>{t('admin:exhibitions.iconHint')}</small>
            </div>
            <label htmlFor="exhibition-name">{t('admin:exhibitions.name')}</label>
            <TextInput id="exhibition-name" value={form.name} onChange={change('name')} maxLength={80} required disabled={disabled} style={{ width: '100%' }} />
            <label htmlFor="exhibition-description">{t('admin:exhibitions.description')}</label>
            <TextArea id="exhibition-description" value={form.description} onChange={change('description')} maxLength={2000} required disabled={disabled} rows={4} style={{ width: '100%' }} />
            <label htmlFor="exhibition-information">{t('admin:exhibitions.information')}</label>
            <TextInput id="exhibition-information" value={form.information} onChange={change('information')} maxLength={1000} required disabled={disabled} style={{ width: '100%' }} />
            <label htmlFor="exhibition-location">{t('admin:exhibitions.location')}</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <TextInput id="exhibition-location" value={form.location_name} onChange={change('location_name')} maxLength={80} disabled={disabled}
                    placeholder={t('admin:exhibitions.locationPlaceholder')} style={{ flex: '1 1 220px' }} />
                <Button themeAware disabled={disabled} onClick={() => setPickerOpen(true)}>
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18, marginRight: 4, verticalAlign: '-3px' }}>location_on</span>
                    {t('admin:exhibitions.pickLocation')}
                </Button>
                {center && <Button themeAware disabled={disabled} onClick={() => setForm(prev => ({ ...prev, latitude: null, longitude: null }))}>
                    {t('admin:exhibitions.clearLocation')}
                </Button>}
            </div>
            <small aria-live="polite" style={{ color: 'var(--color-text-secondary)', marginTop: -6 }}>
                {center ? t('admin:exhibitions.coordinates', { lat: center.lat.toFixed(6), lng: center.lng.toFixed(6) }) : t('admin:exhibitions.locationHint')}
            </small>
            {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Button type="submit" themeAware disabled={disabled}>{busy ? t('admin:exhibitions.saving') : t('admin:exhibitions.publish')}</Button>
                {current && <Button themeAware disabled={disabled} onClick={unpublish}>{t('admin:exhibitions.unpublish')}</Button>}
                {loadFailed && <Button themeAware onClick={() => setReload(value => value + 1)}>{t('admin:exhibitions.retry')}</Button>}
            </div>
        </form>
        <FullScreenMapPicker open={pickerOpen} title={t('admin:exhibitions.pickLocation')} context="exhibition"
            center={center ? { lat: center.lat, lng: center.lng } : null}
            backendUrl={backendUrl} token={token} isAuthenticated={!!token} onRequireAuth={onRequireAuth}
            onPickPlace={pickLocation} onPickPoint={pickLocation} onClose={() => setPickerOpen(false)} />
    </section>;
}
