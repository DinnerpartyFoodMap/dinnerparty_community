import React, { useEffect, useMemo, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import ScrollableView from "../../components/layout/ScrollableView";
import { fetchCategories, resolveAmapShareRoute, searchPlacesAlongRoute } from "../../api/client";
import { clearAmapRoute, drawAmapRoutes, planAmapRoutes } from "../alongRoute";
import MotionSurface from "../../components/overlay/MotionSurface";
import FullPageHeader from "../../components/layout/FullPageHeader";
import { getPlatform } from "../../platform/env";
import { t, tx } from "../../i18n/index.js";

const MODE_OPTIONS = [
    { value: 'driving', label: t('map:alongRoute.mode.driving'), icon: 'directions_car' },
    { value: 'transit', label: t('map:alongRoute.mode.transit'), icon: 'directions_bus' },
    { value: 'walking', label: t('map:alongRoute.mode.walking'), icon: 'directions_walk' },
    { value: 'riding', label: t('map:alongRoute.mode.riding'), icon: 'directions_bike' }
];

function formatDistance(value) {
    const distance = Number(value);
    if (!Number.isFinite(distance)) return '';
    return distance >= 1000 ? t('map:alongRoute.kilometers', { distance: (distance / 1000).toFixed(distance >= 10000 ? 0 : 1) }) : t('map:alongRoute.meters', { distance: Math.round(distance) });
}

function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('map:alongRoute.aboutMinutes', { minutes });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return t('map:alongRoute.aboutHours', { hours, rest: rest ? t('map:alongRoute.hoursRestMinutes', { rest }) : '' });
}

function normalizeCategoryQuery(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s·•_\-—()（）/\\]+/g, '');
}

function getCategoryMatchScore(name, rawQuery) {
    const candidate = normalizeCategoryQuery(name);
    const query = normalizeCategoryQuery(rawQuery);
    if (!candidate || !query) return Number.POSITIVE_INFINITY;
    if (candidate === query) return 0;
    if (candidate.startsWith(query)) return 1;
    if (candidate.includes(query) || query.includes(candidate)) return 2;

    let queryIndex = 0;
    for (const character of candidate) {
        if (character === query[queryIndex]) queryIndex += 1;
        if (queryIndex === query.length) return 3;
    }
    return Number.POSITIVE_INFINITY;
}

export default function AlongRoutePanel({
    open,
    onClose,
    mapRef,
    backendUrl,
    customThemeColor,
    customThemeSecondary,
    isNarrow,
    placement = 'left',
    mapReady,
    onResults,
    onSelectPlace
}) {
    const [shareUrl, setShareUrl] = useState('');
    const [resolvedUrl, setResolvedUrl] = useState('');
    const [trip, setTrip] = useState(null);
    const [mode, setMode] = useState('driving');
    const [query, setQuery] = useState('');
    const [categoryQuery, setCategoryQuery] = useState('');
    const [categories, setCategories] = useState([]);
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [corridorMeters, setCorridorMeters] = useState(1000);
    const [results, setResults] = useState([]);
    const [routeSummary, setRouteSummary] = useState(null);
    const [selectedRouteIndex, setSelectedRouteIndex] = useState(null);
    const [hasSearched, setHasSearched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const overlaysRef = useRef([]);
    const requestRef = useRef(null);
    const wasOpenRef = useRef(false);
    const planCacheRef = useRef(null);

    const clearRoute = () => {
        clearAmapRoute(mapRef.current, overlaysRef.current);
        overlaysRef.current = [];
    };

    useEffect(() => {
        if (!open) return undefined;
        let active = true;
        fetchCategories(backendUrl)
            .then((items) => { if (active) setCategories(items); })
            .catch(() => { if (active) setCategories([]); });
        return () => { active = false; };
    }, [open, backendUrl]);

    useEffect(() => {
        if (open) {
            wasOpenRef.current = true;
            return;
        }
        if (!wasOpenRef.current) return;
        wasOpenRef.current = false;
        requestRef.current?.abort();
        requestRef.current = null;
        clearRoute();
        setBusy(false);
        setResults([]);
        setRouteSummary(null);
        setSelectedRouteIndex(null);
        setHasSearched(false);
        planCacheRef.current = null;
        onResults?.(null);
    }, [open]);

    useEffect(() => () => {
        requestRef.current?.abort();
        clearRoute();
    }, []);

    useEffect(() => {
        overlaysRef.current.forEach((overlay) => {
            if (typeof overlay?.setOptions === 'function' && overlay.CLASS_NAME === 'AMap.Polyline') {
                overlay.setOptions({ strokeColor: customThemeColor });
            }
        });
    }, [customThemeColor]);

    const visibleCategories = useMemo(() => {
        const normalizedQuery = categoryQuery.trim();
        if (!normalizedQuery) {
            return categories
                .filter((category) => category.is_common)
                .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
                .slice(0, 10);
        }
        return categories
            .map((category) => ({ category, score: getCategoryMatchScore(category.name, normalizedQuery) }))
            .filter((item) => Number.isFinite(item.score))
            .sort((left, right) => left.score - right.score || left.category.name.localeCompare(right.category.name, 'zh-CN'))
            .slice(0, 20)
            .map((item) => item.category);
    }, [categories, categoryQuery]);

    const closePanel = () => {
        wasOpenRef.current = false;
        requestRef.current?.abort();
        requestRef.current = null;
        clearRoute();
        setBusy(false);
        setResults([]);
        setRouteSummary(null);
        setSelectedRouteIndex(null);
        setHasSearched(false);
        planCacheRef.current = null;
        setError('');
        onResults?.(null);
        onClose?.();
    };

    const toggleCategory = (name) => {
        setSelectedCategories((current) => current.includes(name)
            ? current.filter((item) => item !== name)
            : [...current, name]);
    };

    const selectCategory = (name) => {
        toggleCategory(name);
        setCategoryQuery('');
    };

    const invalidatePlannedRoute = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        setBusy(false);
        planCacheRef.current = null;
        setSelectedRouteIndex(null);
        setRouteSummary(null);
        setHasSearched(false);
        setResults([]);
        setError('');
        clearRoute();
        onResults?.(null);
    };

    const filterAlongRoute = async (route, controller, { fitMap = true } = {}) => {
        setResults([]);
        setHasSearched(false);
        onResults?.([]);
        clearRoute();
        const plannedRoutes = planCacheRef.current?.routes || [route];
        overlaysRef.current = drawAmapRoutes(
            mapRef.current,
            plannedRoutes,
            customThemeColor,
            customThemeSecondary,
            fitMap ? (isNarrow ? [92, 24, 250, 24] : undefined) : false,
            route.index,
            handleMapRouteSelect
        );
        const response = await searchPlacesAlongRoute(backendUrl, {
            paths: [route.searchPath.map((point) => [point.lng, point.lat])],
            query,
            categories: selectedCategories,
            corridor_meters: corridorMeters,
            limit: 60
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;

        const nextResults = (Array.isArray(response.places) ? response.places : []).map((place) => ({
            ...place,
            route_matches: (place.route_matches || []).map((match) => ({
                ...match,
                route_index: route.index
            }))
        }));
        setResults(nextResults);
        setHasSearched(true);
        onResults?.(nextResults);
    };

    const handleChooseRoute = async (route) => {
        if (!route || busy || !mapRef.current) return;
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setSelectedRouteIndex(route.index);
        setBusy(true);
        setError('');
        setHasSearched(false);
        try {
            await filterAlongRoute(route, controller, { fitMap: false });
        } catch (chooseError) {
            if (chooseError?.name !== 'AbortError') {
                setError(chooseError?.message || t('map:alongRoute.chooseRouteFailed'));
                setResults([]);
                onResults?.([]);
            }
        } finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setBusy(false);
            }
        }
    };

    const handleMapRouteSelect = (routeIndex) => {
        if (requestRef.current) return;
        const route = planCacheRef.current?.routes?.find((item) => item.index === routeIndex);
        if (!route) return;
        handleChooseRoute(route);
    };

    const handleSubmit = async (event) => {
        event?.preventDefault();
        const normalizedUrl = shareUrl.trim();
        if (!normalizedUrl) {
            setError(t('map:alongRoute.pasteLinkFirst'));
            return;
        }
        if (!mapReady || !mapRef.current) {
            setError(t('map:alongRoute.mapNotReadyRetry'));
            return;
        }

        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setBusy(true);
        setError('');
        try {
            let effectiveTrip = trip;
            let effectiveMode = mode;
            if (!effectiveTrip || resolvedUrl !== normalizedUrl) {
                effectiveTrip = await resolveAmapShareRoute(backendUrl, normalizedUrl, { signal: controller.signal });
                effectiveMode = effectiveTrip.mode || 'driving';
                setTrip(effectiveTrip);
                setMode(effectiveMode);
                setResolvedUrl(normalizedUrl);
            }

            const planKey = JSON.stringify({
                url: normalizedUrl,
                mode: effectiveMode,
                origin: effectiveTrip.origin,
                destination: effectiveTrip.destination,
                waypoints: effectiveTrip.waypoints || []
            });
            let routes = planCacheRef.current?.key === planKey
                ? planCacheRef.current.routes
                : null;
            const isNewPlan = !routes;

            if (isNewPlan) {
                clearRoute();
                const planned = await planAmapRoutes({
                    origin: effectiveTrip.origin,
                    destination: effectiveTrip.destination,
                    waypoints: effectiveTrip.waypoints,
                    mode: effectiveMode
                });
                if (controller.signal.aborted) return;
                routes = planned.routes;
                planCacheRef.current = { key: planKey, routes };
                setRouteSummary({ routes });
                setResults([]);
                setHasSearched(false);
                onResults?.([]);

                if (routes.length > 1) {
                    setSelectedRouteIndex(null);
                    overlaysRef.current = drawAmapRoutes(
                        mapRef.current,
                        routes,
                        customThemeColor,
                        customThemeSecondary,
                        isNarrow ? [92, 24, 250, 24] : undefined,
                        null,
                        handleMapRouteSelect
                    );
                    return;
                }
                setSelectedRouteIndex(routes[0].index);
                await filterAlongRoute(routes[0], controller);
                return;
            }

            const selectedRoute = routes.find((route) => route.index === selectedRouteIndex);
            if (!selectedRoute) {
                setRouteSummary({ routes });
                overlaysRef.current = drawAmapRoutes(
                    mapRef.current,
                    routes,
                    customThemeColor,
                    customThemeSecondary,
                    isNarrow ? [92, 24, 250, 24] : undefined,
                    null,
                    handleMapRouteSelect
                );
                setError(t('map:alongRoute.chooseRouteFirst'));
                return;
            }
            await filterAlongRoute(selectedRoute, controller);
        } catch (submitError) {
            if (submitError?.name !== 'AbortError') {
                setError(submitError?.message || t('map:alongRoute.searchFailed'));
                setResults([]);
                onResults?.([]);
            }
        } finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setBusy(false);
            }
        }
    };

    // 关闭后保留同一个 MotionSurface 实例，退出动画结束前继续显示最后的内容
    if (!open) return <MotionSurface show={false} />;

    const fieldStyle = {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-bg-overlay)',
        color: 'var(--color-text-primary)',
        padding: '10px 11px',
        outline: 'none',
        fontSize: 14
    };
    const tripName = (point, fallback) => point?.name || fallback;
    const mobileRoutePreview = isNarrow && !!routeSummary;

    return (
        <MotionSurface
            show
            as="section"
            preset={isNarrow ? (mobileRoutePreview ? 'fade' : 'sheet') : (placement === 'right' ? 'side-right' : 'side-left')}
            overlay={{ onClose: closePanel, modal: isNarrow && !mobileRoutePreview, kind: 'along-route', label: t('map:alongRoute.title') }}
            aria-label={t('map:alongRoute.title')}
            role={isNarrow ? 'dialog' : 'region'}
            style={{
                position: isNarrow ? 'fixed' : 'absolute',
                ...(isNarrow
                    ? { inset: 0 }
                    : { [placement]: 12, top: 68, bottom: 42, width: 370 }),
                zIndex: isNarrow ? 6000 : 3600,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                border: isNarrow ? 0 : '1px solid var(--color-border)',
                borderRadius: isNarrow ? 0 : 'var(--radius-md)',
                background: mobileRoutePreview
                    ? 'transparent'
                    : (isNarrow ? 'var(--color-bg-surface)' : 'color-mix(in srgb, var(--color-bg-surface) 96%, transparent)'),
                color: 'var(--color-text-primary)',
                boxShadow: isNarrow ? 'none' : 'var(--shadow-surface)',
                backdropFilter: mobileRoutePreview || isNarrow ? 'none' : 'blur(12px)',
                pointerEvents: mobileRoutePreview ? 'none' : 'auto'
            }}
        >
            {getPlatform() === 'ios' && isNarrow && !mobileRoutePreview ? (
                <div style={{ paddingTop: 'var(--safe-top, env(safe-area-inset-top, 0px))', flexShrink: 0 }}>
                    <FullPageHeader title={t('map:alongRoute.title')} subtitle={t('map:alongRoute.subtitle')} onBack={closePanel} />
                </div>
            ) : <header style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                borderBottom: '1px solid var(--color-border)',
                ...(mobileRoutePreview ? {
                    margin: 'max(10px, env(safe-area-inset-top)) 10px 0', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
                    background: 'color-mix(in srgb, var(--color-bg-surface) 94%, transparent)',
                    boxShadow: 'var(--shadow-surface)', backdropFilter: 'blur(12px)', pointerEvents: 'auto'
                } : (isNarrow ? { paddingTop: 'calc(12px + env(safe-area-inset-top))' } : {}))
            }}>
                {mobileRoutePreview ? (
                    <Button
                        type="button"
                        onClick={invalidatePlannedRoute}
                        aria-label={t('map:alongRoute.backToConditions')}
                        style={{ border: 0, background: 'transparent', color: 'var(--color-text-primary)', padding: 4, lineHeight: 1 }}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
                    </Button>
                ) : (
                    <span className="material-symbols-outlined" style={{ color: customThemeColor, fontSize: 24 }}>route</span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ margin: 0, fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {mobileRoutePreview ? `${tripName(trip?.origin, t('map:alongRoute.origin'))} → ${tripName(trip?.destination, t('map:alongRoute.destination'))}` : t('map:alongRoute.title')}
                    </h2>
                    <div style={{ marginTop: 2, color: 'var(--color-text-secondary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {mobileRoutePreview ? t('map:alongRoute.compareHint') : t('map:alongRoute.subtitle')}
                    </div>
                </div>
                <Button type="button" onClick={closePanel} aria-label={t('map:alongRoute.closeLabel')} style={{ border: 0, background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 20, padding: '2px 7px' }}>×</Button>
            </header>}

            <ScrollableView style={mobileRoutePreview ? {
                position: 'absolute', left: 0, right: 0, bottom: 0,
                maxHeight: selectedRouteIndex == null ? '32%' : '44%',
                borderTop: '1px solid var(--color-border)',
                borderRadius: '18px 18px 0 0',
                background: 'var(--color-bg-surface)',
                boxShadow: '0 -8px 30px rgba(0,0,0,.16)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                pointerEvents: 'auto', overscrollBehavior: 'contain'
            } : { flex: 1 }}>
                {!mobileRoutePreview && <form onSubmit={handleSubmit} style={{ padding: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('map:alongRoute.shareLinkLabel')}</label>
                    <input
                        type="text"
                        value={shareUrl}
                        onChange={(event) => {
                            const nextValue = event.target.value;
                            setShareUrl(nextValue);
                            if (nextValue.trim() !== resolvedUrl) {
                                setTrip(null);
                                if (routeSummary || busy || planCacheRef.current) invalidatePlannedRoute();
                            }
                        }}
                        placeholder={t('map:alongRoute.shareLinkPlaceholder')}
                        autoComplete="off"
                        style={fieldStyle}
                    />
                    <div style={{ marginTop: 5, color: 'var(--color-text-muted)', fontSize: 11, lineHeight: 1.45 }}>
                        {t('map:alongRoute.privacyHint')}
                    </div>

                    {trip && (
                        <div style={{ marginTop: 10, padding: '9px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-overlay)', fontSize: 12, lineHeight: 1.55 }}>
                            <strong>{tripName(trip.origin, t('map:alongRoute.tripOrigin'))}</strong>
                            <span className="material-symbols-outlined" style={{ verticalAlign: 'middle', margin: '0 5px', fontSize: 16, color: customThemeColor }}>arrow_forward</span>
                            <strong>{tripName(trip.destination, t('map:alongRoute.tripDestination'))}</strong>
                            {trip.waypoints?.length > 0 && (
                                <span style={{ marginLeft: 6, color: 'var(--color-text-secondary)' }}>{tx('map:alongRoute.waypoints', { count: trip.waypoints.length })}</span>
                            )}
                        </div>
                    )}

                    <div style={{ marginTop: 13, fontSize: 12, fontWeight: 700 }}>{t('map:alongRoute.travelMode')}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 7 }}>
                        {MODE_OPTIONS.map((option) => {
                            const selected = mode === option.value;
                            return (
                                <Button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        if (option.value === mode) return;
                                        setMode(option.value);
                                        if (routeSummary || busy || planCacheRef.current) invalidatePlannedRoute();
                                    }}
                                    aria-pressed={selected}
                                    style={{
                                        padding: '7px 3px',
                                        minWidth: 0,
                                        borderRadius: 'var(--radius-sm)',
                                        border: `1px solid ${selected ? customThemeColor : 'var(--color-border)'}`,
                                        background: selected ? 'color-mix(in srgb, var(--theme-primary) 14%, var(--color-bg-surface))' : 'var(--color-bg-surface)',
                                        color: selected ? customThemeColor : 'var(--color-text-secondary)',
                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                                        fontSize: 11
                                    }}
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: 19 }}>{option.icon}</span>
                                    {option.label}
                                </Button>
                            );
                        })}
                    </div>

                    <label style={{ display: 'block', marginTop: 13, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('map:alongRoute.wantLabel')}</label>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('map:alongRoute.wantPlaceholder')}
                        style={fieldStyle}
                    />

                    {categories.length > 0 && (
                        <div style={{ marginTop: 13 }}>
                            <label htmlFor="along-route-category-search" style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('map:alongRoute.tagsLabel')}</label>
                            <div style={{
                                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
                                minHeight: 42, padding: '6px 10px', boxSizing: 'border-box',
                                border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                                background: 'var(--color-bg-overlay)'
                            }}>
                                {selectedCategories.map((name) => (
                                    <Button
                                        type="button"
                                        key={name}
                                        onClick={() => toggleCategory(name)}
                                        aria-label={t('map:alongRoute.deselectTag', { name })}
                                        aria-pressed="true"
                                        style={{
                                            borderRadius: 'var(--radius-full)', border: `1px solid ${customThemeColor}`,
                                            background: customThemeColor, color: '#fff', padding: '4px 8px', fontSize: 11
                                        }}
                                    >
                                        {name} ×
                                    </Button>
                                ))}
                                <span className="material-symbols-outlined" style={{ color: 'var(--color-text-muted)', fontSize: 18 }}>search</span>
                                <input
                                    id="along-route-category-search"
                                    type="search"
                                    value={categoryQuery}
                                    onChange={(event) => setCategoryQuery(event.target.value)}
                                    placeholder={t('map:alongRoute.tagSearchPlaceholder')}
                                    autoComplete="off"
                                    style={{
                                        flex: '1 1 120px', minWidth: 100, height: 28, padding: 0,
                                        border: 0, outline: 'none', background: 'transparent',
                                        color: 'var(--color-text-primary)', fontSize: 13
                                    }}
                                />
                            </div>
                            <div style={{ marginTop: 7, color: 'var(--color-text-secondary)', fontSize: 11, fontWeight: 600 }}>
                                {categoryQuery.trim() ? t('map:alongRoute.matchingTags') : t('map:alongRoute.frequentTags')}
                            </div>
                            {visibleCategories.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
                                {visibleCategories.map((category) => {
                                    const selected = selectedCategories.includes(category.name);
                                    return (
                                        <Button
                                            type="button"
                                            key={category.id || category.name}
                                            onClick={() => selectCategory(category.name)}
                                            aria-pressed={selected}
                                            style={{
                                                borderRadius: 'var(--radius-full)',
                                                border: `1px solid ${selected ? customThemeColor : 'var(--color-border)'}`,
                                                background: selected ? customThemeColor : 'var(--color-bg-surface)',
                                                color: selected ? '#fff' : 'var(--color-text-secondary)',
                                                padding: '5px 9px',
                                                fontSize: 11
                                            }}
                                        >
                                            {category.name}
                                        </Button>
                                    );
                                })}
                            </div>
                            ) : (
                                <div style={{ marginTop: 7, color: 'var(--color-text-muted)', fontSize: 12 }}>{t('map:alongRoute.noMatchingTags')}</div>
                            )}
                        </div>
                    )}

                    <label style={{ display: 'block', marginTop: 13, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t('map:alongRoute.maxDistance')}</label>
                    <select value={corridorMeters} onChange={(event) => setCorridorMeters(Number(event.target.value))} style={fieldStyle}>
                        <option value={500}>{t('map:alongRoute.distance500')}</option>
                        <option value={1000}>{t('map:alongRoute.distance1000')}</option>
                        <option value={2000}>{t('map:alongRoute.distance2000')}</option>
                        <option value={3000}>{t('map:alongRoute.distance3000')}</option>
                    </select>

                    {error && (
                        <div role="alert" style={{ marginTop: 10, padding: '9px 10px', borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--color-danger) 10%, var(--color-bg-surface))', color: 'var(--color-danger)', fontSize: 12, lineHeight: 1.45 }}>
                            {error}
                        </div>
                    )}

                    <Button
                        type="submit"
                        disabled={busy || !mapReady || (routeSummary?.routes?.length > 1 && selectedRouteIndex == null)}
                        style={{
                            width: '100%', marginTop: 13, padding: '10px 12px', border: 0,
                            borderRadius: 'var(--radius-sm)', background: customThemeColor, color: '#fff',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                            fontWeight: 700,
                            opacity: busy || !mapReady || (routeSummary?.routes?.length > 1 && selectedRouteIndex == null) ? 0.65 : 1
                        }}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{busy ? 'progress_activity' : 'restaurant'}</span>
                        {busy
                            ? t('map:alongRoute.searching')
                            : (hasSearched
                                ? t('map:alongRoute.refilter')
                                : (routeSummary?.routes?.length > 1 ? t('map:alongRoute.selectRouteBelow') : t('map:alongRoute.planAndSearch')))}
                    </Button>
                </form>}

                {routeSummary && (
                    <div style={{
                        padding: mobileRoutePreview ? '8px 14px 12px' : '11px 14px',
                        borderTop: mobileRoutePreview ? 0 : '1px solid var(--color-border)',
                        borderBottom: '1px solid var(--color-border)',
                        background: mobileRoutePreview ? 'var(--color-bg-surface)' : 'var(--color-bg-overlay)',
                        fontSize: 12
                    }}>
                        {mobileRoutePreview && <div aria-hidden="true" style={{ width: 38, height: 4, margin: '0 auto 9px', borderRadius: 4, background: 'var(--color-border)' }} />}
                        <strong>
                            {selectedRouteIndex == null
                                ? t('map:alongRoute.routesFound', { count: routeSummary.routes.length })
                                : (hasSearched ? t('map:alongRoute.resultsFound', { route: selectedRouteIndex + 1, count: results.length }) : t('map:alongRoute.filteringRoute', { route: selectedRouteIndex + 1 }))}
                        </strong>
                        <div className="yuyuko-custom-scrollbar" style={{
                            display: mobileRoutePreview ? 'flex' : 'grid', gap: 7, marginTop: 9,
                            overflowX: mobileRoutePreview ? 'auto' : 'visible', paddingBottom: mobileRoutePreview ? 3 : 0,
                            scrollbarWidth: 'thin'
                        }}>
                            {routeSummary.routes.map((route) => {
                                const selected = route.index === selectedRouteIndex;
                                return (
                                    <Button
                                        type="button"
                                        key={route.index}
                                        disabled={busy}
                                        onClick={() => handleChooseRoute(route)}
                                        aria-pressed={selected}
                                        style={{
                                            width: mobileRoutePreview ? 'min(70vw, 220px)' : '100%',
                                            flex: mobileRoutePreview ? '0 0 min(70vw, 220px)' : undefined,
                                            boxSizing: 'border-box', padding: mobileRoutePreview ? '10px 11px' : '8px 10px',
                                            border: `1px solid ${selected ? customThemeColor : 'var(--color-border)'}`,
                                            borderRadius: 'var(--radius-sm)',
                                            background: selected ? 'color-mix(in srgb, var(--theme-primary) 13%, var(--color-bg-surface))' : 'var(--color-bg-surface)',
                                            color: selected ? customThemeColor : 'var(--color-text-primary)',
                                            display: 'flex', alignItems: mobileRoutePreview ? 'flex-start' : 'center',
                                            flexDirection: mobileRoutePreview ? 'column' : 'row',
                                            justifyContent: 'space-between', gap: mobileRoutePreview ? 4 : 8,
                                            textAlign: 'left', fontSize: 11
                                        }}
                                    >
                                        <span style={{ fontWeight: 700, fontSize: mobileRoutePreview ? 14 : 11 }}>{tx('map:alongRoute.routeLabel', { route: route.index + 1 })}</span>
                                        <span style={{ color: selected ? customThemeColor : 'var(--color-text-secondary)' }}>
                                            {[formatDistance(route.distance), formatDuration(route.duration)].filter(Boolean).join(' · ') || t('map:alongRoute.viewRoute')}
                                        </span>
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {hasSearched && results.length === 0 && !busy && (
                    <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                        {t('map:alongRoute.empty')}
                    </div>
                )}

                {results.map((place, index) => (
                    <Button
                        type="button"
                        key={place.id}
                        onClick={() => onSelectPlace?.(place)}
                        style={{
                            width: '100%', boxSizing: 'border-box', border: 0, borderBottom: '1px solid var(--color-border)',
                            borderRadius: 0, background: 'transparent', color: 'var(--color-text-primary)',
                            padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left'
                        }}
                    >
                        <span style={{
                            width: 24, height: 24, flexShrink: 0, borderRadius: '50%', background: customThemeColor,
                            color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700
                        }}>{index + 1}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{place.name}</span>
                            <span style={{ display: 'block', marginTop: 3, color: 'var(--color-text-secondary)', fontSize: 11, lineHeight: 1.45 }}>
                                {[place.category, place.per_person_cost ? t('map:alongRoute.perPersonAbout', { per_person_cost: place.per_person_cost }) : '', t('map:alongRoute.distanceFromRoute', { distance: formatDistance(place.distance_to_route) })].filter(Boolean).join(' · ')}
                            </span>
                            <span style={{ display: 'block', marginTop: 2, color: 'var(--color-text-muted)', fontSize: 11 }}>
                                {(place.route_matches || []).map((match) => t('map:alongRoute.routeMatch', { route: match.route_index + 1, distance: formatDistance(match.distance_to_route) })).join(' · ') || t('map:alongRoute.onRoute')}
                            </span>
                        </span>
                        <span className="material-symbols-outlined" style={{ color: customThemeColor, fontSize: 20 }}>location_on</span>
                    </Button>
                ))}
            </ScrollableView>
        </MotionSurface>
    );
}
