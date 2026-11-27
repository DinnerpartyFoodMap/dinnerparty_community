import React, { useEffect, useRef, useState } from 'react';
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import TextArea from "../components/forms/TextArea";
import { createDinner, deleteDinner, DINNER_PAGE_SIZE, fetchDinnerById, fetchDinners, saveDinnerProposal, saveDinnerSchedule, setDinnerParticipation } from "../api/client";
import { useTips } from "../components/feedback/Tips";
import MapView from "../map/MapView";
import Tooltip from "../components/primitives/Tooltip";
import ScrollableView from "../components/layout/ScrollableView";
import { copyText } from "../platform/share";
import { materialIcon } from '../platform/iconRegistry.js';
import MotionSurface from "../components/overlay/MotionSurface";
import FullScreenMapContent from "../components/layout/FullScreenMapContent";
import { useConfirm } from "../components/feedback/Confirm";
import { getLanguage, t, tx } from "../i18n/index.js";
import './dinner.css';

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

function toStartTime(value) {
    return value ? new Date(value).toISOString() : null;
}

function dinnerStatus(item) {
    return item.is_ended ? t('dinner:detail.statusEnded') : t('dinner:detail.statusOpen');
}

function DinnerSummary({ item }) {
    return <>
        <p className="dinner-meta">{formatDateTime(item.start_time)} · {item.place_name || t('dinner:placeTbd')}</p>
        <p className="dinner-meta dinner-caption">{tx('dinner:list.meta', {
            status: dinnerStatus(item), creator_name: item.creator_name || t('dinner:anonymous')
        })}</p>
    </>;
}

function DinnerPageHeading({ children }) {
    return <h1 className="fm-legacy-page-heading dinner-heading">{children}</h1>;
}

export function DinnerListPage({ backendUrl, onGoCreate, onOpenDetail }) {
    const [query, setQuery] = useState('');
    const [includeEnded, setIncludeEnded] = useState(false);
    const [offset, setOffset] = useState(0);
    const [retry, setRetry] = useState(0);
    const [debounceQuery, setDebounceQuery] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [items, setItems] = useState([]);
    const [hasMore, setHasMore] = useState(false);

    const resetList = (debounce = false) => {
        setOffset(0);
        setDebounceQuery(debounce);
        setItems([]);
        setHasMore(false);
        setError('');
        setLoading(true);
    };

    const submitSearch = event => {
        event.preventDefault();
        resetList();
        setRetry(value => value + 1);
    };

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        const timer = setTimeout(async () => {
            try {
                const data = await fetchDinners(backendUrl, { query, includeEnded, offset, signal });
                if (signal.aborted) return;
                setItems(previous => offset ? [...previous, ...data.filter(item => !previous.some(saved => saved.id === item.id))] : data);
                setHasMore(data.length === DINNER_PAGE_SIZE);
            } catch (e) {
                if (!signal.aborted) setError(e.message || t('dinner:loadFailed'));
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        }, !offset && query && debounceQuery ? 250 : 0);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [backendUrl, query, includeEnded, offset, retry, debounceQuery]);

    return (
        <ScrollableView as="main" className="dinner-page">
            <div className="dinner-content">
                <DinnerPageHeading>{t('dinner:list.title')}</DinnerPageHeading>
                <div className="dinner-list-toolbar">
                    <Button onClick={onGoCreate}>{t('dinner:list.create')}</Button>
                    <form className="dinner-search" role="search" onSubmit={submitSearch}>
                        <TextInput type="search" maxLength={120} value={query} placeholder={t('dinner:list.search')}
                            aria-label={t('dinner:list.search')} onChange={event => { setQuery(event.target.value); resetList(true); }} />
                        <Button type="submit" className="dinner-search-submit" aria-label={t('common:action.search')} title={t('common:action.search')}>
                            <span className="material-symbols-outlined" aria-hidden="true">{materialIcon('search')}</span>
                        </Button>
                    </form>
                </div>
                <label className="dinner-switch">
                    {t('dinner:list.showEnded')}
                    <input type="checkbox" role="switch" checked={includeEnded}
                        onChange={event => { setIncludeEnded(event.target.checked); resetList(); }} />
                </label>
                <div className="dinner-list" aria-busy={loading}>
                    {items.map(item => <article className="dinner-card dinner-stack" key={item.id}>
                        <div className="dinner-card-heading">
                            <h2>{item.title}</h2>
                            <Button variant="secondary" onClick={() => onOpenDetail(item.id)}>{t('dinner:list.viewDetail')}</Button>
                        </div>
                        <DinnerSummary item={item} />
                        {!!item.description && <p>{item.description}</p>}
                    </article>)}
                    {loading && <p role="status" className="dinner-meta">{t('dinner:list.loading')}</p>}
                    {error && <div className="dinner-actions">
                        <p role="alert" className="dinner-error">{error}</p>
                        <Button variant="secondary" onClick={() => { setError(''); setLoading(true); setRetry(value => value + 1); }}>{t('common:action.retry')}</Button>
                    </div>}
                    {!loading && !error && !items.length && <p className="dinner-meta">{query.trim() ? t('dinner:list.noResults') : t('dinner:list.empty')}</p>}
                    {!loading && !error && hasMore && <Button variant="secondary" onClick={() => { setLoading(true); setOffset(offset + DINNER_PAGE_SIZE); }}>
                        {t('dinner:list.loadMore')}
                    </Button>}
                </div>
            </div>
        </ScrollableView>
    );
}

export function DinnerCreatePage({ backendUrl, token, isAuth, onCreated, onRequireAuth, onMapPickerOpenChange }) {
    const dateInputRef = useRef(null);
    const submitContext = useRef(null);
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
        const context = { active: true };
        submitContext.current = context;
        setSubmitting(false);
        return () => { context.active = false; };
    }, [backendUrl, token]);

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
        const context = submitContext.current;
        if (submitting || !context?.active) return;
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
                start_time: toStartTime(startTime),
                max_participants: maxParticipants ? Number(maxParticipants) : null,
                contact_info: contactInfo
            };
            const created = await createDinner(backendUrl, token, payload);
            if (context.active) onCreated?.(created);
        } catch (err) {
            if (context.active) setError(err.message || t('dinner:create.failed'));
        } finally {
            if (context.active) setSubmitting(false);
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
        <ScrollableView as="main" className="dinner-page">
            <div className="dinner-content">
                <DinnerPageHeading>{t('dinner:list.create')}</DinnerPageHeading>

                <div className="dinner-card">
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
                        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dinner:create.titlePlaceholder')} aria-label={t('dinner:create.titlePlaceholder')} required maxLength={120} />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <TextInput
                                value={placeName}
                                onChange={(e) => setPlaceName(e.target.value)}
                                placeholder={t('dinner:create.placePlaceholder')}
                                aria-label={t('dinner:create.placePlaceholder')}
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
                        <label className="dinner-field">
                            {t('dinner:create.timeOptional')}
                            <TextInput
                                ref={dateInputRef}
                                className="dinner-datetime-input"
                                type="datetime-local"
                                value={startTime}
                                onChange={(e) => setStartTime(e.target.value)}
                                aria-label={t('dinner:create.timeOptional')}
                            />
                        </label>
                        <div className="dinner-actions">
                            <Button variant="secondary" onClick={openDatePicker}>{t('dinner:create.pickTimeTooltip')}</Button>
                            {startTime && <Button variant="plain" onClick={() => setStartTime('')}>{t('dinner:schedule.clearTime')}</Button>}
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
                                borderRadius: 'var(--radius-md)',
                                padding: 12
                            }}
                        />

                        {!!error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Button type="submit" disabled={submitting}>{submitting ? t('dinner:create.submitting') : t('dinner:create.submit')}</Button>
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

function DinnerProposalForm({ proposal, busy, onSave }) {
    const [places, setPlaces] = useState(() => Array.from({ length: 3 }, (_, index) => proposal?.places[index] || ''));
    const [times, setTimes] = useState(() => Array.from({ length: 3 }, (_, index) => normalizeInputDateTime(proposal?.times[index])));
    const updateOption = (setter, index, value) => setter(previous => previous.map((option, i) => i === index ? value : option));

    return <form className="dinner-card dinner-form" onSubmit={event => {
        event.preventDefault();
        onSave({ places: places.map(place => place.trim()).filter(Boolean), times: times.filter(Boolean).map(toStartTime) });
    }}>
        <h3>{t('dinner:proposal.title')}</h3>
        <p className="dinner-meta">{t('dinner:proposal.hint')}</p>
        <div className="dinner-fields">
            {places.map((place, index) => <TextInput key={index} value={place} maxLength={120}
                placeholder={t('dinner:proposal.place', { number: index + 1 })}
                aria-label={t('dinner:proposal.place', { number: index + 1 })}
                onChange={event => updateOption(setPlaces, index, event.target.value)} />)}
        </div>
        <div className="dinner-fields">
            {times.map((time, index) => <label className="dinner-field" key={index}>
                {t('dinner:proposal.time', { number: index + 1 })}
                <TextInput type="datetime-local" value={time} onChange={event => updateOption(setTimes, index, event.target.value)} />
            </label>)}
        </div>
        <div><Button type="submit" disabled={busy}>{busy ? t('dinner:saving') : t('dinner:proposal.save')}</Button></div>
    </form>;
}

function DinnerScheduleForm({ item, busy, onSave }) {
    const [place, setPlace] = useState(item.place_name);
    const [time, setTime] = useState(normalizeInputDateTime(item.start_time));
    const places = [...new Set(item.proposals.flatMap(proposal => proposal.places))];
    const times = [...new Set(item.proposals.flatMap(proposal => proposal.times))].sort();

    return <form className="dinner-card dinner-form" onSubmit={event => {
        event.preventDefault();
        onSave({
            place_name: place,
            start_time: time === normalizeInputDateTime(item.start_time) ? item.start_time : toStartTime(time)
        });
    }}>
        <h3>{t('dinner:schedule.title')}</h3>
        <label className="dinner-field">
            {t('dinner:schedule.place')}
            <TextInput value={place} onChange={event => setPlace(event.target.value)} maxLength={120} />
        </label>
        <label className="dinner-field">
            {t('dinner:schedule.time')}
            <TextInput type="datetime-local" value={time} onChange={event => setTime(event.target.value)} />
        </label>
        {time && <div><Button variant="plain" onClick={() => setTime('')}>{t('dinner:schedule.clearTime')}</Button></div>}
        <div className="dinner-stack">
            <h4>{t('dinner:proposal.suggested')}</h4>
            {!places.length && !times.length && <p className="dinner-meta">{t('dinner:proposal.empty')}</p>}
            {!!places.length && <div className="dinner-stack">
                <p className="dinner-meta">{t('dinner:proposal.places')}</p>
                <div className="dinner-actions">{places.map(value => <Button key={value} variant="secondary" onClick={() => setPlace(value)}>{value}</Button>)}</div>
            </div>}
            {!!times.length && <div className="dinner-stack">
                <p className="dinner-meta">{t('dinner:proposal.times')}</p>
                <div className="dinner-actions">{times.map(value => <Button key={value} variant="secondary" onClick={() => setTime(normalizeInputDateTime(value))}>{formatDateTime(value)}</Button>)}</div>
            </div>}
        </div>
        <div><Button type="submit" disabled={busy}>{busy ? t('dinner:saving') : t('dinner:schedule.save')}</Button></div>
    </form>;
}

export function DinnerDetailPage({ backendUrl, dinnerId, token, currentUserId, isAdmin, onBackList, onGoHome, onRequireAuth }) {
    const confirm = useConfirm();
    const showTip = useTips();
    const session = useRef(null);
    const [item, setItem] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [actionError, setActionError] = useState('');
    const [retry, setRetry] = useState(0);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        session.current = signal;
        setLoading(true);
        setBusy(false);
        setError('');
        setActionError('');
        fetchDinnerById(backendUrl, dinnerId, { token, signal }).then(data => {
            if (!signal.aborted) setItem(data);
        }).catch(e => {
            if (!signal.aborted) setError(e.message || t('dinner:loadFailed'));
        }).finally(() => {
            if (!signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [backendUrl, dinnerId, token, retry]);

    const shareUrl = item ? buildShareUrl(item.id, backendUrl) : '';
    const canDelete = !!(item && token && ((currentUserId && item.creator_id === String(currentUserId)) || isAdmin));

    const change = async (action, { confirmText, success } = {}) => {
        if (!token) { onRequireAuth?.(); return; }
        const signal = session.current;
        if (busy || !signal || signal.aborted) return;
        setBusy(true);
        setActionError('');
        try {
            if (confirmText && !await confirm(confirmText, { destructive: true })) return;
            if (signal.aborted) return;
            const updated = await action();
            if (signal.aborted) return;
            if (updated?.id && !updated.success) setItem(updated);
            success?.();
        } catch (e) {
            if (!signal.aborted) setActionError(e.message || t('dinner:updateFailed'));
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    };

    return <ScrollableView as="main" className="dinner-page">
        <div className="dinner-content dinner-list">
            <DinnerPageHeading>{t('dinner:detail.title')}</DinnerPageHeading>
            {loading && <p role="status" className="dinner-meta">{t('dinner:detail.loading')}</p>}
            {error && <div className="dinner-actions">
                <p role="alert" className="dinner-error">{error}</p>
                <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>{t('common:action.retry')}</Button>
            </div>}
            {!loading && !error && item && <>
                <section className="dinner-card dinner-stack">
                    <h2>{item.title}</h2>
                    <DinnerSummary item={item} />
                    {!!item.description && <p className="dinner-description">{item.description}</p>}
                    <p className="dinner-meta">
                        {item.max_participants
                            ? t('dinner:detail.participantsLimited', { count: item.participant_count, max: item.max_participants })
                            : t('dinner:detail.participants', { count: item.participant_count })}
                        {item.contact_info && tx('dinner:detail.contact', { contact_info: item.contact_info })}
                    </p>
                    {!item.is_ended && !item.is_organizer && <div>
                        {item.is_joined ? <Button variant="secondary" disabled={busy} onClick={() => change(
                            () => setDinnerParticipation(backendUrl, token, item.id, false),
                            { confirmText: t('dinner:detail.confirmLeave') }
                        )}>{t('dinner:detail.leave')}</Button> : <>
                            {item.max_participants && item.participant_count >= item.max_participants
                                ? <span className="dinner-meta">{t('dinner:detail.full')}</span>
                                : <Button disabled={busy} onClick={() => change(() => setDinnerParticipation(backendUrl, token, item.id, true))}>{t('dinner:detail.join')}</Button>}
                        </>}
                    </div>}
                </section>
                {!item.is_ended && item.is_joined && !item.is_organizer && <DinnerProposalForm
                    proposal={item.my_proposal} busy={busy} onSave={proposal => change(
                        () => saveDinnerProposal(backendUrl, token, item.id, proposal),
                        { success: () => showTip(t('dinner:proposal.saved')) }
                    )} />}
                {!item.is_ended && item.is_organizer && <DinnerScheduleForm item={item} busy={busy} onSave={schedule => change(
                    () => saveDinnerSchedule(backendUrl, token, item.id, schedule),
                    { success: () => showTip(t('dinner:schedule.saved')) }
                )} />}
                {actionError && <p role="alert" className="dinner-error">{actionError}</p>}
                <section className="dinner-card dinner-form">
                    <h3>{t('dinner:detail.shareTitle')}</h3>
                    <a className="dinner-link" href={shareUrl} target="_blank" rel="noreferrer">{t('dinner:detail.openSharePage')}</a>
                    <div className="dinner-actions">
                        <Button variant="secondary" onClick={async () => showTip((await copyText(shareUrl))
                            ? t('dinner:detail.linkCopied') : t('dinner:detail.copyFailed'))}>{t('dinner:detail.copyLink')}</Button>
                        {canDelete && <Button variant="destructive" disabled={busy} onClick={() => change(
                            () => deleteDinner(backendUrl, token, item.id),
                            { confirmText: t('dinner:detail.confirmDelete'), success: () => { showTip(t('dinner:detail.deleted')); onBackList?.(); } }
                        )}>{t('dinner:detail.delete')}</Button>}
                    </div>
                </section>
            </>}
            <div className="dinner-actions">
                <Button onClick={onBackList}>{t('dinner:detail.backToList')}</Button>
                <Button variant="secondary" onClick={onGoHome}>{t('common:action.backToMap')}</Button>
            </div>
        </div>
    </ScrollableView>;
}

export function parseDinnerIdFromPath(pathname) {
    const m = String(pathname || '').match(/^\/dinners\/(\d+)(?:\/)?$/);
    return m ? Number(m[1]) : null;
}

export function isDinnerPath(pathname) {
    return /^\/dinners(?:\/new|\/\d+)?\/?$/.test(String(pathname || ''));
}
