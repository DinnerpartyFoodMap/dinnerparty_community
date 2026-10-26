import React, { useEffect, useMemo, useRef, useState } from 'react';
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import TextArea from "../components/forms/TextArea";
import JsonTable from "../components/data/JsonTable";
import { createDinner, deleteDinner, fetchDinnerById, fetchDinners } from "../api/client";
import { useTips } from "../components/feedback/Tips";
import useDarkMode from "../theme/useDarkMode";
import MapView from "../map/MapView";
import Tooltip from "../components/primitives/Tooltip";
import ScrollableView from "../components/layout/ScrollableView";
import { copyText } from "../platform/share";
import MotionSurface from "../components/overlay/MotionSurface";
import FullScreenMapContent from "../components/layout/FullScreenMapContent";
import { useConfirm } from "../components/feedback/Confirm";
import { getLanguage, t, tx } from "../i18n/index.js";

function formatDateTime(value) {
    if (!value) return t('dinner:timeTbd');
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(getLanguage(), { hour12: false });
}

function normalizeInputDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${hh}:${mm}`;
}

function buildShareUrl(id, backendUrl) {
    const normalizedBackend = String(backendUrl || '').replace(/\/+$/, '');
    // Use backend share endpoint so crawlers and direct opens always hit an existing HTML route with OG tags.
    if (normalizedBackend) {
        return `${normalizedBackend}/dinners/${id}/share`;
    }

    const path = `/dinners/${id}/share`;
    if (typeof window === 'undefined' || !window.location || !window.location.origin) {
        return path;
    }
    return `${window.location.origin}${path}`;
}

function pageStyle(dark) {
    return {
        height: '100%',
        minHeight: 0,
        background: 'var(--color-bg-base)',
        color: 'var(--color-text-primary)',
        padding: 20,
        boxSizing: 'border-box'
    };
}

function cardStyle(dark) {
    return {
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
        boxShadow: '0 8px 24px var(--color-glow)',
        padding: 20
    };
}

function containerStyle() {
    return {
        maxWidth: 960,
        margin: '0 auto'
    };
}

function titleRowStyle() {
    return {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 14,
        marginTop: 50
    };
}

function captionStyle(dark) {
    return {
        marginBottom: 14,
        color: 'var(--color-text-secondary)',
        fontSize: 16
    };
}

export function DinnerListPage({ backendUrl, onGoCreate, onOpenDetail, onGoHome }) {
    const dark = useDarkMode();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [items, setItems] = useState([]);

    const sortedItems = useMemo(() => {
        return [...items].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    }, [items]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError('');
            try {
                const data = await fetchDinners(backendUrl);
                if (!cancelled) setItems(Array.isArray(data) ? data : []);
            } catch (e) {
                if (!cancelled) setError(e.message || t('dinner:loadFailed'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [backendUrl]);

    return (
        <ScrollableView as="main" style={pageStyle(dark)}>
            <div style={containerStyle()}>
                <div className="fm-legacy-page-heading" style={titleRowStyle()}>
                    <h2 style={{ margin: 0 }}>{t('dinner:list.title')}</h2>
                </div>

                <div className="fm-page-card" style={cardStyle(dark)}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                        <Button onClick={onGoCreate} style={{ border: 0 }}>{t('dinner:list.create')}</Button>
                    </div>

                    {loading && <div>{t('dinner:list.loading')}</div>}
                    {!!error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
                    {!loading && !error && sortedItems.length === 0 && (
                        <div style={{ color: 'var(--color-text-secondary)' }}>{t('dinner:list.empty')}</div>
                    )}

                    {!loading && !error && sortedItems.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {sortedItems.map((item) => (
                                <div key={item.id} style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: 14, background: 'var(--color-bg-overlay)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <strong style={{ fontSize: 18 }}>{item.title}</strong>
                                        <Button onClick={() => onOpenDetail(item.id)} style={{ padding: '6px 12px', border: 0 }}>{t('dinner:list.viewDetail')}</Button>
                                    </div>
                                    <div style={{ marginTop: 8, color: 'var(--color-text-secondary)' }}>
                                        {formatDateTime(item.start_time)} · {item.place_name}
                                    </div>
                                    <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-muted)' }}>
                                        {tx('dinner:list.meta', { status: item.status || 'open', creator_name: item.creator_name || t('dinner:anonymous') })}
                                    </div>
                                    <div style={{ marginTop: 6, color: 'var(--color-text-primary)' }}>{item.description || t('dinner:list.noDescription')}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </ScrollableView>
    );
}

export function DinnerCreatePage({ backendUrl, token, isAuth, onCreated, onRequireAuth, onBack, onMapPickerOpenChange }) {
    const dark = useDarkMode();
    const dateInputRef = useRef(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [placeName, setPlaceName] = useState('');
    const [startTime, setStartTime] = useState('');
    const [maxParticipants, setMaxParticipants] = useState('');
    const [contactInfo, setContactInfo] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);

    useEffect(() => {
        if (typeof onMapPickerOpenChange === 'function') {
            onMapPickerOpenChange(pickerOpen);
        }
    }, [pickerOpen, onMapPickerOpenChange]);

    useEffect(() => {
        return () => {
            if (typeof onMapPickerOpenChange === 'function') onMapPickerOpenChange(false);
        };
    }, [onMapPickerOpenChange]);

    const submit = async (e) => {
        e.preventDefault();
        if (!isAuth || !token) {
            onRequireAuth && onRequireAuth();
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            const payload = {
                title,
                description,
                place_name: placeName,
                start_time: startTime,
                max_participants: maxParticipants ? Number(maxParticipants) : null,
                contact_info: contactInfo
            };
            const created = await createDinner(backendUrl, token, payload);
            onCreated && onCreated(created);
        } catch (err) {
            setError(err.message || t('dinner:create.failed'));
        } finally {
            setSubmitting(false);
        }
    };

    const openDatePicker = () => {
        const input = dateInputRef.current;
        if (!input) return;
        if (typeof input.showPicker === 'function') {
            input.showPicker();
            return;
        }
        input.focus();
    };

    return (
        <ScrollableView as="main" style={pageStyle(dark)}>
            <div style={containerStyle()}>
                <div className="fm-legacy-page-heading" style={titleRowStyle()}>
                    <h2 style={{ margin: 0 }}>{t('dinner:list.create')}</h2>
                </div>

                <div className="fm-page-card" style={cardStyle(dark)}>
                    <style>{`
                        .dinner-datetime-input::-webkit-calendar-picker-indicator {
                            opacity: 0;
                        }
                        .dinner-datetime-input::-webkit-inner-spin-button,
                        .dinner-datetime-input::-webkit-clear-button {
                            display: none;
                        }
                    `}</style>
                    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dinner:create.titlePlaceholder')} required maxLength={120} />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <TextInput
                                value={placeName}
                                onChange={(e) => setPlaceName(e.target.value)}
                                placeholder={t('dinner:create.placePlaceholder')}
                                required
                                maxLength={120}
                                style={{ flex: 1 }}
                            />
                            <Tooltip text={t('dinner:create.pickPlaceTooltip')} placement="top">
                                <Button
                                    onClick={() => setPickerOpen(true)}
                                    style={{ width: 44, height: 44, padding: 0, borderRadius: '50%', border: 0 }}
                                    aria-label={t('dinner:create.pickPlaceTooltip')}
                                    type="button"
                                >
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 24 }}>location_on</span>
                                </Button>
                            </Tooltip>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <TextInput
                                ref={dateInputRef}
                                className="dinner-datetime-input"
                                type="datetime-local"
                                value={startTime}
                                onChange={(e) => setStartTime(e.target.value)}
                                required
                                style={{ flex: 1 }}
                            />
                            <Tooltip text={t('dinner:create.pickTimeTooltip')} placement="top">
                                <Button
                                    onClick={openDatePicker}
                                    type="button"
                                    aria-label={t('dinner:create.pickTimeTooltip')}
                                    style={{ width: 44, height: 44, padding: 0, borderRadius: '50%', border: 0 }}
                                >
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 24 }}>calendar_month</span>
                                </Button>
                            </Tooltip>
                        </div>
                        <TextInput type="number" min={2} max={1000} value={maxParticipants} onChange={(e) => setMaxParticipants(e.target.value)} placeholder={t('dinner:create.maxParticipantsPlaceholder')} />
                        <TextInput value={contactInfo} onChange={(e) => setContactInfo(e.target.value)} placeholder={t('dinner:create.contactPlaceholder')} maxLength={200} />
                        <TextArea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('dinner:create.descriptionPlaceholder')}
                            maxLength={1200}
                            rows={5}
                            style={{
                                borderRadius: 12,
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-bg-overlay)',
                                color: 'var(--color-text-primary)',
                                padding: 12
                            }}
                        />

                        {!!error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Button type="submit" disabled={submitting} style={{ border: 0 }}>{submitting ? t('dinner:create.submitting') : t('dinner:create.submit')}</Button>
                        </div>
                    </form>
                </div>
            </div>

            {/* 全屏选点器：作为浮层从底部进入；返回键与 Escape 先关闭其中的弹层，再关闭选点器 */}
            <MotionSurface
                show={pickerOpen}
                portal
                preset="sheet"
                overlay={{ onClose: () => setPickerOpen(false), modal: true, kind: 'map-picker', label: t('common:action.pickOnMap') }}
                aria-label={t('common:action.pickOnMap')}
                style={{ position: 'absolute', inset: 0, background: 'var(--color-bg-base)', overflow: 'hidden' }}
            >
                    <FullScreenMapContent onBack={() => setPickerOpen(false)}>
                    <MapView
                        backendUrl={backendUrl}
                        token={token}
                        isAuthenticated={isAuth}
                        onRequireAuth={onRequireAuth}
                        onOpenDinnerCreate={() => { }}
                        onOpenDinners={() => { }}
                        pickerMode
                        onPickPlace={(place) => {
                            const picked = (place && (place.name || place.address)) ? (place.name || place.address) : '';
                            if (picked) setPlaceName(picked);
                            setPickerOpen(false);
                        }}
                        onPickerClose={() => setPickerOpen(false)}
                    />
                    </FullScreenMapContent>
            </MotionSurface>
        </ScrollableView>
    );
}

export function DinnerDetailPage({ backendUrl, dinnerId, token, currentUserId, isAdmin, onBackList, onGoHome }) {
    const dark = useDarkMode();
    const confirm = useConfirm();
    const showTip = useTips();
    const [item, setItem] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState('');
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError('');
            try {
                const data = await fetchDinnerById(backendUrl, dinnerId);
                if (!cancelled) setItem(data);
            } catch (e) {
                if (!cancelled) setError(e.message || t('dinner:loadFailed'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [backendUrl, dinnerId]);

    const shareUrl = item ? buildShareUrl(item.id, backendUrl) : '';
    const ogImageUrl = item ? `${String(backendUrl).replace(/\/+$/, '')}/dinners/${item.id}/og-image` : '';
    const canDelete = !!(item && token && ((currentUserId && String(item.creator_id) === String(currentUserId)) || isAdmin));

    const copyLink = async () => {
        if (!shareUrl) return;
        // WebView 中剪贴板 API 可能受限，copyText 内含降级方案
        setCopied((await copyText(shareUrl)) ? t('dinner:detail.linkCopied') : t('dinner:detail.copyFailed'));
    };

    const handleDelete = async () => {
        if (!item || !token || !canDelete || deleting) return;
        const ok = await confirm(t('dinner:detail.confirmDelete'));
        if (!ok) return;
        setDeleting(true);
        try {
            await deleteDinner(backendUrl, token, item.id);
            showTip(t('dinner:detail.deleted'));
            onBackList && onBackList();
        } catch (e) {
            const msg = (e && e.message) ? e.message : t('dinner:detail.unknownError');
            showTip(t('dinner:detail.deleteFailed', { msg }));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <ScrollableView as="main" style={pageStyle(dark)}>
            <div style={containerStyle()}>
                <div className="fm-legacy-page-heading" style={titleRowStyle()}>
                    <h2 style={{ margin: 0 }}>{t('dinner:detail.title')}</h2>
                </div>

                <div className="fm-page-card" style={cardStyle(dark)}>
                    {loading && <div>{t('dinner:detail.loading')}</div>}
                    {!!error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
                    {!loading && !error && item && (
                        <>
                            <h2 style={{ marginTop: 0 }}>{item.title}</h2>
                            <p style={{ color: 'var(--color-text-secondary)' }}>
                                {formatDateTime(item.start_time)} · {item.place_name}
                            </p>
                            <p style={{ marginBottom: 10 }}>{item.description || t('dinner:list.noDescription')}</p>
                            <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
                                {tx('dinner:detail.creator', { creator_name: item.creator_name || t('dinner:anonymous') })}
                                {item.max_participants ? t('dinner:detail.maxParticipants', { max_participants: item.max_participants }) : ''}
                                {item.contact_info ? t('dinner:detail.contact', { contact_info: item.contact_info }) : ''}
                            </p>
                            <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
                                {tx('dinner:detail.idStatus', { id: item.id, status: item.status || t('dinner:detail.statusOpen') })}
                            </p>
                            <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
                                {tx('dinner:detail.times', { createdAt: formatDateTime(item.created_time), updatedAt: formatDateTime(item.updated_time) })}
                            </p>

                            <div style={{ marginTop: 12, padding: 12, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-bg-overlay)' }}>
                                <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('dinner:detail.shareTitle')}</div>
                                <div style={{ wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>{shareUrl}</div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                    <Button onClick={copyLink} style={{ border: 0 }}>{t('dinner:detail.copyLink')}</Button>
                                    <a href={shareUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                                        <Button style={{ border: 0 }}>{t('dinner:detail.openSharePage')}</Button>
                                    </a>
                                    {canDelete && (
                                        <Button onClick={handleDelete} disabled={deleting} style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', border: 0 }}>
                                            {deleting ? t('dinner:detail.deleting') : t('dinner:detail.delete')}
                                        </Button>
                                    )}
                                </div>
                                {!!copied && <div style={{ marginTop: 8, color: 'var(--color-success)' }}>{copied}</div>}
                            </div>

                            <div style={{ marginTop: 14 }}>
                                <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('dinner:detail.ogTitle')}</div>
                                <img src={ogImageUrl} alt={t('dinner:detail.ogAlt')} style={{ width: '100%', borderRadius: 12, border: 0 }} />
                            </div>

                            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                                <Button onClick={onBackList} style={{ border: 0 }}>{t('dinner:detail.backToList')}</Button>
                                <Button onClick={onGoHome} style={{ border: 0 }}>{t('common:action.backToMap')}</Button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </ScrollableView>
    );
}

export function parseDinnerIdFromPath(pathname) {
    const m = String(pathname || '').match(/^\/dinners\/(\d+)(?:\/)?$/);
    return m ? Number(m[1]) : null;
}

export function isDinnerPath(pathname) {
    return /^\/dinners(?:\/new|\/\d+)?\/?$/.test(String(pathname || ''));
}

export function normalizeDinnerCreateDefaultTime() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 30);
    return normalizeInputDateTime(now.toISOString());
}
