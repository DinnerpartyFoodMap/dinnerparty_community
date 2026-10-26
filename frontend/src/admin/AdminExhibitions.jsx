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

const TEXT_FIELDS = ['name', 'description', 'information', 'icon_url', 'location_name', 'event_time'];
const EMPTY = { name: '', description: '', information: '', icon_url: '', location_name: '', event_time: '', latitude: null, longitude: null };
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
    const [exhibitions, setExhibitions] = useState([]);
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
        request('/admin/exhibitions', { signal: controller.signal }).then(data => {
            if (controller.signal.aborted) return;
            setExhibitions(data.exhibitions);
            const first = data.exhibitions[0] || null;
            setCurrent(first);
            setForm(first ? formFrom(first) : EMPTY);
        }).catch(e => {
            if (controller.signal.aborted) return;
            setLoadFailed(true);
            setError(e.message);
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [backendUrl, token, reload]);

    const change = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
    const disabled = loading || busy || loadFailed;

    function selectExhibition(id) {
        const selected = exhibitions.find(item => String(item.id) === String(id)) || null;
        setCurrent(selected);
        setForm(selected ? formFrom(selected) : EMPTY);
        setError('');
    }

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
        if (!fields.name || !fields.description || !fields.information || !fields.event_time) {
            setError(t('admin:exhibitions.fillRequired'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const data = await request(current ? `/admin/exhibitions/${current.id}` : '/admin/exhibitions', {
                method: current ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
            });
            const saved = { ...fields, id: data.id };
            setCurrent(saved);
            setForm(saved);
            setExhibitions(previous => [...previous.filter(item => item.id !== saved.id), saved]
                .sort((a, b) => (a.event_time || '9999').localeCompare(b.event_time || '9999') || a.id - b.id));
            window.dispatchEvent(new Event('exhibition-updated'));
            showTip(t('admin:exhibitions.published'));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    }

    async function unpublish() {
        if (disabled || !current || !await confirm(t('admin:exhibitions.confirmUnpublish'))) return;
        setBusy(true);
        setError('');
        try {
            await request(`/admin/exhibitions/${current.id}`, { method: 'DELETE' });
            setExhibitions(previous => previous.filter(item => item.id !== current.id));
            setCurrent(null);
            setForm(EMPTY);
            window.dispatchEvent(new Event('exhibition-updated'));
            showTip(t('admin:exhibitions.unpublished'));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    }

    return <section aria-labelledby="exhibition-settings-title">
        <h3 id="exhibition-settings-title" style={{ marginTop: 0 }}>{t('admin:exhibitions.title')}</h3>
        <p aria-live="polite" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
            {loading ? t('admin:exhibitions.loading') : current
                ? t('admin:exhibitions.current', { name: current.name }) : exhibitions.length ? t('admin:exhibitions.newActivity') : t('admin:exhibitions.empty')}
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
            <label htmlFor="exhibition-select">{t('admin:exhibitions.select')}</label>
            <select id="exhibition-select" value={current?.id || ''} disabled={disabled} onChange={event => selectExhibition(event.target.value)}
                style={{ minHeight: 44, maxWidth: '100%', flex: '1 1 180px', background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
                <option value="">{t('admin:exhibitions.newActivity')}</option>
                {exhibitions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <Button themeAware disabled={disabled} onClick={() => selectExhibition('')}>{t('admin:exhibitions.add')}</Button>
        </div>
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
            <label htmlFor="exhibition-time">{t('admin:exhibitions.eventTime')}</label>
            <TextInput id="exhibition-time" type="datetime-local" value={form.event_time} onChange={change('event_time')} required disabled={disabled} style={{ width: '100%' }} />
            <small style={{ color: 'var(--color-text-secondary)' }}>{t('admin:exhibitions.eventTimeHint')}</small>
            <label htmlFor="exhibition-description">{t('admin:exhibitions.description')}</label>
            <TextArea id="exhibition-description" value={form.description} onChange={change('description')} maxLength={2000} required disabled={disabled} rows={6} markdown style={{ width: '100%' }} />
            <label htmlFor="exhibition-information">{t('admin:exhibitions.information')}</label>
            <TextArea id="exhibition-information" value={form.information} onChange={change('information')} maxLength={1000} required disabled={disabled} rows={4} markdown style={{ width: '100%' }} />
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
                <Button type="submit" themeAware disabled={disabled}>{busy ? t('admin:exhibitions.saving') : current ? t('admin:exhibitions.save') : t('admin:exhibitions.publish')}</Button>
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
