import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/primitives/Button';
import Markdown from '../components/markdown/Markdown';
import { fetchPlaceList } from '../api/client';
import { EMPTY_PLACE_FILTER, isPlaceFilterActive, placeFilterKey, placeListQuery } from './placeFilter';
import { formatAverage, tierForAverage, tierLabel } from './rating';
import { imageThumbnailUrl } from '../platform/runtimeConfig';
import { t } from '../i18n/index.js';
import './placeList.css';

const PAGE_SIZE = 20;

export { RADIUS_OPTIONS_KM } from './placeFilter';

/**
 * 地点列表（地图的列表模式与 /places 页共用）：店名、简介（Markdown，只显示前几行）、第一张图与评价；
 * 按综合评价排序，登录后结合口味相近的人的评价。条目不带坐标、地址和距离，只链接 /p/:id，
 * 点开时交给 onOpenPlace（在地图上打开这个地点）。toolbar 放在数量说明右侧。
 */
export default function PlaceListView({ backendUrl, token, filter = EMPTY_PLACE_FILTER, distance = null, onOpenPlace, toolbar = null, children = null }) {
    const [state, setState] = useState({ items: [], total: 0, loading: true, error: '', done: false, personalized: false });
    const requestRef = useRef(0);
    const sentinelRef = useRef(null);
    const queryRef = useRef(null);
    queryRef.current = placeListQuery(filter, distance);
    // 同样的条件不重复请求
    const queryKey = queryRef.current.toString() || placeFilterKey(filter);

    const load = useCallback(async (offset) => {
        const requestId = ++requestRef.current;
        setState((current) => ({ ...current, loading: true, error: '', ...(offset === 0 ? { items: [], done: false } : null) }));
        try {
            const data = await fetchPlaceList(backendUrl, { query: queryRef.current, offset, limit: PAGE_SIZE, token });
            if (requestId !== requestRef.current) return;
            const items = Array.isArray(data.items) ? data.items : [];
            const total = Number(data.total) || 0;
            setState((current) => ({
                items: offset === 0 ? items : [...current.items, ...items],
                total,
                loading: false,
                error: '',
                done: offset + items.length >= total || items.length === 0,
                personalized: !!data.personalized
            }));
        } catch (error) {
            if (requestId !== requestRef.current) return;
            setState((current) => ({ ...current, loading: false, error: error.message || t('places:list.loadFailed') }));
        }
    }, [backendUrl, token, queryKey]);

    useEffect(() => { load(0); }, [load]);

    // 滚到底部自动读下一页
    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') return undefined;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting) && !state.loading && !state.done && !state.error) load(state.items.length);
        }, { rootMargin: '240px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [load, state.loading, state.done, state.error, state.items.length]);

    const narrowed = isPlaceFilterActive(filter) || !!(distance && distance.center && distance.radiusKm);
    return (
        <>
            <div className="fm-place-list__toolbar">
                <span className="fm-place-list__summary" role="status">
                    {state.loading && !state.items.length ? t('common:status.loading') : t('places:list.count', { count: state.total })}
                    {' · '}
                    {state.personalized ? t('places:list.sortPersonalized') : t('places:list.sortDefault')}
                </span>
                {toolbar}
            </div>
            {children}

            {state.error && !state.items.length && (
                <div className="fm-place-list__message" role="alert">
                    {state.error}
                    <Button themeAware onClick={() => load(0)} style={{ marginLeft: 8 }}>{t('places:list.retry')}</Button>
                </div>
            )}
            {!state.loading && !state.error && !state.items.length && (
                <div className="fm-place-list__message">{narrowed ? t('places:list.emptyFiltered') : t('places:list.empty')}</div>
            )}

            <ul className="fm-place-list__grid">
                {state.items.map((place) => <PlaceListItem key={place.id} place={place} onOpen={onOpenPlace} />)}
            </ul>

            <div ref={sentinelRef} className="fm-place-list__more">
                {state.loading && state.items.length > 0 && <span role="status">{t('common:status.loading')}</span>}
                {state.error && state.items.length > 0 && (
                    <Button themeAware onClick={() => load(state.items.length)}>{t('places:list.retry')}</Button>
                )}
                {!state.loading && !state.error && !state.done && state.items.length > 0 && (
                    <Button themeAware onClick={() => load(state.items.length)}>{t('places:list.loadMore')}</Button>
                )}
                {state.done && state.items.length > 0 && <span>{t('places:list.end')}</span>}
            </div>
        </>
    );
}

function PlaceListItem({ place, onOpen }) {
    const tier = tierForAverage(place.rating_average);
    const personalTier = tierForAverage(place.personalized_average);
    const tags = String(place.category || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 4);
    const href = `/p/${encodeURIComponent(place.id)}`;
    const open = (event) => {
        // 在当前应用里打开地图；链接本身保留 /p/:id（新标签页打开时走分享页跳转）
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        onOpen?.(place.id);
    };
    const name = place.name || t('common:label.unnamedPlace');
    // 左边图片；右边上方 2×2：店名 | 评价、标签 | 人均；下方简介（简介放在链接外：里面可能有自己的链接）
    return (
        <li className="fm-place-card">
            <a className="fm-place-card__image" href={href} onClick={open} tabIndex={-1} aria-hidden="true">
                {place.image
                    ? <img src={imageThumbnailUrl(place.image, 240)} alt="" loading="lazy" decoding="async" />
                    : <span className="material-symbols-outlined">restaurant</span>}
            </a>
            <div className="fm-place-card__main">
                <div className="fm-place-card__grid">
                    <a className="fm-place-card__title" href={href} onClick={open} aria-label={t('places:list.openPlace', { name })}>{name}</a>
                    <span className="fm-place-card__rating">
                        {/* 评价人数单独一段：窄屏换到下一行，免得把店名挤没 */}
                        {tier
                            ? (
                                <span className="fm-place-card__score">
                                    <span style={{ color: tier.tone, fontWeight: 700 }}>{t('places:list.rating', { tier: tierLabel(tier), average: formatAverage(place.rating_average) })}</span>
                                    <span className="fm-place-card__count">{t('places:list.ratingCount', { count: place.rating_count })}</span>
                                </span>
                            )
                            : <span>{t('map:rating.summary.none')}</span>}
                        {personalTier && <span className="fm-place-card__personal">{t('places:list.personalRating', { tier: tierLabel(personalTier) })}</span>}
                    </span>
                    <span className="fm-place-card__tags">
                        {tags.length
                            ? tags.map((tag) => <span key={tag} className="fm-place-card__tag">{tag}</span>)
                            : <span className="fm-place-card__muted">{t('common:label.uncategorized')}</span>}
                    </span>
                    <span className="fm-place-card__cost">
                        {place.per_person_cost != null
                            ? t('map:ui.perPersonCost', { per_person_cost: place.per_person_cost })
                            : <span className="fm-place-card__muted">{t('places:list.costUnknown')}</span>}
                    </span>
                </div>
                <Markdown
                    text={place.description}
                    className="fm-place-card__description"
                    fallback={<div className="fm-place-card__description fm-place-card__description--empty">{t('places:list.noDescription')}</div>}
                />
            </div>
        </li>
    );
}
