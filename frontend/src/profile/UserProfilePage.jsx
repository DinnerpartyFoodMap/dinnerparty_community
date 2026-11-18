import React, { useCallback, useEffect, useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import Button from '../components/primitives/Button';
import PageHeading from '../components/layout/PageHeading';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import TasteRadar from './TasteRadar';
import { axisLabel, normalizeTaste, SELF_LEVELS, selfLevelLabel, axisValueWord } from './tasteAxes';
import { fetchUserProfile, saveFavoriteVisibility, saveProfileWidgets, saveTasteLevel, setUserBlocked } from '../api/client';
import { userReportPrefill } from '../feedback/feedbackTypes';
import { formatAverage, ratingTierFor, tierForAverage, tierLabel } from '../places/rating';
import { imageThumbnailUrl } from '../platform/runtimeConfig';
import { getThemeColor, DEFAULT_PRIMARY } from '../theme/theme';
import defaultAvatar from '../img/default.png';
import { resolveAvatarUrl } from '../auth/avatarUrl.js';
import { t } from '../i18n/index.js';
import './profile.css';

const WIDGETS = ['recent', 'favorite'];
// 文案键写成字面量，i18n 检查才能覆盖
const WIDGET_TEXT = {
    recent: { title: () => t('profile:widgets.recent.title'), empty: () => t('profile:widgets.recent.empty') },
    favorite: { title: () => t('profile:widgets.favorite.title'), empty: () => t('profile:widgets.favorite.empty') }
};

export default function UserProfilePage({ backendUrl, token, userId, currentUser, onOpenPlace, onOpenFeedback, onRequireAuth, onOpenCommunity, onOpenFavorites, onBack }) {
    const showTip = useTips();
    const confirm = useConfirm();
    const accent = getThemeColor() || DEFAULT_PRIMARY;
    const [profile, setProfile] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [selectedAxis, setSelectedAxis] = useState(null);
    const [editingWidgets, setEditingWidgets] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setProfile(await fetchUserProfile(backendUrl, userId, { token }));
        } catch (e) {
            setError(e.status === 404 ? t('profile:notFound') : (e.message || t('profile:loadFailed')));
        } finally {
            setLoading(false);
        }
    }, [backendUrl, userId, token]);

    useEffect(() => { load(); }, [load]);

    if (loading && !profile) return <ProfileShell onBack={onBack}><div className="fm-profile__message" role="status">{t('common:status.loading')}</div></ProfileShell>;
    if (error && !profile) {
        return (
            <ProfileShell onBack={onBack}>
                <div className="fm-profile__message" role="alert">
                    {error}
                    <Button variant="secondary" onClick={load} style={{ marginLeft: 8 }}>{t('profile:retry')}</Button>
                </div>
            </ProfileShell>
        );
    }

    const { user, relation = {}, city, widgets = [], content = {} } = profile;
    const self = !!relation.self || (currentUser && String(currentUser.id) === String(user.id));
    const collection = content.collection?.[0];
    const secondWidget = widgets.findLast((item) => WIDGETS.includes(item)) || WIDGETS[0];
    const axes = normalizeTaste(profile.taste);
    const axis = axes.find((item) => item.key === selectedAxis) || null;
    const avatar = resolveAvatarUrl(user, backendUrl, { defaultUrl: defaultAvatar });

    const setBlocked = async (blocked) => {
        if (!token) { onRequireAuth?.(); return; }
        if (blocked && !(await confirm(t('profile:blockConfirm', { name: user.username }), { destructive: true, confirmLabel: t('common:action.block') }))) return;
        setBusy(true);
        try {
            await setUserBlocked(backendUrl, token, user.id, blocked);
            showTip(blocked ? t('profile:blocked', { name: user.username }) : t('profile:unblocked', { name: user.username }));
            await load();
            if (blocked) onOpenFeedback?.(userReportPrefill(user));
        } catch (e) {
            showTip(t('profile:blockFailed', { message: e.message || e }));
        } finally {
            setBusy(false);
        }
    };

    const setSelfLevel = async (level) => {
        if (!axis) return;
        setBusy(true);
        try {
            const data = await saveTasteLevel(backendUrl, token, axis.key, level);
            setProfile((current) => ({ ...current, taste: data.taste }));
        } catch (e) {
            showTip(e.message || t('profile:taste.saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const saveWidgets = async () => {
        setBusy(true);
        try {
            await saveProfileWidgets(backendUrl, token, ['collection', editingWidgets]);
            setEditingWidgets(null);
            await load();
        } catch (e) {
            showTip(e.message || t('profile:widgets.saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const setCollectionVisibility = async (isPublic) => {
        setBusy(true);
        try {
            const data = await saveFavoriteVisibility(backendUrl, token, isPublic);
            setProfile((current) => ({ ...current, collection_visibility: data.is_public }));
        } catch (e) {
            showTip(e.message || t('profile:widgets.collection.saveVisibilityFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <ProfileShell onBack={onBack}>
            <header className="fm-profile__header">
                <div className="fm-profile__identity">
                    <img className="fm-profile__avatar" src={avatar} alt="" onError={(event) => { event.currentTarget.src = defaultAvatar; }} />
                    <div className="fm-profile__name-row">
                        <h2 className="fm-profile__name">{user.username || t('profile:anonymous')}</h2>
                        {self && token && onOpenCommunity && <Button variant="secondary" onClick={onOpenCommunity}>{t('journey:common.feature.community')}</Button>}
                    </div>
                    <div className="fm-profile__city">
                        <span className="material-symbols-outlined" aria-hidden="true">location_on</span>
                        {city ? t('profile:city', { city }) : t('profile:cityUnknown')}
                    </div>
                    {relation.can_block && (
                        <div className="fm-profile__actions">
                            {relation.blocked
                                ? <Button onClick={() => setBlocked(false)} disabled={busy}>{t('profile:unblock')}</Button>
                                : <Button onClick={() => setBlocked(true)} disabled={busy} style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', border: 0 }}>{t('profile:blockAndReport')}</Button>}
                        </div>
                    )}
                </div>
                <div className="fm-profile__radar">
                    <TasteRadar axes={axes} selected={selectedAxis} onSelect={(key) => setSelectedAxis((current) => (current === key ? null : key))} accent={accent} />
                    {self && token && <div className="fm-profile__radar-hint">{t('profile:taste.hint')}</div>}
                </div>
            </header>

            {axis && (
                <section className="fm-profile__axis" aria-live="polite">
                    <div className="fm-profile__axis-title">
                        <strong>{axisLabel(axis.key)}</strong>
                        <span>{axisValueWord(axis)}</span>
                    </div>
                    {self && token && <div className="fm-profile__self">
                        <div className="fm-profile__self-label">{t('profile:taste.self.title')}</div>
                        <div role="radiogroup" aria-label={t('profile:taste.self.title')} className="fm-profile__self-options">
                            {SELF_LEVELS.map((level) => (
                                <button key={level} type="button" role="radio" aria-checked={axis.selfLevel === level} disabled={busy}
                                    className={`fm-profile__chip${axis.selfLevel === level ? ' is-selected' : ''}`} onClick={() => setSelfLevel(level)}>
                                    {selfLevelLabel(level)}
                                </button>
                            ))}
                            <button type="button" role="radio" aria-checked={axis.selfLevel === null} disabled={busy}
                                className={`fm-profile__chip${axis.selfLevel === null ? ' is-selected' : ''}`} onClick={() => setSelfLevel(null)}>
                                {t('profile:taste.self.auto')}
                            </button>
                        </div>
                    </div>}
                </section>
            )}

            {relation.blocked ? (
                <div className="fm-profile__message">{t('profile:blockedNote')}</div>
            ) : (
                <>
                    {collection && <section className="fm-profile__widget">
                        <div className="fm-profile__widget-heading">
                            <h3>{self ? t('profile:widgets.collection.mine') : t('profile:widgets.collection.title')}</h3>
                            {self && token && typeof profile.collection_visibility === 'boolean' && <label className="fm-profile__visibility">
                                <input type="checkbox" role="switch" checked={profile.collection_visibility} disabled={busy}
                                    onChange={(event) => setCollectionVisibility(event.target.checked)} />
                                {t('profile:widgets.collection.public')}
                            </label>}
                            {onOpenFavorites && <Button variant="secondary" onClick={() => onOpenFavorites(user.id)}>{t('profile:widgets.collection.viewAll')}</Button>}
                        </div>
                        {collection.places?.length ? <PlaceRow places={collection.places} onOpenPlace={onOpenPlace} />
                            : <div className="fm-profile__empty">{t('profile:widgets.collection.empty')}</div>}
                    </section>}
                    <ProfileWidget widget={secondWidget} data={content[secondWidget]} onOpenPlace={onOpenPlace} />
                    {self && token && (
                        <div className="fm-profile__widgets-bar">
                            {editingWidgets ? (
                                <>
                                    <label className="fm-profile__widget-select">
                                        {t('profile:widgets.slot', { index: 2 })}
                                        <select value={editingWidgets} onChange={(event) => setEditingWidgets(event.target.value)}>
                                            {WIDGETS.map((option) => <option key={option} value={option}>{WIDGET_TEXT[option].title()}</option>)}
                                        </select>
                                    </label>
                                    <Button onClick={() => setEditingWidgets(null)} disabled={busy}>{t('common:action.cancel')}</Button>
                                    <Button onClick={saveWidgets} disabled={busy}>{t('common:action.save')}</Button>
                                </>
                            ) : (
                                <Button onClick={() => setEditingWidgets(secondWidget)}>{t('profile:widgets.edit')}</Button>
                            )}
                        </div>
                    )}
                </>
            )}
        </ProfileShell>
    );
}

export function ProfileShell({ onBack, title = t('profile:title'), children }) {
    return (
        <ScrollableView as="main" className="fm-profile-page">
            <div className="fm-profile">
                <PageHeading title={title} onBack={onBack} backLabel={t('common:action.back')} style={{ marginBottom: 0 }} />
                {children}
            </div>
        </ScrollableView>
    );
}

function ProfileWidget({ widget, data, onOpenPlace }) {
    const text = WIDGET_TEXT[widget] || WIDGET_TEXT.recent;
    const title = text.title();
    const places = Array.isArray(data) ? data : [];
    return (
        <section className="fm-profile__widget">
            <h3>{title}</h3>
            {places.length ? <PlaceRow places={places} onOpenPlace={onOpenPlace} showOwnScore={widget === 'favorite'} /> : <div className="fm-profile__empty">{text.empty()}</div>}
        </section>
    );
}

export function PlaceRow({ places, onOpenPlace, showOwnScore = false, grid = false }) {
    return (
        <ul className={grid ? 'fm-profile__places fm-profile__places--grid' : 'fm-profile__places'}>
            {places.map((place) => {
                const tier = showOwnScore ? ratingTierFor(place.own_score) : tierForAverage(place.rating_average);
                return (
                    <li key={place.id}>
                        <a href={`/p/${encodeURIComponent(place.id)}`} onClick={(event) => { event.preventDefault(); onOpenPlace?.(place.id); }}>
                            <span className="fm-profile__place-image">
                                {place.image
                                    ? <img src={imageThumbnailUrl(place.image, 200)} alt="" loading="lazy" />
                                    : <span className="material-symbols-outlined" aria-hidden="true">restaurant</span>}
                            </span>
                            <span className="fm-profile__place-name">{place.name}</span>
                            <span className="fm-profile__place-meta">
                                {tier ? (showOwnScore ? tierLabel(tier) : t('profile:placeRating', { tier: tierLabel(tier), average: formatAverage(place.rating_average) })) : (place.category || '')}
                            </span>
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}
