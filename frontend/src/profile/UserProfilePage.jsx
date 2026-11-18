import React, { useCallback, useEffect, useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import Button from '../components/primitives/Button';
import PageHeading from '../components/layout/PageHeading';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import TasteRadar from './TasteRadar';
import { axisLabel, normalizeTaste, SELF_LEVELS, selfLevelLabel, axisValueWord } from './tasteAxes';
import { hiddenProfileWidgets, PROFILE_WIDGET_KINDS, profileRejectedPlaceCount, profileWidgetEmpty, profileWidgetTitle } from './profileViewModel';
import { fetchUserProfile, saveFavoriteVisibility, saveProfileWidgets, saveTasteLevel, setUserBlocked } from '../api/client';
import { userReportPrefill } from '../feedback/feedbackTypes';
import { formatAverage, ratingTierFor, tierForAverage, tierLabel } from '../places/rating';
import { imageThumbnailUrl } from '../platform/runtimeConfig';
import { getThemeColor, DEFAULT_PRIMARY } from '../theme/theme';
import defaultAvatar from '../img/default.png';
import { resolveAvatarUrl } from '../auth/avatarUrl.js';
import { t } from '../i18n/index.js';
import './profile.css';

export default function UserProfilePage({ backendUrl, token, userId, currentUser, onOpenPlace, onOpenFeedback, onRequireAuth, onOpenCommunity, onAction, onBack }) {
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
    const hiddenWidgets = hiddenProfileWidgets(profile);
    const visibleWidgets = PROFILE_WIDGET_KINDS.filter((kind) => !hiddenWidgets.includes(kind));
    const rejectedPlaceCount = self ? profileRejectedPlaceCount(profile, currentUser) : 0;
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
            const data = await saveProfileWidgets(backendUrl, token, widgets, editingWidgets);
            setProfile((current) => ({ ...current, hidden_widgets: data.hidden_widgets ?? editingWidgets }));
            setEditingWidgets(null);
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
                    <div className="fm-profile__identity-text">
                        <h2 className="fm-profile__name">{user.username || t('profile:anonymous')}</h2>
                        <div className="fm-profile__city">
                            <span className="material-symbols-outlined" aria-hidden="true">location_on</span>
                            {city ? t('profile:city', { city }) : t('profile:cityUnknown')}
                        </div>
                    </div>
                </div>
                {self && token && onOpenCommunity && <Button className="fm-profile__header-action" variant="secondary" onClick={onOpenCommunity}>{t('journey:common.feature.community')}</Button>}
                {relation.can_block && (relation.blocked
                    ? <Button className="fm-profile__header-action" onClick={() => setBlocked(false)} disabled={busy}>{t('profile:unblock')}</Button>
                    : <Button className="fm-profile__header-action" variant="destructive" onClick={() => setBlocked(true)} disabled={busy}>{t('profile:blockAndReport')}</Button>)}
            </header>

            <section className="fm-profile__widget fm-profile__radar-section" aria-label={t('profile:taste.title')}>
                <h3>{t('profile:taste.title')}</h3>
                <div className="fm-profile__radar">
                    <TasteRadar axes={axes} selected={selectedAxis} onSelect={(key) => setSelectedAxis((current) => (current === key ? null : key))} accent={accent} />
                    {self && token && <div className="fm-profile__radar-hint">{t('profile:taste.hint')}</div>}
                </div>
                {axis && <div className="fm-profile__axis" aria-live="polite">
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
                </div>}
            </section>

            {relation.blocked ? (
                <div className="fm-profile__message">{t('profile:blockedNote')}</div>
            ) : (
                <>
                    {collection && <ProfileWidget widget="collection" self={self} data={collection.places} onOpenPlace={onOpenPlace}
                        onViewAll={onAction ? () => onAction('favorites', user.id, user.username) : undefined}
                        headingAction={self && token && typeof profile.collection_visibility === 'boolean' && <label className="fm-profile__visibility">
                                <input type="checkbox" role="switch" checked={profile.collection_visibility} disabled={busy}
                                    onChange={(event) => setCollectionVisibility(event.target.checked)} />
                                {t('profile:widgets.collection.public')}
                        </label>} />}
                    {visibleWidgets.map((kind) => <ProfileWidget key={kind} widget={kind} self={self} data={content[kind]} onOpenPlace={onOpenPlace}
                        rejectedPlaceCount={kind === 'recent' ? rejectedPlaceCount : 0}
                        onViewAll={kind === 'recent' && onAction ? () => onAction('my-locations', user.id, user.username) : undefined} />)}
                    {self && token && <div className="fm-profile__widgets-bar">
                        {editingWidgets ? <>
                            {PROFILE_WIDGET_KINDS.map((kind) => <label key={kind} className="fm-profile__widget-toggle">
                                <input type="checkbox" checked={!editingWidgets.includes(kind)} disabled={busy}
                                    onChange={(event) => {
                                        const visible = event.target.checked;
                                        setEditingWidgets((current) => visible ? current.filter((item) => item !== kind) : [...current, kind]);
                                    }} />
                                {profileWidgetTitle(kind, true)}
                            </label>)}
                            <Button variant="secondary" onClick={() => setEditingWidgets(null)} disabled={busy}>{t('common:action.cancel')}</Button>
                            <Button onClick={saveWidgets} disabled={busy}>{t('common:action.save')}</Button>
                        </> : <Button variant="secondary" onClick={() => setEditingWidgets(hiddenWidgets)} disabled={busy}>{t('profile:widgets.edit')}</Button>}
                    </div>}
                    {self && token && onAction && <div className="fm-profile__account-actions">
                        <ProfileAccountAction icon="settings" onClick={() => onAction('settings', user.id)}>{t('map:ui.accountSettings')}</ProfileAccountAction>
                        <ProfileAccountAction icon="pets" onClick={() => onAction('companion', user.id)}>{t('companion:title')}</ProfileAccountAction>
                        <ProfileAccountAction icon="logout" onClick={() => onAction('logout', user.id)}>{t('map:ui.logout')}</ProfileAccountAction>
                    </div>}
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

function ProfileWidget({ widget, self, data, onOpenPlace, onViewAll, headingAction, rejectedPlaceCount = 0 }) {
    const title = profileWidgetTitle(widget, self);
    const places = Array.isArray(data) ? data : [];
    return (
        <section className="fm-profile__widget" aria-label={title}>
            <div className="fm-profile__widget-heading">
                <h3>{title}{rejectedPlaceCount > 0 && <span className="fm-profile__rejected-dot" role="img"
                    aria-label={t('map:ui.myPlacesRejected', { count: rejectedPlaceCount })} />}</h3>
                {headingAction}
            </div>
            {places.length ? <PlaceRow places={places} onOpenPlace={onOpenPlace} showOwnScore={widget === 'favorite'} />
                : <div className="fm-profile__empty">{profileWidgetEmpty(widget)}</div>}
            {onViewAll && <div className="fm-profile__widget-footer">
                <Button variant="secondary" onClick={onViewAll}>{t('profile:widgets.collection.viewAll')}</Button>
            </div>}
        </section>
    );
}

function ProfileAccountAction({ icon, onClick, children }) {
    return <Button variant="menu" className="fm-profile__account-action" onClick={onClick}>
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        {children}
        <span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
    </Button>;
}

function PlaceRow({ places, onOpenPlace, showOwnScore = false }) {
    return (
        <ul className="fm-profile__places">
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
