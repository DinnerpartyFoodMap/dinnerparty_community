import React, { useCallback, useEffect, useState } from 'react';
import Button from '../components/primitives/Button';
import Segmented from '../components/forms/Segmented';
import { t, tx } from '../i18n/index.js';
import { publishMapConsent, request } from '../journey/feedback';
import { Empty, Notice } from '../journey/shared';
import { ProfileShell } from './UserProfilePage';
import '../journey/journey.css';

const PAGE_SIZE = 5;

export default function ProfileCommunityPage({ backendUrl, token, onOpenProfile, onBack, page, onPageChange }) {
    const [neighbors, setNeighbors] = useState(null);
    const [neighborError, setNeighborError] = useState('');
    const [neighborRequest, setNeighborRequest] = useState(0);
    const [settings, setSettings] = useState(null);
    const [stats, setStats] = useState(null);
    const [section, setSection] = useState('neighbors');
    const [view, setView] = useState('list');
    const [researchChoice, setResearchChoice] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    const api = useCallback((path, options) => request(backendUrl, token, `/api/community${path}`, options), [backendUrl, token]);

    useEffect(() => {
        if (!token) return undefined;
        const controller = new AbortController();
        setNeighborError('');
        setNeighbors(null);
        api('/neighbors', { signal: controller.signal }).then((data) => {
            if (!controller.signal.aborted) setNeighbors(data);
        }).catch((failure) => {
            if (!controller.signal.aborted) setNeighborError(failure.message);
        });
        return () => controller.abort();
    }, [api, token, neighborRequest]);

    const perform = async (operation) => {
        setBusy(true);
        setError('');
        setSaved('');
        try { await operation(); } catch (failure) { setError(failure.message); }
        finally { setBusy(false); }
    };

    const selectSection = (value) => {
        setSection(value);
        setError('');
        setSaved('');
        if (value !== 'settings' || settings || busy) return;
        perform(async () => {
            const [consent, feedback] = await Promise.all([api('/consent'), api('/feedback')]);
            setSettings(consent);
            setStats(feedback);
        });
    };

    const saveSettings = () => perform(async () => {
        const consent = await api('/consent', { method: 'PUT', body: JSON.stringify({ ...settings, research_choice: researchChoice }) });
        setSettings(consent);
        publishMapConsent(token, consent);
        setResearchChoice(false);
        setNeighborRequest((requestId) => requestId + 1);
        setStats(await api('/feedback'));
        setSaved(t('journey:community.settingsSaved'));
        onPageChange?.(1);
    });

    const list = neighbors?.neighbors || [];
    const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const currentPage = Math.min(pageCount, Math.max(1, Number(page) || 1));
    const rows = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

    const empty = () => {
        if (neighbors.profile_status === 'disabled') return <Empty title={t('journey:community.empty.disabledTitle')}>
            {t('journey:community.empty.disabledHint')}
            <div className="jw-actions"><Button onClick={() => selectSection('settings')}>{t('journey:community.empty.goToSettings')}</Button></div>
        </Empty>;
        if (neighbors.profile_status === 'ready') return <Empty title={t('journey:community.empty.noMatchTitle')}>{t('journey:community.empty.noMatchHint')}</Empty>;
        return <Empty title={t('journey:community.empty.notEnoughTitle')}>{t('journey:community.empty.notEnoughHint')}</Empty>;
    };

    return <ProfileShell onBack={onBack} title={t('journey:common.feature.community')}>
        <div className="jw-stack" aria-busy={busy}>
            <Segmented role="tablist" label={t('journey:community.tabsLabel')} value={section} onChange={selectSection}
                options={[["neighbors", t('journey:common.feature.community')], ['settings', t('journey:community.tab.settings')]]} />
            {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
            {saved && <Notice tone="success" onClose={() => setSaved('')}>{saved}</Notice>}
            {section === 'neighbors' && (neighbors ? (rows.length ? <>
                <Segmented size="sm" label={t('journey:community.viewModeLabel')} value={view} onChange={setView}
                    options={[["list", t('journey:community.viewMode.list')], ['map', t('journey:community.viewMode.map')]]} />
                {view === 'map' ? <svg viewBox="-1.2 -1.2 2.4 2.4" className="jw-taste" role="group" aria-label={t('journey:community.mapLabel')}>
                    {[0.35, 0.65, 0.95].map((radius) => <circle key={radius} r={radius} fill="none" stroke="currentColor" strokeOpacity=".15" strokeWidth=".008" />)}
                    <circle r=".07" fill="var(--theme-primary)" /><text y=".17" textAnchor="middle" fontSize=".09" fill="currentColor">{t('journey:community.me')}</text>
                    {rows.map((person) => <g key={person.id} role="button" tabIndex="0" aria-label={t('profile:community.openProfile', { name: person.username })}
                        onClick={() => onOpenProfile(person.id)} onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProfile(person.id); }
                        }}>
                        <circle cx={person.x} cy={person.y} r=".045" fill="var(--theme-secondary)" /><title>{person.username}</title>
                    </g>)}
                </svg> : rows.map((person) => <button type="button" className="jw-entry" key={person.id} onClick={() => onOpenProfile(person.id)}>
                    <span className="jw-avatar jw-avatar--empty" aria-hidden="true">{person.username.slice(0, 1)}</span>
                    <span className="jw-entry__body"><strong>{person.username}</strong><small>{tx('journey:community.neighborMeta', {
                        similarity: Math.round(person.similarity * 100), confidence: person.confidence,
                        value: person.shared.length ? ` · ${person.shared.join(' · ')}` : ''
                    })}</small></span>
                </button>)}
                {pageCount > 1 && <nav className="fm-profile__pagination" aria-label={t('profile:community.pagination')}>
                    <Button variant="secondary" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>{t('profile:community.previous')}</Button>
                    <span aria-live="polite">{t('profile:community.page', { current: currentPage, total: pageCount })}</span>
                    <Button variant="secondary" disabled={currentPage >= pageCount} onClick={() => onPageChange(currentPage + 1)}>{t('profile:community.next')}</Button>
                </nav>}
            </> : empty()) : neighborError ? <div className="jw-stack">
                <p role="alert">{neighborError}</p>
                <Button variant="secondary" onClick={() => setNeighborRequest((requestId) => requestId + 1)}>{t('profile:retry')}</Button>
            </div> : <p role="status">{t('common:status.loading')}</p>)}
            {section === 'settings' && (settings ? <>
                <p className="jw-muted">{t('journey:community.settingsHint')}</p>
                <p className="jw-muted">{t('journey:community.retentionHint', { days: stats?.retention_days || settings.retention_days || 90 })}</p>
                <label className="jw-field"><span className="jw-field__label">{t('journey:community.tagsLabel')}</span>
                    <input value={settings.tags.join(t('journey:community.tagSeparator'))} maxLength={500} onChange={(event) => setSettings({ ...settings, tags: event.target.value.split(/[,，]/) })} />
                </label>
                <label className="jw-check"><input type="checkbox" checked={settings.discovery} onChange={(event) => setSettings({ ...settings, discovery: event.target.checked })} />{t('journey:community.consent.discovery')}</label>
                <label className="jw-check"><input type="checkbox" checked={settings.feedback} onChange={(event) => setSettings({ ...settings, feedback: event.target.checked, research: event.target.checked && settings.research })} />{t('journey:community.consent.feedback')}</label>
                <label className="jw-check"><input type="checkbox" disabled={!settings.feedback} checked={settings.research} onChange={(event) => { setSettings({ ...settings, research: event.target.checked }); setResearchChoice(true); }} />{t('journey:community.consent.research')}</label>
                <div className="jw-actions">
                    <Button disabled={busy} onClick={saveSettings}>{t('journey:community.saveSettings')}</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => perform(async () => {
                        const consent = await api('/feedback', { method: 'DELETE' });
                        setSettings(consent);
                        publishMapConsent(token, consent);
                        setStats(await api('/feedback'));
                        setSaved(t('journey:community.interactionsCleared'));
                    })}>{t('journey:community.clearInteractions')}</Button>
                </div>
            </> : !error && <p role="status">{t('common:status.loading')}</p>)}
        </div>
    </ProfileShell>;
}
