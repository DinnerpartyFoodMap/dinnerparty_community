import React, { useCallback, useEffect, useId, useState } from 'react';
import Button from '../components/primitives/Button';
import Segmented from '../components/forms/Segmented';
import { t } from '../i18n/index.js';
import { publishMapConsent, request } from '../journey/feedback';
import { Empty, Notice } from '../journey/shared';
import { resolveAvatarUrl } from '../auth/avatarUrl.js';
import defaultAvatar from '../img/default.png';
import { ProfileShell } from './UserProfilePage';
import { communityEmptyState, COMMUNITY_MAP_EXTENT, COMMUNITY_MAP_RINGS, layoutCommunityMap, neighborMeta } from './communityViewModel';
import '../journey/journey.css';
import './profile.css';

// 星图里头像的半径（与坐标同一单位；同好间距至少 0.31，见 layoutCommunityMap）
const MAP_AVATAR_RADIUS = 0.1;

// 同好最多 20 人（后端只返回最相似的 20 位），列表与星图都一次显示全部，不分页。
export default function ProfileCommunityPage({ backendUrl, token, currentUser, onOpenProfile, onBack }) {
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
    });

    const people = (neighbors?.neighbors || []).slice(0, 20);
    const avatar = (person) => resolveAvatarUrl(person, backendUrl, { defaultUrl: defaultAvatar });

    const empty = () => {
        const state = communityEmptyState(neighbors);
        return <Empty title={state.title}>
            {state.hint}
            {state.action === 'settings' && <div className="jw-actions"><Button onClick={() => selectSection('settings')}>{state.actionLabel}</Button></div>}
        </Empty>;
    };

    return <ProfileShell onBack={onBack} title={t('journey:common.feature.community')}>
        <div className="jw-stack" aria-busy={busy}>
            <Segmented role="tablist" label={t('journey:community.tabsLabel')} value={section} onChange={selectSection}
                options={[["neighbors", t('journey:common.feature.community')], ['settings', t('journey:community.tab.settings')]]} />
            {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
            {saved && <Notice tone="success" onClose={() => setSaved('')}>{saved}</Notice>}
            {section === 'neighbors' && (neighbors ? (people.length ? <>
                <Segmented size="sm" label={t('journey:community.viewModeLabel')} value={view} onChange={setView}
                    options={[["list", t('journey:community.viewMode.list')], ['map', t('journey:community.viewMode.map')]]} />
                {view === 'map'
                    ? <CommunityStarMap people={people} me={resolveAvatarUrl(currentUser, backendUrl, { defaultUrl: defaultAvatar })}
                        avatar={avatar} onOpenProfile={onOpenProfile} />
                    : <ul className="fm-community__list">
                        {people.map((person) => <li key={person.id}>
                            <button type="button" className="fm-community__row" onClick={() => onOpenProfile(person.id)}
                                aria-label={t('profile:community.openProfile', { name: person.username })}>
                                <img className="fm-community__avatar" src={avatar(person)} alt=""
                                    onError={(event) => { event.currentTarget.src = defaultAvatar; }} />
                                <span className="fm-community__text">
                                    <strong>{person.username}</strong>
                                    <small>{neighborMeta(person)}</small>
                                </span>
                                <span className="material-symbols-outlined fm-community__chevron" aria-hidden="true">chevron_right</span>
                            </button>
                        </li>)}
                    </ul>}
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

/**
 * 以我为中心的偏好星图：按相似度排名分三圈，越相似越靠里，同圈等距排开，20 人也互不遮挡（layoutCommunityMap）；
 * 每位同好显示头像（圆形裁切 + 辅色描边），点按进入主页。
 */
function CommunityStarMap({ people, me, avatar, onOpenProfile }) {
    const clipId = `fm-community-clip-${useId().replace(/:/g, '')}`;
    const extent = COMMUNITY_MAP_EXTENT;
    const r = MAP_AVATAR_RADIUS;
    const layout = layoutCommunityMap(people);
    const open = (event, id) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProfile(id); }
    };
    return <svg viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`} className="jw-taste fm-community__map" role="group" aria-label={t('journey:community.mapLabel')}>
        <defs>
            <clipPath id={clipId} clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5" /></clipPath>
        </defs>
        {COMMUNITY_MAP_RINGS.map((radius) => <circle key={radius} r={radius} fill="none" stroke="currentColor" strokeOpacity=".15" strokeWidth=".008" />)}
        {people.map((person, index) => {
            const { x, y } = layout[index];
            return <g key={person.id} role="button" tabIndex="0" aria-label={t('profile:community.openProfile', { name: person.username })}
                onClick={() => onOpenProfile(person.id)} onKeyDown={(event) => open(event, person.id)}>
                <title>{person.username}</title>
                {/* 透明的大圆是点按区域（与同好间距相同），头像本身小一些 */}
                <circle cx={x} cy={y} r={0.15} fill="transparent" />
                <circle cx={x} cy={y} r={r + 0.012} fill="var(--theme-secondary)" />
                <image href={avatar(person)} x={x - r} y={y - r} width={r * 2} height={r * 2}
                    clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" />
            </g>;
        })}
        {/* 我画在最上层，不拦点按 */}
        <g pointerEvents="none">
            <circle r={r * 1.25 + 0.012} fill="var(--theme-primary)" />
            <image href={me} x={-r * 1.25} y={-r * 1.25} width={r * 2.5} height={r * 2.5} clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" />
            <text y={r * 1.25 + 0.11} textAnchor="middle" fontSize=".085" fill="currentColor" paintOrder="stroke" stroke="var(--color-bg-surface)" strokeWidth=".025">{t('journey:community.me')}</text>
        </g>
    </svg>;
}
