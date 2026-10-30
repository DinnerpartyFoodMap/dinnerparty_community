// 顺路吃的业务编排：解析高德行程链接、规划路线、在网页地图上画线、查询沿途地点。
// 网页 AlongRoutePanel 与 iOS 原生面板（NativeAlongRoutePlugin.swift）共用这些底层能力；
// 原生会话只收条件、显示网页格式化好的结果，凭证与请求始终留在网页层。
import { resolveAmapShareRoute, searchPlacesAlongRoute } from '../api/client.js';
import { clearAmapRoute, drawAmapRoutes, planAmapRoutes } from './alongRoute.js';
import { t } from '../i18n/index.js';

export const ALONG_ROUTE_MODES = Object.freeze(['driving', 'transit', 'walking', 'riding']);
export const ALONG_ROUTE_CORRIDORS = Object.freeze([500, 1000, 2000, 3000]);

export function formatAlongRouteDistance(value) {
    const distance = Number(value);
    if (!Number.isFinite(distance)) return '';
    return distance >= 1000
        ? t('map:alongRoute.kilometers', { distance: (distance / 1000).toFixed(distance >= 10000 ? 0 : 1) })
        : t('map:alongRoute.meters', { distance: Math.round(distance) });
}

export function formatAlongRouteDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('map:alongRoute.aboutMinutes', { minutes });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return t('map:alongRoute.aboutHours', { hours, rest: rest ? t('map:alongRoute.hoursRestMinutes', { rest }) : '' });
}

// 文案键写成字面量，i18n 检查才能覆盖
const MODE_LABELS = {
    driving: () => t('map:alongRoute.mode.driving'),
    transit: () => t('map:alongRoute.mode.transit'),
    walking: () => t('map:alongRoute.mode.walking'),
    riding: () => t('map:alongRoute.mode.riding')
};
const DISTANCE_LABELS = {
    500: () => t('map:alongRoute.distance500'),
    1000: () => t('map:alongRoute.distance1000'),
    2000: () => t('map:alongRoute.distance2000'),
    3000: () => t('map:alongRoute.distance3000')
};

export function alongRouteModeOptions() {
    return ALONG_ROUTE_MODES.map((id) => ({ id, label: MODE_LABELS[id]() }));
}

export function alongRouteDistanceOptions() {
    return ALONG_ROUTE_CORRIDORS.map((value) => ({ value, label: DISTANCE_LABELS[value]() }));
}

export function formatAlongRouteTrip(trip) {
    if (!trip) return '';
    const origin = trip.origin?.name || t('map:alongRoute.tripOrigin');
    const destination = trip.destination?.name || t('map:alongRoute.tripDestination');
    const waypoints = trip.waypoints?.length ? t('map:alongRoute.waypoints', { count: trip.waypoints.length }) : '';
    return [origin + ' → ' + destination, waypoints].filter(Boolean).join(' ');
}

export function alongRouteRoutesState(routes, selectedIndex) {
    const items = (Array.isArray(routes) ? routes : []).map((route) => ({
        index: route.index,
        title: t('map:alongRoute.routeLabel', { route: route.index + 1 }),
        detail: [formatAlongRouteDistance(route.distance), formatAlongRouteDuration(route.duration)].filter(Boolean).join(' · ')
            || t('map:alongRoute.viewRoute')
    }));
    return {
        routes: items,
        routesTitle: selectedIndex == null
            ? t('map:alongRoute.routesFound', { count: items.length })
            : t('map:alongRoute.filteringRoute', { route: selectedIndex + 1 }),
        emptyText: '',
        submitTitle: selectedIndex == null && items.length > 1
            ? t('map:alongRoute.selectRouteBelow')
            : t('map:alongRoute.refilter')
    };
}

export function alongRoutePlacesState(routeIndex, places) {
    const items = (Array.isArray(places) ? places : []).map((place) => ({
        id: String(place.id),
        name: String(place.name || ''),
        meta: [
            place.category,
            place.per_person_cost ? t('map:alongRoute.perPersonAbout', { per_person_cost: place.per_person_cost }) : '',
            t('map:alongRoute.distanceFromRoute', { distance: formatAlongRouteDistance(place.distance_to_route) })
        ].filter(Boolean).join(' · '),
        matches: (place.route_matches || [])
            .map((match) => t('map:alongRoute.routeMatch', {
                route: Number(match.route_index) + 1,
                distance: formatAlongRouteDistance(match.distance_to_route)
            }))
            .join(' · ') || t('map:alongRoute.onRoute')
    }));
    return {
        selectedRouteIndex: routeIndex,
        routesTitle: t('map:alongRoute.resultsFound', { route: routeIndex + 1, count: items.length }),
        places: items,
        emptyText: items.length ? '' : t('map:alongRoute.empty'),
        submitTitle: t('map:alongRoute.refilter')
    };
}

/**
 * 一次顺路查询的状态机。每次 submit / choose 都会取消上一轮请求；
 * 关闭时 reset 取消请求、清掉地图上的路线与结果标记。
 */
export function createAlongRouteController({ mapRef, backendUrl, themeColor, themeSecondary, isNarrow, onResults }) {
    let request = null;
    let overlays = [];
    let trip = null;
    let resolvedUrl = '';
    let plan = null;
    let selectedRouteIndex = null;
    let routes = [];
    let places = [];

    const clearRoute = () => {
        clearAmapRoute(mapRef.current, overlays);
        overlays = [];
    };

    const draw = (list, selectedIndex, fit = true) => {
        clearRoute();
        overlays = drawAmapRoutes(
            mapRef.current,
            list,
            themeColor,
            themeSecondary,
            fit ? (isNarrow ? [92, 24, 250, 24] : undefined) : false,
            selectedIndex,
            null
        );
    };

    const begin = () => {
        request?.abort();
        const controller = new AbortController();
        request = controller;
        return controller;
    };

    const end = (controller) => {
        if (request === controller) request = null;
    };

    const filter = async (route, values, controller) => {
        draw(plan.routes, route.index, false);
        const response = await searchPlacesAlongRoute(backendUrl, {
            paths: [route.searchPath.map((point) => [point.lng, point.lat])],
            query: values.query,
            categories: values.categories,
            corridor_meters: values.corridorMeters,
            limit: 60
        }, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        const nextPlaces = (Array.isArray(response.places) ? response.places : []).map((place) => ({
            ...place,
            route_matches: (place.route_matches || []).map((match) => ({ ...match, route_index: route.index }))
        }));
        places = nextPlaces;
        selectedRouteIndex = route.index;
        onResults?.(nextPlaces);
        return { kind: 'places', state: alongRoutePlacesState(route.index, nextPlaces) };
    };

    async function submit(values) {
        const controller = begin();
        clearRoute();
        places = [];
        onResults?.([]);
        try {
            let effectiveMode = values.mode || 'driving';
            if (!trip || resolvedUrl !== values.url) {
                trip = await resolveAmapShareRoute(backendUrl, values.url, { signal: controller.signal });
                resolvedUrl = values.url;
                // 与网页面板一致：新链接先采用行程自带的出行方式，之后才用用户改选的
                effectiveMode = trip.mode || 'driving';
            }
            if (controller.signal.aborted) return null;
            const planKey = JSON.stringify({
                url: values.url,
                mode: effectiveMode,
                origin: trip.origin,
                destination: trip.destination,
                waypoints: trip.waypoints || []
            });
            let planned = plan?.key === planKey ? plan.routes : null;
            if (!planned) {
                const result = await planAmapRoutes({
                    origin: trip.origin,
                    destination: trip.destination,
                    waypoints: trip.waypoints,
                    mode: effectiveMode
                });
                if (controller.signal.aborted) return null;
                planned = result.routes;
                plan = { key: planKey, routes: planned };
            }
            routes = planned;
            if (routes.length > 1) {
                selectedRouteIndex = null;
                draw(routes, null);
                return { kind: 'routes', state: { ...alongRouteRoutesState(routes, null), trip: formatAlongRouteTrip(trip), mode: effectiveMode } };
            }
            selectedRouteIndex = routes[0].index;
            const filtered = await filter(routes[0], values, controller);
            return filtered ? { ...filtered, state: { ...filtered.state, trip: formatAlongRouteTrip(trip), mode: effectiveMode } } : null;
        } finally {
            end(controller);
        }
    }

    async function choose(index, values) {
        if (!plan || !routes.length) throw new Error(t('map:alongRoute.chooseRouteFirst'));
        const route = routes.find((item) => item.index === Number(index));
        if (!route) throw new Error(t('map:alongRoute.chooseRouteFirst'));
        const controller = begin();
        try {
            const filtered = await filter(route, values, controller);
            return filtered ? { ...filtered, state: { ...filtered.state, trip: formatAlongRouteTrip(trip) } } : null;
        } finally {
            end(controller);
        }
    }

    function reset() {
        request?.abort();
        request = null;
        clearRoute();
        trip = null;
        resolvedUrl = '';
        plan = null;
        selectedRouteIndex = null;
        routes = [];
        places = [];
        onResults?.(null);
    }

    return {
        submit,
        choose,
        reset,
        getPlace: (id) => places.find((place) => String(place.id) === String(id)) || null
    };
}
