import React, { useCallback, useEffect, useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import Button from '../components/primitives/Button';
import PageHeading from '../components/layout/PageHeading';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import TasteRadar from './TasteRadar';
import { axisEvidenceText, axisLabel, normalizeTaste, SELF_LEVELS, selfLevelLabel, valueWord } from './tasteAxes';
import { fetchUserProfile, saveProfileWidgets, saveTasteLevel, setUserBlocked } from '../api/client';
import { userReportPrefill } from '../feedback/feedbackTypes';
import { formatAverage, ratingTierFor, tierForAverage, tierLabel } from '../places/rating';
import { imageThumbnailUrl } from '../platform/runtimeConfig';
import { getThemeColor } from '../theme/theme';
import defaultAvatar from '../img/default.png';
import { t } from '../i18n/index.js';
import './profile.css';

const WIDGETS = ['collection', 'recent', 'favorite'];
// 文案键写成字面量，i18n 检查才能覆盖
const WIDGET_TEXT = {
    collection: { title: () => t('profile:widgets.collection.title'), empty: () => t('profile:widgets.collection.empty') },
    recent: { title: () => t('profile:widgets.recent.title'), empty: () => t('profile:widgets.recent.empty') },
    favorite: { title: () => t('profile:widgets.favorite.title'), empty: () => t('profile:widgets.favorite.empty') }
};

// 住民主页（/users/:id）：左上圆形头像、右上六类餐饮偏好雷达、上次定位的城市，下面两个住民自己选的小组件
// （公开收藏夹 / 最近创建的 5 个地点 / 最喜欢的 5 个地点）。屏蔽与举报在这里（App Store 1.2）；自己的主页可以改小组件、自己填喜好。
export default function UserProfilePage({ backendUrl, token, userId, currentUser, onOpenPlace, onOpenFeedback, onRequireAuth, onBack }) {
    const showTip = useTips();
    const confirm = useConfirm();
    const accent = getThemeColor() || '#E2789F';
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
                    <Button themeAware onClick={load} style={{ marginLeft: 8 }}>{t('profile:retry')}</Button>
                </div>
            </ProfileShell>
        );
    }

    const { user, relation = {}, city, widgets = [], content = {} } = profile;
    const self = !!relation.self || (currentUser && String(currentUser.id) === String(user.id));
    const axes = normalizeTaste(profile.taste);
    const axis = axes.find((item) => item.key === selectedAxis) || null;
    const avatar = user.has_avatar ? `${backendUrl}/users/${encodeURIComponent(user.id)}/avatar` : defaultAvatar;

    const setBlocked = async (blocked) => {
        if (!token) { onRequireAuth?.(); return; }
        if (blocked && !(await confirm(t('profile:blockConfirm', { name: user.username })))) return;
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
            await saveProfileWidgets(backendUrl, token, editingWidgets);
            setEditingWidgets(null);
            await load();
        } catch (e) {
            showTip(e.message || t('profile:widgets.saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <ProfileShell onBack={onBack}>
            <header className="fm-profile__header">
                <div className="fm-profile__identity">
                    <img className="fm-profile__avatar" src={avatar} alt="" onError={(event) => { event.currentTarget.src = defaultAvatar; }} />
                    <h2 className="fm-profile__name">{user.username || t('profile:anonymous')}</h2>
                    <div className="fm-profile__city">
                        <span className="material-symbols-outlined" aria-hidden="true">location_on</span>
                        {city ? t('profile:city', { city }) : t('profile:cityUnknown')}
                    </div>
                    {relation.can_block && (
                        <div className="fm-profile__actions">
                            {relation.blocked
                                ? <Button themeAware onClick={() => setBlocked(false)} disabled={busy}>{t('profile:unblock')}</Button>
                                : <Button onClick={() => setBlocked(true)} disabled={busy} style={{ background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', border: 0 }}>{t('profile:blockAndReport')}</Button>}
                        </div>
                    )}
                </div>
                <div className="fm-profile__radar">
                    <TasteRadar axes={axes} selected={selectedAxis} onSelect={(key) => setSelectedAxis((current) => (current === key ? null : key))} accent={accent} />
                    <div className="fm-profile__radar-hint">{t('profile:taste.hint')}</div>
                </div>
            </header>

            {axis && (
                <section className="fm-profile__axis" aria-live="polite">
                    <div className="fm-profile__axis-title">
                        <strong>{axisLabel(axis.key)}</strong>
                        <span style={{ color: accent }}>{valueWord(axis.value)}</span>
                        {axis.basis === 'embedding' && <span className="fm-profile__axis-tag">{t('profile:taste.estimated')}</span>}
                    </div>
                    <p className="fm-profile__axis-text">{axisEvidenceText(axis)}</p>
                    {axis.places.length > 0 && (
                        <ul className="fm-profile__axis-places">
                            {axis.places.map((place) => (
                                <li key={place.id}>
                                    <a href={`/p/${encodeURIComponent(place.id)}`} onClick={(event) => { event.preventDefault(); onOpenPlace?.(place.id); }}>{place.name}</a>
                                    {place.rating != null && <span>{tierLabel(ratingTierFor(place.rating))}</span>}
                                    {place.rating == null && place.favorite && <span>{t('profile:taste.favoriteOnly')}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                    {self && token && (
                        <div className="fm-profile__self">
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
                        </div>
                    )}
                </section>
            )}

            {relation.blocked ? (
                <div className="fm-profile__message">{t('profile:blockedNote')}</div>
            ) : (
                <>
                    {self && token && (
                        <div className="fm-profile__widgets-bar">
                            {editingWidgets ? (
                                <>
                                    {editingWidgets.map((widget, index) => (
                                        <label key={index} className="fm-profile__widget-select">
                                            {t('profile:widgets.slot', { index: index + 1 })}
                                            <select value={widget} onChange={(event) => setEditingWidgets((current) => current.map((item, i) => (i === index ? event.target.value : item)))}>
                                                {WIDGETS.map((option) => <option key={option} value={option}>{WIDGET_TEXT[option].title()}</option>)}
                                            </select>
                                        </label>
                                    ))}
                                    <Button themeAware onClick={() => setEditingWidgets(null)} disabled={busy}>{t('common:action.cancel')}</Button>
                                    <Button themeAware onClick={saveWidgets} disabled={busy}>{t('common:action.save')}</Button>
                                </>
                            ) : (
                                <Button themeAware onClick={() => setEditingWidgets([...widgets])}>{t('profile:widgets.edit')}</Button>
                            )}
                        </div>
                    )}
                    {widgets.map((widget, index) => (
                        <ProfileWidget key={`${widget}-${index}`} widget={widget} data={content[widget]} onOpenPlace={onOpenPlace} />
                    ))}
                </>
            )}
        </ProfileShell>
    );
}

function ProfileShell({ onBack, children }) {
    return (
        <ScrollableView as="main" className="fm-profile-page">
            <div className="fm-profile">
                <PageHeading title={t('profile:title')} onBack={onBack} style={{ marginBottom: 0 }} />
                {children}
            </div>
        </ScrollableView>
    );
}

function ProfileWidget({ widget, data, onOpenPlace }) {
    const text = WIDGET_TEXT[widget] || WIDGET_TEXT.recent;
    const title = text.title();
    if (widget === 'collection') {
        const collections = Array.isArray(data) ? data : [];
        return (
            <section className="fm-profile__widget">
                <h3>{title}</h3>
                {!collections.length && <div className="fm-profile__empty">{t('profile:widgets.collection.empty')}</div>}
                {collections.map((collection) => (
                    <div key={collection.id} className="fm-profile__collection">
                        <div className="fm-profile__collection-title">{t('profile:widgets.collection.item', { title: collection.title, count: collection.total })}</div>
                        <PlaceRow places={collection.places} onOpenPlace={onOpenPlace} />
                    </div>
                ))}
            </section>
        );
    }
    const places = Array.isArray(data) ? data : [];
    return (
        <section className="fm-profile__widget">
            <h3>{title}</h3>
            {places.length ? <PlaceRow places={places} onOpenPlace={onOpenPlace} showOwnScore={widget === 'favorite'} /> : <div className="fm-profile__empty">{text.empty()}</div>}
        </section>
    );
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
