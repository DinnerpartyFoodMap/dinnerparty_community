import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import * as MapUtils from "./utils";
import * as Api from "../api/client";
import { EMPTY_PLACE_FILTER, isPlaceFilterActive, matchesPlaceFilter, placeFilterFromAi } from "../places/placeFilter";
import { MarkerLayerController } from "./MarkerLayerController";
import { installPinchGuard } from "./pinchGuard";
import { OverseasTileLayer } from "./overseasTileLayer";
import { PlaceRangeCache, RequestGate } from "./cluster/placeCache";
import { expandBounds } from "./cluster/snapshot";
import { placeKey, isMappableCoordinate } from "./cluster/engine";
import { readViewBounds, getMapZoomRange, getMapSafeInsets, centerForScreenTarget } from "./viewport";
import MapUI from "./MapUI";
import { createLocationReporter } from "./locationReport";
import MotionSurface from "../components/overlay/MotionSurface";
import { useLayoutPolicy } from "../motion/MotionProvider";
import "./addingPin.css";
import FullScreenMapContent from "../components/layout/FullScreenMapContent";
const JourneyWorkspace = React.lazy(() => import("../journey/JourneyWorkspace"));
import { useMapFeedback } from "../journey/feedback";
import CommentPanel from "../places/components/CommentPanel";
import { useTips } from "../components/feedback/Tips";
import { useConfirm } from "../components/feedback/Confirm";
import Tooltip from "../components/primitives/Tooltip";
import Button from "../components/primitives/Button";
import useDarkMode from "../theme/useDarkMode";
import { applyThemeColors, resolveThemePrimary, resolveThemeSecondary, getSystemPrefersDark } from "../theme/theme";
import { loadAmap, retryAmap, subscribeAmap, getAmapState, describeAmapError } from "../platform/amapLoader";
import { getCurrentLocation, describeLocationError, isLocationAvailable, releaseLocationControl } from "../platform/geolocation";
import { getQueryParams, removeQueryParams, openExternal, shareParamValue } from "../platform/navigation";
import { onAppStateChange } from "../platform/lifecycle";
import { isNativePlatform, getPlatform } from "../platform/env";
import { amapNavigationLink } from "./amapNavigation";
import { getRuntimeConfig } from "../platform/runtimeConfig";
import { subscribeSkin } from "../skins/skinStore";
import { t } from "../i18n/index.js";
import { userReportPrefill } from "../feedback/feedbackTypes";

const DEFAULT_CENTER = MapUtils.DEFAULT_CENTER;
const DEFAULT_ZOOM = MapUtils.DEFAULT_ZOOM;
const { normalizeLngLat, readSavedMapView, shouldPersistMapView, MAP_VIEW_STORAGE_KEY, MAP_VIEW_SAVE_DEBOUNCE_MS, LOCATE_ME_MIN_ZOOM, canUseLocationInCurrentContext, getLocationErrorMessage } = MapUtils;
// 启动自动定位每个进程只做一次（地图页重新挂载时不再重复）
let autoLocateAttempted = false;
const PREFETCH_BOUNDS_RATIO = 1; // prefetch one viewport margin around the visible area

function boundsOfPlaces(list) {
    let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90, count = 0;
    for (const place of list || []) {
        const lng = Number(place?.longitude);
        const lat = Number(place?.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        count += 1;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }
    return count ? { minLng, minLat, maxLng, maxLat, count } : null;
}

export default function MapView({
    backendUrl,
    token,
    isAuthenticated,
    isAdmin,
    onRequireAuth,
    onOpenDinners,
    onOpenMine,
    onLogout,
    onOpenAdmin,
    onOpenPosterExport,
    onOpenFeedback,
    desktopHeaderMenu = null,
    randomFoodRequestId = 0,
    myPlacesRequestId = 0,
    onOpenPlaceList,
    onOpenProfile,
    onboardingRequestId = 0,
    exhibition = null,
    exhibitionOpen = false,
    onCloseExhibition,
    routeSearch = '',
    pickerMode = false,
    pickerContext = 'dinner',
    pickedPlaces = [],
    onPickPlace,
    onRemovePickedPlace,
    onPickerClose,
    pickerTitle = '',
    onPickPoint,
    initialCenter = null,
    mapPageActive = false
}) {
    const containerRef = useRef(null);
    const journeyRef = useRef(null);
    const feedback = useMapFeedback(backendUrl, isAuthenticated ? token : null);
    const feedbackRef = useRef(feedback);
    feedbackRef.current = feedback;
    const mapRef = useRef(null);
    const markerLayerRef = useRef(null);
    const overseasLayerRef = useRef(null);
    const placeCacheRef = useRef(null);
    if (!placeCacheRef.current) placeCacheRef.current = new PlaceRangeCache();
    const nearbyGateRef = useRef(null);
    if (!nearbyGateRef.current) nearbyGateRef.current = new RequestGate();
    const nearbyFailureRef = useRef(0);
    const userLocationMarkerRef = useRef(null);
    const locateAbortRef = useRef(null);
    const addModeRef = useRef(false);
    const saveViewTimerRef = useRef(null);
    const lastSavedViewRef = useRef(null);
    const [addingPos, setAddingPos] = useState(null);
    const [addingPrefill, setAddingPrefill] = useState(null);
    const [places, setPlaces] = useState([]);
    const [mapReady, setMapReady] = useState(false);
    useEffect(() => {
        markerLayerRef.current?.setNativeGlassVisible(mapPageActive || pickerMode);
    }, [mapPageActive, pickerMode, mapReady]);
    const [amapState, setAmapState] = useState(() => getAmapState());
    useEffect(() => subscribeAmap(setAmapState), []);
    const [addMode, setAddMode] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState(null);
    const [alongRouteResults, setAlongRouteResults] = useState(null);
    const [searching, setSearching] = useState(false);
    const [aiThinking, setAiThinking] = useState(false);
    const [aiRecommendations, setAiRecommendations] = useState([]);
    // 地图筛选（标签 / 人均，places/placeFilter.js）：手动打开筛选面板设置，或由 AI 搜索读出后主动设置（source = 'ai'）
    const [placeFilter, setPlaceFilterState] = useState(EMPTY_PLACE_FILTER);
    const [placeFilterSource, setPlaceFilterSource] = useState(null);
    const setPlaceFilter = useCallback((next, source = 'manual') => {
        setPlaceFilterState(next || EMPTY_PLACE_FILTER);
        setPlaceFilterSource(next && isPlaceFilterActive(next) ? source : null);
    }, []);
    const [searchResetKey, setSearchResetKey] = useState(0);
    const showTip = useTips();
    const confirm = useConfirm();
    const [locating, setLocating] = useState(false);
    const [locationError, setLocationError] = useState("");
    const [currentUser, setCurrentUser] = useState(null);
    const layout = useLayoutPolicy();
    // 最近一次定位到的位置（列表模式距离筛选的默认中心）
    const [locatedCenter, setLocatedCenter] = useState(null);
    // 列表模式自选距离中心：全屏地图选点（与修改地点位置同一个界面），选好后交给 resolve
    const [listCenterPicker, setListCenterPicker] = useState(null);
    // 展会地点：复用高德临时地点的标记与卡片（见 showExhibitionVenue）
    const [venuePlace, setVenuePlace] = useState(null);
    const { setUser: setAuthUser } = useAuth();
    const [fetchingUser, setFetchingUser] = useState(false);
    const [selectedPlace, setSelectedPlace] = useState(null);
    const [clusterMembers, setClusterMembers] = useState(null);
    const [commentOpen, setCommentOpen] = useState(false);
    const [commentsList, setCommentsList] = useState([]);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [commentMessage, setCommentMessage] = useState("");
    const [newComment, setNewComment] = useState("");
    const [commentSubmitting, setCommentSubmitting] = useState(false);
    const selectedPlaceRef = useRef(null);
    const manageOpenRef = useRef(false);
    const commentOpenRef = useRef(false);
    const prevPickerModeRef = useRef(pickerMode);
    // 选点器可以从指定位置打开（例如日记站点）；此时不改写地图首页记住的视野
    const initialCenterRef = useRef(initialCenter);
    const lastFetchedTokenRef = useRef(null);
    const hasToken = !!token;
    const authPending = hasToken && !isAuthenticated;
    // disallow write actions for banned users
    const isBanned = !!(currentUser && currentUser.is_banned);
    const canWrite = hasToken && isAuthenticated && !isBanned;

    const [manageOpen, setManageOpen] = useState(false);
    const [managePositionOpen, setManagePositionOpen] = useState(false);
    const [manageEdit, setManageEdit] = useState({ name: "", category: "", description: "", per_person_cost: null });
    const [manageSubmitting, setManageSubmitting] = useState(false);
    const [manageMessage, setManageMessage] = useState("");

    const [favoriteIds, setFavoriteIds] = useState(new Set());
    const [favoriteLoading, setFavoriteLoading] = useState(false);

    const searchResultsRef = useRef(null);
    useEffect(() => { searchResultsRef.current = searchResults; }, [searchResults]);
    const alongRouteResultsRef = useRef(null);
    useEffect(() => { alongRouteResultsRef.current = alongRouteResults; }, [alongRouteResults]);
    // 按住民筛选（地点卡片点“最近修改”的名字）：地图只显示这位住民创建的地点。状态的字段见 userPlaces.js；
    // 与搜索、沿途互斥：任何一方接管标记时退出筛选。ref 同步更新，地图移动事件可能早于 effect
    const [userFilter, setUserFilter] = useState(null);
    const userFilterRef = useRef(null);
    const userFilterRequestRef = useRef(0);
    const refreshUserFilterRef = useRef(null);
    const commitUserFilter = (next) => {
        userFilterRef.current = next;
        setUserFilter(next);
    };
    const searchTermRef = useRef(searchTerm);
    useEffect(() => { searchTermRef.current = searchTerm; }, [searchTerm]);
    const searchingRef = useRef(searching);
    useEffect(() => { searchingRef.current = searching; }, [searching]);
    const searchServerRef = useRef(null);
    const searchRequestIdRef = useRef(0);
    const searchAbortControllersRef = useRef([]);
    const skipNextSearchRef = useRef(false);
    const skipSearchTimerRef = useRef(null);
    useEffect(() => () => {
        searchAbortControllersRef.current.forEach((controller) => controller.abort());
    }, []);
    useEffect(() => { manageOpenRef.current = manageOpen; }, [manageOpen]);
    useEffect(() => { commentOpenRef.current = commentOpen; }, [commentOpen]);
    const loadPlacesRef = useRef(null);
    const refreshNearbyRef = useRef(null);
    const placesRef = useRef([]);
    const markerHandlersRef = useRef({});

    const clearSearchState = ({ resetTerm = true, closeSearchUi = true, reloadPlaces = true } = {}) => {
        searchRequestIdRef.current += 1;
        searchAbortControllersRef.current.forEach((controller) => controller.abort());
        searchAbortControllersRef.current = [];
        if (resetTerm) setSearchTerm("");
        setSearchResults(null);
        setSearching(false);
        setAiThinking(false);
        setAiRecommendations([]);
        if (closeSearchUi) setSearchResetKey((v) => v + 1);
        if (reloadPlaces && loadPlacesRef.current) {
            return loadPlacesRef.current(true);
        }
        return null;
    };

    const handleSearchTermChange = (value) => {
        if (value !== searchTermRef.current) {
            searchRequestIdRef.current += 1;
            searchAbortControllersRef.current.forEach((controller) => controller.abort());
            searchAbortControllersRef.current = [];
            setSearchResults(null);
            setSearching(false);
            setAiThinking(false);
            setAiRecommendations([]);
        }
        setSearchTerm(value);
    };

    const armSkipAutoSearch = (durationMs = 900) => {
        skipNextSearchRef.current = true;
        if (skipSearchTimerRef.current) {
            window.clearTimeout(skipSearchTimerRef.current);
        }
        skipSearchTimerRef.current = window.setTimeout(() => {
            skipNextSearchRef.current = false;
            skipSearchTimerRef.current = null;
        }, durationMs);
    };

    const [customThemeColor, setCustomThemeColor] = useState(() => resolveThemePrimary(null));
    const [customThemeSecondary, setCustomThemeSecondary] = useState(() => resolveThemeSecondary(null));

    const applyEffectiveTheme = (mapSettings) => {
        const primary = resolveThemePrimary(mapSettings);
        const secondary = resolveThemeSecondary(mapSettings);
        setCustomThemeColor(primary);
        setCustomThemeSecondary(secondary);
        try { applyThemeColors(primary, secondary); } catch (e) { }
    };

    useEffect(() => {
        try {
            let ms = null;
            if (currentUser && currentUser.map_settings) {
                ms = currentUser.map_settings;
            }
            if (!ms || !ms.theme_color) {
                try {
                    const raw = window.localStorage.getItem('map_settings');
                    if (raw) ms = JSON.parse(raw);
                } catch (e) { }
            }
            applyEffectiveTheme(ms);
        } catch (e) { }
    }, [currentUser]);

    useEffect(() => {
        const onThemeChange = (e) => {
            try {
                const detail = (e && e.detail) ? e.detail : null;
                if (detail) {
                    if (typeof detail.color !== 'undefined') {
                        setCustomThemeColor(detail.color || resolveThemePrimary(null));
                    }
                    if (typeof detail.secondary !== 'undefined') {
                        setCustomThemeSecondary(detail.secondary || resolveThemeSecondary(null));
                    }
                    // Dark mode toggled — re-resolve defaults if user hasn't customized
                    if (typeof detail.dark !== 'undefined') {
                        let ms = null;
                        try {
                            const raw = window.localStorage.getItem('map_settings');
                            if (raw) ms = JSON.parse(raw);
                        } catch (ex) { }
                        if (!ms || !ms.theme_color) {
                            setCustomThemeColor(resolveThemePrimary(ms));
                        }
                        if (!ms || !ms.theme_color_secondary) {
                            setCustomThemeSecondary(resolveThemeSecondary(ms));
                        }
                    }
                }
            } catch (err) { }
        };
        window.addEventListener('themechange', onThemeChange);
        return () => window.removeEventListener('themechange', onThemeChange);
    }, []);

    // 换皮肤：标记图跟着换（只重画外观，不重建标记）
    useEffect(() => subscribeSkin(() => markerLayerRef.current?.refreshAppearance()), []);

    // Helper: try multiple AMap APIs to set a map style string (robust across versions)
    const trySetAmapStyle = (map, styleStr) => {
        if (!map) return false;
        try {
            if (typeof map.setMapStyle === 'function') {
                try { map.setMapStyle(styleStr); return true; } catch (e) { /* ignore */ }
                try { map.setMapStyle({ style: styleStr }); return true; } catch (e) { /* ignore */ }
            }
            if (typeof map.setStyle === 'function') {
                try { map.setStyle(styleStr); return true; } catch (e) { /* ignore */ }
            }
            if (typeof map.setOptions === 'function') {
                try { map.setOptions({ mapStyle: styleStr }); return true; } catch (e) { /* ignore */ }
                try { map.setOptions({ style: styleStr }); return true; } catch (e) { /* ignore */ }
            }
        } catch (e) {
            // ignore
        }
        return false;
    };

    // 更丰富的样式候选（按优先级），可以替换成你在高德控制台看到的样式 id
    const AMAP_STYLE_CANDIDATES_DARK = [
        'amap://styles/dark',
        'amap://styles/darkblue',
        'amap://styles/grey',
        'amap://styles/night'
    ];

    const AMAP_STYLE_CANDIDATES_LIGHT = [
        'amap://styles/light',
        'amap://styles/normal',
        'amap://styles/night',
        'amap://styles/default'
    ];

    const trySetAnyAmapStyle = (map, candidates) => {
        if (!map || !Array.isArray(candidates)) return null;
        for (const s of candidates) {
            try {
                if (trySetAmapStyle(map, s)) return s;
            } catch (e) {
                // ignore and try next
            }
        }
        return null;
    };

    // 高德 SDK 异步拉取样式数据且不丢弃过期响应：两次 setMapStyle 的请求重叠时，后返回的那份生效。
    // 冷启动时地图可能先以亮色创建、随后才切到暗色（主题来自系统或服务器），两份响应的先后不定，
    // 地图就可能停在亮色。这里记录本轮发出的请求数，样式加载事件平息后若有过重叠，就再补发一次目标样式。
    // （iOS 上样式完全不生效是 SDK 退回了非 WebGL 渲染，见 platform/amapLoader.js 的 shouldForceAmapWebGL。）
    const styleSyncRef = useRef({ want: null, sent: 0, timer: null });

    const requestMapStyle = (map, candidates, force = false) => {
        const sync = styleSyncRef.current;
        if (!map || !Array.isArray(candidates) || candidates.length === 0) return;
        if (!force && candidates[0] === sync.want) return;
        const applied = trySetAnyAmapStyle(map, candidates);
        if (!applied) return;
        sync.want = applied;
        sync.sent += 1;
    };

    const handleStyleSettled = () => {
        const sync = styleSyncRef.current;
        if (sync.timer) window.clearTimeout(sync.timer);
        sync.timer = window.setTimeout(() => {
            sync.timer = null;
            const overlapped = sync.sent > 1;
            sync.sent = 0;
            if (overlapped && mapRef.current && sync.want) requestMapStyle(mapRef.current, [sync.want], true);
        }, 300);
    };

    // 从用户设置或 localStorage 中读取首选样式：优先返回主题专属配置，再回退到通用 map_style
    // 用户未登录时（currentUser === null）会回退到 localStorage 或默认样式
    const getPreferredCandidates = (isDark) => {
        try {
            const base = isDark ? AMAP_STYLE_CANDIDATES_DARK : AMAP_STYLE_CANDIDATES_LIGHT;
            // 旧版本会把最后选择的样式同时写入通用 map_style（不区分明暗），老账号里可能仍是 normal 等亮色样式；
            // 只有它属于当前明暗模式的样式组时才采用，否则暗色界面会配上亮色地图。
            const pickStyle = (ms) => {
                if (!ms) return null;
                const themed = ms[isDark ? 'map_style_dark' : 'map_style_light'];
                if (themed) return themed;
                return ms.map_style && base.includes(ms.map_style) ? ms.map_style : null;
            };

            // 首先尝试用户登录后的设置（currentUser.map_settings）
            let userStyle = currentUser ? pickStyle(currentUser.map_settings) : null;

            // 回退到 localStorage 中的设置（本地保存）
            if (!userStyle) {
                try {
                    const raw = window.localStorage.getItem('map_settings');
                    if (raw) userStyle = pickStyle(JSON.parse(raw));
                } catch (e) { /* ignore */ }
            }

            // 使用默认样式列表，如果用户有自定义样式则优先使用
            if (userStyle) return [userStyle].concat(base.filter(s => s !== userStyle));
            return base;
        } catch (e) {
            // 异常时返回默认样式列表
            return isDark ? AMAP_STYLE_CANDIDATES_DARK : AMAP_STYLE_CANDIDATES_LIGHT;
        }
    };

    const dark = useDarkMode();

    const tipText = mapReady ? t('map:main.addTooltip.ready') : t('map:main.mapNotReady');
    const locationTipText = !mapReady
        ? t('map:main.mapNotReady')
        : (locationError || (isLocationAvailable()
            ? t('map:main.locateTooltip')
            : t('map:main.locateInsecure')));
    const addPlaceTipText = !mapReady
        ? t('map:main.mapNotReady')
        : authPending
            ? t('map:main.authPending')
            : isBanned
                ? t('map:main.addTooltip.banned')
                : canWrite
                    ? (addMode ? t('map:main.addTooltip.cancel') : t('map:main.addTooltip.start'))
                    : t('map:main.addTooltip.loginRequired');

    // 添加地点：在选中的位置放一个标记。窄屏表单先只露出下方三分之一，把这个位置移到上方露出的地图中间
    useEffect(() => {
        const map = mapRef.current;
        if (!mapReady || !map || !window.AMap || !addingPos || pickerMode) return undefined;
        const pin = document.createElement('div');
        pin.className = 'fm-adding-pin';
        pin.setAttribute('aria-hidden', 'true');
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = 'location_on';
        pin.append(icon);
        const marker = new window.AMap.Marker({ position: addingPos, content: pin, anchor: 'bottom-center', bubble: true, zIndex: 3100 });
        marker.setMap(map);
        if (layout.sheet) {
            try {
                const pixel = map.lngLatToContainer(new window.AMap.LngLat(addingPos[0], addingPos[1]));
                const size = map.getSize();
                const height = size && typeof size.getHeight === 'function' ? size.getHeight() : (containerRef.current?.clientHeight || window.innerHeight);
                map.panTo(map.containerToLngLat(new window.AMap.Pixel(pixel.x, pixel.y + height / 6)));
            } catch (error) { /* 尽力而为 */ }
        }
        return () => marker.setMap(null);
    }, [mapReady, addingPos, pickerMode]);

    // 同步 ref，以便地图上的 click handler 总能读取到最新的 addMode
    useEffect(() => {
        addModeRef.current = addMode;
        if (containerRef.current) {
            containerRef.current.style.cursor = addMode ? "crosshair" : "";
        }
    }, [addMode]);

    useEffect(() => {
        if (canWrite) return;
        if (addMode) setAddMode(false);
        if (addingPos) setAddingPos(null);
    }, [canWrite, addMode, addingPos]);

    useEffect(() => {
        if (pickerMode && !prevPickerModeRef.current) {
            clearSearchState();
        }
        prevPickerModeRef.current = pickerMode;
    }, [pickerMode]);

    // Load favorites when user authenticates; clear when logged out
    useEffect(() => {
        if (!token || !isAuthenticated) {
            setFavoriteIds(new Set());
            return;
        }
        let active = true;
        (async () => {
            try {
                const rows = await Api.fetchFavorites(backendUrl, token);
                if (active) {
                    const ids = new Set((rows || []).map(r => r.place_id));
                    setFavoriteIds(ids);
                }
            } catch (e) {
                console.warn('加载收藏列表失败', e);
            }
        })();
        return () => { active = false; };
    }, [token, isAuthenticated, backendUrl]);

    // 当 token 可用时尝试获取当前用户（用于判断是否有 admin 权限 / id）
    useEffect(() => {
        let active = true;
        if (!token) {
            setCurrentUser(null);
            lastFetchedTokenRef.current = null;
            return;
        }
        // If we've already fetched for this token, skip
        if (lastFetchedTokenRef.current === token) return;
        (async () => {
            setFetchingUser(true);
            try {
                const user = await Api.fetchCurrentUser(backendUrl, token);
                if (active && user) {
                    setCurrentUser(user);
                    try {
                        if (typeof setAuthUser === 'function') setAuthUser(user);
                    } catch (err) {
                        // ignore
                    }
                    lastFetchedTokenRef.current = token;
                } else {
                    lastFetchedTokenRef.current = null;
                }
            } catch (e) {
                console.warn("获取当前用户失败", e);
                lastFetchedTokenRef.current = null;
            } finally {
                setFetchingUser(false);
            }
        })();
        return () => { active = false; };
    }, [token, backendUrl]);

    useEffect(() => {
        let handleMapClick = null;
        let handleViewChange = null;
        let handlePageHide = null;
        let handleVisibilityChange = null;
        let handleResize = null;
        let handleMapStyleChange = null;
        let resizeObserver = null;
        let releasePinchGuard = null;
        let loadTimer = null;

        const getCurrentMapView = () => {
            if (!mapRef.current) return null;
            const center = MapUtils.normalizeLngLat(mapRef.current.getCenter());
            if (!center) return null;
            const zoomRaw = Number(mapRef.current.getZoom());
            const zoom = Number.isFinite(zoomRaw) ? zoomRaw : DEFAULT_ZOOM;
            return {
                lng: Number(center.lng.toFixed(6)),
                lat: Number(center.lat.toFixed(6)),
                zoom: Number(zoom.toFixed(2))
            };
        };

        const persistCurrentMapView = (force = false) => {
            if (initialCenterRef.current) return;
            const currentView = getCurrentMapView();
            if (!currentView) return;
            if (!force && !MapUtils.shouldPersistMapView(lastSavedViewRef.current, currentView)) return;
            try {
                window.localStorage.setItem(MapUtils.MAP_VIEW_STORAGE_KEY, JSON.stringify(currentView));
                lastSavedViewRef.current = currentView;
            } catch (e) {
                console.warn("保存上次地图视野失败", e);
            }
        };

        const schedulePersistMapView = () => {
            if (saveViewTimerRef.current) {
                window.clearTimeout(saveViewTimerRef.current);
            }
            saveViewTimerRef.current = window.setTimeout(() => {
                saveViewTimerRef.current = null;
                persistCurrentMapView(false);
            }, MapUtils.MAP_VIEW_SAVE_DEBOUNCE_MS);
        };

        // 在地图初始化时绑定事件
        const init = () => {
            if (!containerRef.current) return;
            const start = initialCenterRef.current;
            const savedView = start ? { lng: start.lng, lat: start.lat, zoom: 16 } : MapUtils.readSavedMapView();

            // 判断是否使用深色模式，与 App 的判定顺序一致（App 的 effect 可能还没执行）：
            // 1. document 的 data-theme 属性
            // 2. localStorage 中 map_settings.dark_mode
            // 3. 跟随系统
            // 判断错了地图会先以亮色创建再切换，正是上面样式请求竞争的来源。
            let pageDark = (typeof document !== 'undefined' && document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark');
            if (!pageDark) {
                let explicit;
                try {
                    const raw = window.localStorage.getItem('map_settings');
                    if (raw) {
                        const ms = JSON.parse(raw);
                        if (ms && typeof ms.dark_mode !== 'undefined') explicit = !!ms.dark_mode;
                    }
                } catch (e) { /* ignore */ }
                pageDark = typeof explicit === 'boolean' ? explicit : getSystemPrefersDark();
            }

            const preferredStyles = getPreferredCandidates(pageDark);

            mapRef.current = new AMap.Map(containerRef.current, {
                resizeEnable: true,
                center: savedView ? [savedView.lng, savedView.lat] : DEFAULT_CENTER,
                zoom: savedView ? savedView.zoom : DEFAULT_ZOOM,
                mapStyle: preferredStyles.length > 0 ? preferredStyles[0] : undefined
            });
            lastSavedViewRef.current = savedView;
            styleSyncRef.current = { want: preferredStyles[0] || null, sent: preferredStyles.length > 0 ? 1 : 0, timer: null };
            mapRef.current.on('styleChanged', handleStyleSettled);

            // 标记层：图标、名称、数量同根渲染；点击回调经 ref 读取最新闭包
            markerLayerRef.current = new MarkerLayerController(mapRef.current, {
                nativeGlassVisible: mapPageActive || pickerMode,
                onPlaceClick: (place, node) => markerHandlersRef.current.onPlaceClick?.(place, node),
                onClusterClick: (node, engine) => markerHandlersRef.current.onClusterClick?.(node, engine)
            });
            // 双指缩放有一指先抬起时，剩下那根手指的移动不交给高德（否则地图会突然漂走，见 pinchGuard.js）
            releasePinchGuard = installPinchGuard(mapRef.current.getContainer?.() || containerRef.current);
            // 境外放大后高德没有数据，叠加 CARTO 海外底图；连不上时保持纯高德
            overseasLayerRef.current = new OverseasTileLayer(mapRef.current, { apiKey: getRuntimeConfig().cartoApiKey, dark: pageDark });

            mapRef.current.on('complete', () => {
                // 地图加载完全后再次确保由于bounds已准备好，加载附近数据
                if (loadPlacesRef.current) {
                    loadPlacesRef.current(false);
                }
            });

            handleMapClick = (e) => {
                if (addModeRef.current) {
                    const { lng, lat } = e.lnglat;
                    // 世界地图上下（或左右）边界外的空白处也能点出坐标，但那里的标记无法显示
                    if (!isMappableCoordinate(lng, lat)) {
                        showTip(t('map:main.addOutsideMap'));
                        return;
                    }
                    setAddingPos([lng, lat]);
                    return;
                }
                if (manageOpenRef.current || commentOpenRef.current) return;
                if (!selectedPlaceRef.current) return;
                if (e && e.target && mapRef.current && e.target !== mapRef.current) return;
                closePopup();
            };
            handleViewChange = () => {
                schedulePersistMapView();
                // 每次移动或缩放结束时，增加适当防抖加载数据
                if (loadTimer) {
                    window.clearTimeout(loadTimer);
                }
                loadTimer = window.setTimeout(() => {
                    loadTimer = null;
                    if (loadPlacesRef.current) {
                        loadPlacesRef.current(false);
                    }
                }, 300);

            };
            handlePageHide = () => {
                persistCurrentMapView(true);
            };
            handleVisibilityChange = () => {
                if (document.visibilityState === "hidden") {
                    persistCurrentMapView(true);
                }
            };

            handleResize = () => {
                if (mapRef.current && typeof mapRef.current.resize === "function") {
                    mapRef.current.resize();
                }
            };

            mapRef.current.on("click", handleMapClick);
            mapRef.current.on("moveend", handleViewChange);
            mapRef.current.on("zoomend", handleViewChange);
            window.addEventListener("resize", handleResize);
            if (containerRef.current && typeof ResizeObserver !== "undefined") {
                resizeObserver = new ResizeObserver(() => {
                    handleResize();
                });
                resizeObserver.observe(containerRef.current);
            }

            window.addEventListener("pagehide", handlePageHide);
            document.addEventListener("visibilitychange", handleVisibilityChange);

            // listen for explicit map style changes from settings UI
            handleMapStyleChange = (e) => {
                try {
                    if (!mapRef.current) return;
                    const detail = (e && e.detail) ? e.detail : null;
                    const pageDark = (typeof document !== 'undefined' && document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark');
                    const preferred = getPreferredCandidates(pageDark);
                    if (detail) {
                        const want = (pageDark ? (detail.map_style_dark || null) : (detail.map_style_light || null)) || detail.map_style || null;
                        const candidates = want ? [want].concat(preferred.filter(s => s !== want)) : preferred;
                        requestMapStyle(mapRef.current, candidates);
                    } else {
                        requestMapStyle(mapRef.current, preferred);
                    }
                } catch (e) { /* ignore */ }
            };
            document.addEventListener('mapstylechange', handleMapStyleChange);

            setMapReady(true);
            loadPlaces();
        };

        // SDK 由 platform/amapLoader 统一加载；失败时页面显示重试入口，重试成功后在此继续初始化。
        let disposed = false;
        let stopAmapWatch = null;
        const initWhenReady = () => {
            if (disposed || mapRef.current) return;
            init();
        };
        if (window.AMap) initWhenReady();
        else {
            loadAmap().then(initWhenReady).catch(() => { /* 状态由 subscribeAmap 呈现 */ });
            stopAmapWatch = subscribeAmap((next) => {
                if (next.status === 'ready') initWhenReady();
            });
        }

        // 从后台恢复：容器尺寸可能已变化（横竖屏、键盘），重新计算并刷新附近数据
        const stopLifecycle = onAppStateChange(({ active, backgroundMs }) => {
            if (!active || !mapRef.current) return;
            if (handleResize) handleResize();
            if (backgroundMs > 60000) {
                placeCacheRef.current.invalidate();
                if (loadPlacesRef.current) loadPlacesRef.current(false);
            }
        });

        return () => {
            disposed = true;
            if (stopAmapWatch) stopAmapWatch();
            stopLifecycle();
            persistCurrentMapView(true);
            if (saveViewTimerRef.current) {
                window.clearTimeout(saveViewTimerRef.current);
                saveViewTimerRef.current = null;
            }
            if (loadTimer) {
                window.clearTimeout(loadTimer);
                loadTimer = null;
            }
            if (skipSearchTimerRef.current) {
                window.clearTimeout(skipSearchTimerRef.current);
                skipSearchTimerRef.current = null;
            }
            if (styleSyncRef.current.timer) {
                window.clearTimeout(styleSyncRef.current.timer);
                styleSyncRef.current.timer = null;
            }
            if (mapRef.current) {
                mapRef.current.off('styleChanged', handleStyleSettled);
                if (handleMapClick) mapRef.current.off("click", handleMapClick);
                if (handleViewChange) {
                    mapRef.current.off("moveend", handleViewChange);
                    mapRef.current.off("zoomend", handleViewChange);
                }
            }
            nearbyGateRef.current.invalidate();
            if (markerLayerRef.current) {
                markerLayerRef.current.destroy();
                markerLayerRef.current = null;
            }
            if (overseasLayerRef.current) {
                overseasLayerRef.current.destroy();
                overseasLayerRef.current = null;
            }
            if (handlePageHide) window.removeEventListener("pagehide", handlePageHide);
            if (handleVisibilityChange) {
                document.removeEventListener("visibilitychange", handleVisibilityChange);
            }
            if (handleResize) window.removeEventListener("resize", handleResize);
            if (resizeObserver) resizeObserver.disconnect();
            if (releasePinchGuard) releasePinchGuard();
            try { document.removeEventListener('mapstylechange', handleMapStyleChange); } catch (e) { }
            if (userLocationMarkerRef.current) {
                userLocationMarkerRef.current.setMap(null);
                userLocationMarkerRef.current = null;
            }
            locateAbortRef.current?.abort();
            releaseLocationControl(mapRef.current);
            if (mapRef.current && typeof mapRef.current.destroy === 'function') {
                try {
                    mapRef.current.destroy();
                } catch (e) {
                    console.warn('销毁地图实例失败', e);
                }
            }
            mapRef.current = null;
        };
    }, []);

    // 明暗模式或用户设置（currentUser.map_settings）变化时切换地图样式（不重建地图）。
    // 不必等 complete 事件：地图创建后即可 setMapStyle，样式没变时 requestMapStyle 不会重复请求。
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        try {
            requestMapStyle(mapRef.current, getPreferredCandidates(dark));
        } catch (e) {
            console.warn('更新地图样式失败', e);
        }
        overseasLayerRef.current?.setDark(dark);
    }, [dark, currentUser, mapReady]);

    // 附近地点：范围缓存 + 请求闸门。缓存覆盖内平移只重新查询可见节点；接近覆盖边界或过期时后台请求，
    // 请求期间继续显示缓存。旧请求被取消，且序号校验保证即使取消失败，旧响应也不能覆盖新视野或新模式。
    // force：即使处于搜索/沿途模式也加载（退出这些模式时调用）；需要绕过缓存时先 invalidate（见 refreshNearby）。
    // 请求回调只提交数据；显示哪份数据由当前模式决定，标记由统一入口渲染。
    const publishNearbyFromCache = () => {
        const all = placeCacheRef.current.all();
        placesRef.current = all;
        setPlaces(all);
    };

    const loadPlaces = async (force = false) => {
        if (!mapRef.current) return;
        if (!force && (searchResultsRef.current !== null || alongRouteResultsRef.current !== null || userFilterRef.current !== null)) return;
        const view = readViewBounds(mapRef.current);
        if (!view || !(view.maxLng > view.minLng) || !(view.maxLat > view.minLat)) return;
        const cache = placeCacheRef.current;
        const status = cache.coverage(view);
        if (status.covered) publishNearbyFromCache();
        if (status.covered && status.fresh && !status.nearEdge) return;

        const target = expandBounds(view, PREFETCH_BOUNDS_RATIO);
        const gate = nearbyGateRef.current;
        const ticket = gate.begin();
        try {
            const data = await Api.fetchPlacesNearby(backendUrl, target, { signal: ticket.signal, token });
            if (!gate.isCurrent(ticket)) return;
            nearbyFailureRef.current = 0;
            const changed = cache.apply(target, data);
            if (changed || !status.covered) publishNearbyFromCache();
        } catch (e) {
            if (e?.name === 'AbortError' || !gate.isCurrent(ticket)) return;
            console.error("加载地点失败", e);
            // 失败时保留最后成功的数据，并提示一次（连续失败不重复打扰）
            nearbyFailureRef.current += 1;
            if (nearbyFailureRef.current === 1) showTip(t('map:main.nearbyLoadFailed'));
        }
    };
    loadPlacesRef.current = loadPlaces;

    const refreshNearby = () => {
        placeCacheRef.current.invalidate();
        return loadPlaces(true);
    };
    refreshNearbyRef.current = refreshNearby;

    // 登录 / 退出后：附近地点里“自己新增、还在审核中的地点”随身份变化，缓存作废后重新加载
    const nearbyTokenRef = useRef(token);
    useEffect(() => {
        if (nearbyTokenRef.current === token) return;
        nearbyTokenRef.current = token;
        placeCacheRef.current.invalidate();
        loadPlacesRef.current?.(false);
        refreshUserFilterRef.current?.();
    }, [token]);

    // Toggle favorite for a place
    const handleToggleFavorite = async (place) => {
        if (!place || place.isMarked === false) return;
        if (!token || !isAuthenticated) {
            showTip(t('map:main.loginToFavorite'));
            onRequireAuth && onRequireAuth();
            return;
        }
        if (isBanned) {
            showTip(t('map:main.favoriteBanned'));
            return;
        }
        const placeId = place.id;
        const isFav = favoriteIds.has(placeId);
        // Optimistic update
        setFavoriteIds(prev => {
            const next = new Set(prev);
            if (isFav) next.delete(placeId);
            else next.add(placeId);
            return next;
        });
        setFavoriteLoading(true);
        try {
            if (isFav) {
                await Api.removeFavorite(backendUrl, token, placeId);
            } else {
                await Api.addFavorite(backendUrl, token, placeId);
            }
        } catch (e) {
            // Rollback on error
            setFavoriteIds(prev => {
                const next = new Set(prev);
                if (isFav) next.add(placeId);
                else next.delete(placeId);
                return next;
            });
            showTip((isFav ? t('map:main.unfavoriteFailed') : t('map:main.favoriteFailed')) + (e.message || e));
        } finally {
            setFavoriteLoading(false);
        }
    };
    // 评价变化后（或评价面板拿到更新的汇总）：同步附近缓存、搜索/沿途结果与选中地点的评价字段，
    // 标记的避雷图标随综合评价立即更新，不等下一次附近请求。值没变时不触发重渲染。
    const applyRatingSummary = (placeId, summary) => {
        if (placeId == null || !summary) return;
        const patch = { rating_count: Number(summary.count) || 0, rating_average: summary.count ? summary.average : null };
        const matches = (place) => !!place && place.isMarked !== false && String(place.id) === String(placeId);
        const differs = (place) => (Number(place.rating_count) || 0) !== patch.rating_count
            || (place.rating_average ?? null) !== patch.rating_average;
        const patchList = (list) => (Array.isArray(list) && list.some((place) => matches(place) && differs(place))
            ? list.map((place) => (matches(place) ? { ...place, ...patch } : place))
            : list);
        const cached = placeCacheRef.current.all().find(matches);
        if (cached && differs(cached)) {
            placeCacheRef.current.upsert({ ...cached, ...patch });
            if (searchResultsRef.current === null && alongRouteResultsRef.current === null) publishNearbyFromCache();
        }
        setSearchResults(patchList);
        setAlongRouteResults(patchList);
        if (userFilterRef.current?.places) {
            const patched = patchList(userFilterRef.current.places);
            if (patched !== userFilterRef.current.places) commitUserFilter({ ...userFilterRef.current, places: patched });
        }
        const selected = selectedPlaceRef.current;
        if (matches(selected) && differs(selected)) {
            const next = { ...selected, ...patch };
            selectedPlaceRef.current = next;
            setSelectedPlace(next);
        }
    };

    // 选中地点：宽屏卡片由地图覆盖物锚定，窄屏为底部面板（见 MapUI），这里只提交业务状态
    const showPopup = (p) => {
        if (!p) return;
        selectedPlaceRef.current = p;
        setSelectedPlace(p);
    };

    const ensureUserLocationMarker = (position) => {
        if (!mapRef.current || !window.AMap) return null;
        if (!userLocationMarkerRef.current) {
            // 自绘蓝点：高德默认标记图是协议相对地址（//webapi.amap.com/...），
            // iOS App 的页面协议是 capacitor://，图片加载失败会显示成问号
            const dot = document.createElement("div");
            dot.className = "fm-user-location";
            dot.setAttribute("role", "img");
            dot.setAttribute("aria-label", t('map:main.myLocation'));
            userLocationMarkerRef.current = new window.AMap.Marker({
                position,
                content: dot,
                anchor: "center",
                title: t('map:main.myLocation'),
                bubble: true,
                zIndex: 3000
            });
            userLocationMarkerRef.current.setMap(mapRef.current);
            if (typeof userLocationMarkerRef.current.setTop === "function") {
                userLocationMarkerRef.current.setTop(true);
            }
        } else {
            userLocationMarkerRef.current.setPosition(position);
            if (!userLocationMarkerRef.current.getMap()) {
                userLocationMarkerRef.current.setMap(mapRef.current);
            }
        }
        return userLocationMarkerRef.current;
    };

    // 唯一的标记数据入口：当前模式（沿途 > 搜索 > 住民筛选 > 附近）的完整列表交给标记层。
    // 高德临时 POI 默认只存在于结果列表；用户单独选中后才显示在地图上。住民的地点加载完成前仍显示附近地点。
    const userPlaces = userFilter?.status === 'ready' ? userFilter.places : null;
    const markerQueryMode = alongRouteResults != null ? 'along' : (searchResults != null ? 'search' : (userPlaces ? 'user' : 'nearby'));
    const markerSource = alongRouteResults != null ? alongRouteResults : (searchResults != null ? searchResults : (userPlaces || places));
    useEffect(() => {
        if (!mapReady || !markerLayerRef.current) return;
        // 筛选只作用于站内地点；当前选中的地点即使不符合也保留，卡片不会失去锚点
        const selectedKey = selectedPlaceRef.current ? placeKey(selectedPlaceRef.current) : null;
        const filtered = (markerSource || []).filter((place) => (place.isMarked !== false || place.showOnMap === true)
            && (matchesPlaceFilter(place, placeFilter) || (selectedKey && placeKey(place) === selectedKey)));
        const visibleMapPlaces = venuePlace && !filtered.some((place) => placeKey(place) === placeKey(venuePlace))
            ? [...filtered, venuePlace]
            : filtered;
        markerLayerRef.current.update({ places: visibleMapPlaces, queryMode: markerQueryMode });
        // 离开附近模式时，未完成的附近请求作废
        if (markerQueryMode !== 'nearby') nearbyGateRef.current.invalidate();
    }, [mapReady, markerSource, markerQueryMode, placeFilter, venuePlace]);

    useEffect(() => {
        markerLayerRef.current?.setSelectedKey(selectedPlace ? placeKey(selectedPlace) : null);
    }, [selectedPlace, mapReady]);

    // 点击聚合：查询真正的展开层级，把聚合放到未被遮挡区域的中央；到最大缩放仍重合时打开成员列表。
    const handleClusterClick = (node, engine) => {
        const map = mapRef.current;
        if (!map || !node || !engine) return;
        const maxZoom = getMapZoomRange(map).max;
        const expansion = engine.expansionZoom(node);
        const currentZoom = Number(map.getZoom());
        if (expansion > maxZoom || currentZoom >= maxZoom - 0.05) {
            const members = engine.memberKeys(node).map((key) => engine.placeByKey.get(key)).filter(Boolean);
            setClusterMembers({ key: node.key, coordinate: node.coordinate, places: members });
            return;
        }
        const targetZoom = Math.min(maxZoom, Math.max(expansion, Math.ceil(currentZoom + 0.01)));
        const container = containerRef.current;
        const width = container?.clientWidth || window.innerWidth;
        const height = container?.clientHeight || window.innerHeight;
        const insets = getMapSafeInsets(container);
        const [lng, lat] = node.coordinate;
        const center = centerForScreenTarget({
            lng, lat, zoom: targetZoom,
            targetX: width / 2,
            targetY: insets.top + (height - insets.top - insets.bottom) / 2,
            width, height
        });
        armSkipAutoSearch();
        try {
            if (typeof map.setZoomAndCenter === 'function') map.setZoomAndCenter(targetZoom, center, false);
            else { map.setCenter(center); map.setZoom(targetZoom); }
        } catch (e) {
            console.warn('展开聚合失败', e);
        }
    };

    markerHandlersRef.current = {
        onPlaceClick: (place) => {
            feedbackRef.current.record('click', 'map', place.id);
            showPopup(place);
        },
        onClusterClick: handleClusterClick
    };

    const handleAlongRouteResults = (results) => {
        if (Array.isArray(results)) {
            clearSearchState({ resetTerm: true, closeSearchUi: true, reloadPlaces: false });
            exitUserFilter();
            alongRouteResultsRef.current = results;
            setAlongRouteResults(results);
            return;
        }
        alongRouteResultsRef.current = null;
        setAlongRouteResults(null);
        window.setTimeout(() => loadPlacesRef.current?.(true), 0);
    };

    const handleSelectAlongRoutePlace = (place) => {
        if (!place || !mapRef.current) return;
        const lng = Number(place.longitude);
        const lat = Number(place.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        try {
            mapRef.current.setCenter([lng, lat]);
            if (Number(mapRef.current.getZoom?.()) < 16) mapRef.current.setZoom(16);
        } catch (error) { /* best effort */ }
        showPopup(place);
    };

    // 展会地点（展会面板点地址）：复用高德临时地点的标记与卡片，卡片只有导航；
    // 卡片关掉或选了别的地点后标记随之消失（venuePlace 状态在组件顶部声明，标记层的 effect 要用）
    const showExhibitionVenue = (venue) => {
        if (!venue) return;
        const place = {
            id: `amap_${venue.key}`,
            isMarked: false,
            showOnMap: true,
            exhibitionVenue: true,
            name: venue.label,
            category: '',
            longitude: venue.lng,
            latitude: venue.lat
        };
        setVenuePlace(place);
        handleSelectAlongRoutePlace(place);
    };
    useEffect(() => {
        if (venuePlace && (!selectedPlace || placeKey(selectedPlace) !== placeKey(venuePlace))) setVenuePlace(null);
    }, [selectedPlace, venuePlace]);

    // 列表模式里点了一个地点：退出搜索、沿途与住民筛选，地图移到这个地点并打开卡片，附近地点随之重新加载
    const focusPlaceFromList = (placeId) => {
        clearSearchState({ reloadPlaces: false });
        setAlongRouteResults(null);
        exitUserFilter();
        searchResultsRef.current = null;
        alongRouteResultsRef.current = null;
        armSkipAutoSearch();
        focusPlaceById(placeId).then(() => loadPlacesRef.current?.(true));
    };
    const currentMapCenter = () => {
        const center = mapRef.current?.getCenter?.();
        if (!center) return null;
        const lng = Number(typeof center.getLng === 'function' ? center.getLng() : center.lng);
        const lat = Number(typeof center.getLat === 'function' ? center.getLat() : center.lat);
        return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
    };
    const pickListCenter = (center, resolve) => setListCenterPicker({ center, resolve });
    const selectListCenter = (point) => {
        const lng = Number(point?.lng ?? point?.longitude);
        const lat = Number(point?.lat ?? point?.latitude);
        if (Number.isFinite(lng) && Number.isFinite(lat)) listCenterPicker?.resolve({ lng, lat });
        setListCenterPicker(null);
    };

    const handleSelectRandomPlace = (place) => {
        if (!place || !mapRef.current) return;
        clearSearchState({ reloadPlaces: false });
        setAlongRouteResults(null);
        exitUserFilter();
        // Map move events can fire before React effects synchronize these refs.
        // Random discovery opens a detail popup without filtering nearby markers.
        searchResultsRef.current = null;
        alongRouteResultsRef.current = null;
        armSkipAutoSearch();
        handleSelectAlongRoutePlace(place);
        loadPlacesRef.current?.(true);
    };

    // onCreated：地点已建好（表单用它删除本机草稿），之后刷新地图失败也不影响
    // 返回 { ok, message }：iOS 原生表单据此显示结果；silent 时失败不弹网页提示（原生表单自己显示）
    const submitPlace = async (payload, { onCreated, silent = false } = {}) => {
        if (!token) {
            onRequireAuth && onRequireAuth();
            return { ok: false, message: '' };
        }
        if (isBanned) {
            if (!silent) showTip(t('map:main.submitBanned'));
            return { ok: false, message: t('map:main.submitBanned') };
        }

        try {
            await Api.postPlace(backendUrl, token, payload);
            onCreated && onCreated();
            setAddingPos(null);
            setAddingPrefill(null);
            // 重新加载数据并清除搜索结果与住民筛选（若有）
            exitUserFilter();
            searchResultsRef.current = null;
            setSearchResults(null);
            setSearching(false);
            setAiThinking(false);
            setAiRecommendations([]);
            await refreshNearby();
            setAddMode(false);
            return { ok: true };
        } catch (e) {
            console.error("提交地点失败", e);
            const message = t('map:main.submitFailed', { message: e.message || e });
            if (!silent) showTip(message);
            return { ok: false, message };
        }
    };

    // 视野调整到一组地点（搜索结果、住民的地点），避开界面遮挡；只有一个时放大到 16 级
    const fitMapToPlaces = (list) => {
        const fitBounds = boundsOfPlaces(list);
        if (!fitBounds || !mapRef.current) return;
        armSkipAutoSearch(800);
        try {
            const insets = getMapSafeInsets(containerRef.current);
            const pad = 48;
            if (fitBounds.count === 1) {
                mapRef.current.setZoomAndCenter(16, [fitBounds.minLng, fitBounds.minLat]);
            } else {
                mapRef.current.setBounds(
                    new window.AMap.Bounds([fitBounds.minLng, fitBounds.minLat], [fitBounds.maxLng, fitBounds.maxLat]),
                    false,
                    [insets.top + pad, pad, insets.bottom + pad, pad]
                );
            }
        } catch (e) {
            const first = list[0];
            if (first) {
                mapRef.current.setCenter([first.longitude, first.latitude]);
                mapRef.current.setZoom(15);
            }
        }
    };

    // 提交搜索时同时启动快速字面匹配与 AI 语义推荐；快速结果不会等待 AI。
    const searchServer = async ({ q = "", center = undefined, bounds = undefined, limit = undefined, autoFit = true } = {}) => {
        const query = String(q || '').trim();
        if (!query) return;
        const readMapPoint = (point) => {
            const lat = Number(point?.lat ?? point?.getLat?.());
            const lng = Number(point?.lng ?? point?.getLng?.());
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
        };
        const mapCenter = readMapPoint(mapRef.current?.getCenter?.());
        const effectiveCenter = center || mapCenter;
        const mapBounds = mapRef.current?.getBounds?.();
        const southWest = readMapPoint(mapBounds?.getSouthWest?.());
        const northEast = readMapPoint(mapBounds?.getNorthEast?.());
        const effectiveBounds = bounds || (southWest && northEast ? {
            minLng: southWest.lng,
            minLat: southWest.lat,
            maxLng: northEast.lng,
            maxLat: northEast.lat
        } : undefined);
        if (!mapRef.current && !effectiveCenter) {
            console.warn("searchServer: 地图尚未就绪且未传入 center，直接返回");
            return;
        }

        searchAbortControllersRef.current.forEach((controller) => controller.abort());
        exitUserFilter();
        const fastController = new AbortController();
        const aiController = new AbortController();
        searchAbortControllersRef.current = [fastController, aiController];
        const requestId = ++searchRequestIdRef.current;
        let baseData = [];
        let fastSettled = false;
        let resolvedRecommendations = [];

        const mergeRecommendations = (data, recommendations) => {
            const validRecommendations = (Array.isArray(recommendations) ? recommendations : [])
                .filter((recommendation) => recommendation?.place)
                .slice(0, 3);
            if (!validRecommendations.length) return data;
            const recommendedIds = new Set(validRecommendations.map((recommendation) => String(recommendation.place.id)));
            return [
                ...validRecommendations.map((recommendation) => recommendation.place),
                ...data.filter((place) => !recommendedIds.has(String(place.id)))
            ];
        };

        const publishResults = (data, recommendations) => {
            if (requestId !== searchRequestIdRef.current) return;
            const merged = mergeRecommendations(data, recommendations);
            // 只提交数据：标记由统一入口在 effect 中渲染，不在回调里直接重建
            searchResultsRef.current = merged;
            setSearchResults(merged);
        };

        // AI 推荐需要登录（封禁期间只读，也不发起）；游客只看快速结果。
        const aiAllowed = !!token && !isBanned;
        setSearching(true);
        setAiThinking(aiAllowed);
        setAiRecommendations([]);

        // Both network calls are created before either one is awaited.
        const fastPromise = Api.searchPlacesFast(backendUrl, {
            q: query,
            center: effectiveCenter,
            limit,
            signal: fastController.signal,
            token
        });
        const aiPromise = aiAllowed ? Api.searchPlacesAi(backendUrl, {
            q: query,
            limit: 5,
            center: effectiveCenter,
            bounds: effectiveBounds,
            signal: aiController.signal,
            token
        }) : null;

        aiPromise
            ?.then((result) => {
                if (requestId !== searchRequestIdRef.current) return;
                resolvedRecommendations = Array.isArray(result?.recommendations)
                    ? result.recommendations.filter((recommendation) => recommendation?.place).slice(0, 3)
                    : (result?.recommendation?.place ? [result.recommendation] : []);
                setAiRecommendations(resolvedRecommendations);
                if (fastSettled && resolvedRecommendations.length) publishResults(baseData, resolvedRecommendations);
                // AI 从原话里读出了筛选（只看某些标签 / 人均范围）：直接作用到地图，筛选按钮随之高亮，可在面板里改或清除
                const aiFilter = placeFilterFromAi(result?.filter);
                if (aiFilter) setPlaceFilter(aiFilter, 'ai');
            })
            .catch((error) => {
                if (error?.name !== 'AbortError' && requestId === searchRequestIdRef.current) {
                    console.warn('AI search unavailable; keeping fast results:', error.message || error);
                }
            })
            .finally(() => {
                if (requestId === searchRequestIdRef.current) setAiThinking(false);
            });

        try {
            const markedData = await fastPromise;
            if (requestId !== searchRequestIdRef.current) return;
            const markedResults = (Array.isArray(markedData) ? markedData : []).map((place) => {
                const distanceKm = place.distance_km == null ? Number.NaN : Number(place.distance_km);
                return Number.isFinite(distanceKm) ? { ...place, dist: distanceKm * 1000 } : place;
            });

            baseData = markedResults;
            fastSettled = true;

            publishResults(baseData, resolvedRecommendations);
            // 若匹配成功，调整视野到所有匹配 marker
            if (autoFit) fitMapToPlaces(baseData.filter((place) => place.isMarked !== false || place.showOnMap === true));
        } catch (e) {
            if (e?.name !== 'AbortError') console.error("searchServer error", e);
            if (requestId === searchRequestIdRef.current) {
                fastSettled = true;
                publishResults([], resolvedRecommendations);
            }
        } finally {
            if (requestId === searchRequestIdRef.current) setSearching(false);
        }
    };
    searchServerRef.current = searchServer;

    const searchAllMarkers = async () => {
        // 兼容旧名：直接调用后端搜全局（不传 center）
        await searchServer({ q: searchTerm });
    };

    const clearSearch = async () => {
        await clearSearchState({ resetTerm: true, closeSearchUi: false });
    };

    const handleSelectSuggestion = (item) => {
        exitUserFilter();
        setSearchResults([item?.isMarked === false ? { ...item, showOnMap: true } : item]);
    };

    const readyUserFilter = (data, fallbackUser) => {
        const list = Array.isArray(data?.places) ? data.places : [];
        return {
            user: { id: data?.user?.id ?? fallbackUser.id, name: data?.user?.username || fallbackUser.name },
            status: 'ready',
            places: list,
            total: Number(data?.total) || list.length,
            relation: data?.relation || null
        };
    };

    // 看的是自己的地点时，顺便更新头像上“有被驳回的地点”的小红点（列表不全时以 /users/me 为准）
    const syncRejectedCount = (filter) => {
        if (!filter?.relation?.self || filter.total > filter.places.length) return;
        const count = filter.places.filter((place) => place.moderation_status === 'rejected').length;
        setCurrentUser((user) => (user && user.rejected_place_count !== count ? { ...user, rejected_place_count: count } : user));
    };

    // 按住民筛选：退出搜索与沿途、收起卡片，读取这位住民创建的地点后视野调整到全部地点
    const openUserPlaces = async (user) => {
        if (!user?.id) return;
        const requestId = ++userFilterRequestRef.current;
        clearSearchState({ reloadPlaces: false });
        searchResultsRef.current = null;
        alongRouteResultsRef.current = null;
        setAlongRouteResults(null);
        closePopup();
        commitUserFilter({ user: { id: user.id, name: user.name }, status: 'loading', places: null, total: 0, relation: null });
        try {
            const data = await Api.fetchUserPlaces(backendUrl, user.id, { token });
            if (requestId !== userFilterRequestRef.current) return;
            const next = readyUserFilter(data, user);
            commitUserFilter(next);
            syncRejectedCount(next);
            fitMapToPlaces(next.places);
        } catch (e) {
            if (requestId !== userFilterRequestRef.current) return;
            commitUserFilter({ user: { id: user.id, name: user.name }, status: 'error', places: null, total: 0, relation: null, error: e.message || String(e) });
        }
    };

    // 退出按住民筛选。reload：回到附近地点（搜索、沿途等接管标记时由它们自己加载）
    const exitUserFilter = ({ reload = false } = {}) => {
        userFilterRequestRef.current += 1;
        if (!userFilterRef.current) return;
        commitUserFilter(null);
        if (reload) loadPlacesRef.current?.(true);
    };

    // 筛选中修改 / 删除了地点、登录身份变化：静默重新读取（不移动视野、不收起卡片），失败时保留原列表
    const refreshUserFilter = async () => {
        const current = userFilterRef.current;
        if (!current || current.status !== 'ready') return;
        const requestId = ++userFilterRequestRef.current;
        try {
            const data = await Api.fetchUserPlaces(backendUrl, current.user.id, { token });
            if (requestId !== userFilterRequestRef.current) return;
            const next = readyUserFilter(data, current.user);
            commitUserFilter(next);
            syncRejectedCount(next);
        } catch (e) {
            console.warn('刷新住民的地点失败', e);
        }
    };
    refreshUserFilterRef.current = refreshUserFilter;

    // 屏蔽 / 解除屏蔽筛选中的住民（住民地点列表的操作，网页与 iOS 原生共用）。屏蔽前确认，成功后列表改为“已屏蔽”，
    // 再打开预填的举报表单；附近地点缓存作废，退出筛选后重新读取，TA 的地点不再出现
    const setUserPlacesBlocked = async (blocked) => {
        const current = userFilterRef.current;
        if (!current || !token) return;
        const { id, name } = current.user;
        if (blocked && !(await confirm(t('map:userPlaces.blockConfirm', { name })))) return;
        try {
            await Api.setUserBlocked(backendUrl, token, id, blocked);
        } catch (e) {
            showTip(t('map:userPlaces.blockFailed', { message: e.message || e }));
            return;
        }
        placeCacheRef.current.invalidate();
        showTip(blocked ? t('map:userPlaces.blocked', { name }) : t('map:userPlaces.unblocked', { name }));
        if (String(userFilterRef.current?.user.id) === String(id)) await refreshUserFilter();
        if (blocked) onOpenFeedback?.(userReportPrefill({ username: name, id }));
    };

    // 公开日记链接 ?diary=<公开 ID>&stop=<站点>：未登录也可阅读。这里读取后移除，日记页打开期间会重新写入地址
    // （PublicJourneyView），刷新、收藏或转发当前地址都能回到这篇；QQ 等在末尾追加的参数用 shareParamValue 去掉
    const [initialDiary, setInitialDiary] = useState(null);
    useEffect(() => {
        const params = getQueryParams();
        const publicId = shareParamValue(params.get('diary'));
        if (!publicId || !/^[A-Za-z0-9_-]{8,64}$/.test(publicId)) return;
        const stop = shareParamValue(params.get('stop'));
        removeQueryParams(['diary', 'stop']);
        setInitialDiary({ publicId, stopId: stop && /^[A-Za-z0-9_-]{1,80}$/.test(stop) ? stop : null });
    }, [routeSearch]);

    // 日记中的「查看地图标记」：读取地点后居中并打开地点卡片
    const focusPlaceById = async (placeId) => {
        try {
            const res = await Api.fetchPlace(backendUrl, placeId, { token });
            if (!res.ok) { showTip(t('map:main.markerMissing')); return; }
            const place = await res.json();
            if (mapRef.current && place.longitude != null && place.latitude != null) {
                mapRef.current.setZoomAndCenter(17, [place.longitude, place.latitude]);
            }
            showPopup(place);
        } catch (e) {
            showTip(t('map:main.markerLoadFailed'));
        }
    };
    // 公开日记保存时新建了标记：让附近地点缓存过期并重新加载
    useEffect(() => {
        const onChanged = () => refreshNearbyRef.current && refreshNearbyRef.current();
        window.addEventListener('journey:places-changed', onChanged);
        return () => window.removeEventListener('journey:places-changed', onChanged);
    }, []);

    // 处理分享链接中的 ?place=<id> 参数：加载单个地点并居中（兼容 #/?place= 形式；App 内通过应用链接打开时 routeSearch 会变化）
    useEffect(() => {
        if (!mapReady || !backendUrl) return;
        const params = getQueryParams();
        const placeId = shareParamValue(params.get('place'));
        if (!placeId || !/^\d+$/.test(placeId)) return;

        const isNavShare = shareParamValue(params.get('nav')) === 'amap';
        // 一次性参数：处理后从地址中移除，避免返回或刷新时重复跳转
        removeQueryParams(['place', 'nav']);

        let cancelled = false;
        (async () => {
            try {
                const res = await Api.fetchPlace(backendUrl, placeId, { token });
                if (!res.ok || cancelled) return;
                const place = await res.json();
                if (!place || !place.longitude || !place.latitude || cancelled) return;

                if (isNavShare) {
                    // 高德导航分享：App 内直接唤起高德地图（未安装时打开网页版），网页跳转到高德导航网页
                    const name = (place.name || t('map:main.destination')).trim();
                    const amap = amapNavigationLink({ longitude: place.longitude, latitude: place.latitude, name }, getPlatform());
                    openExternal(amap.url, { sameWindow: true, fallbackUrl: amap.fallbackUrl });
                    return;
                }

                exitUserFilter();
                setSearchTerm(place.name || '');
                setSearchResults([place]);
                setSearchResetKey((v) => v + 1); // 通知 MapUI 关闭搜索建议面板，呈现"已提交"状态
                armSkipAutoSearch(800);
                mapRef.current.setCenter([place.longitude, place.latitude]);
                mapRef.current.setZoom(16);
            } catch (e) {
                console.warn('加载分享地点失败', e);
            }
        })();

        return () => { cancelled = true; };
    }, [mapReady, backendUrl, routeSearch]);

    const handleToggleAddMode = () => {
        if (!mapReady || authPending) return;
        if (!canWrite) {
            if (isBanned) {
                showTip(t('map:main.addBanned'));
                return;
            }
            onRequireAuth && onRequireAuth();
            return;
        }
        setAddMode((v) => {
            const next = !v;
            if (next) clearSearchState();
            return next;
        });
    };

    const handleCreateAtCenter = () => {
        if (!mapRef.current) return;
        clearSearchState();
        const center = mapRef.current.getCenter();
        const lng = center.lng || (center.lnglat && center.lnglat.lng) || center.getLng && center.getLng();
        const lat = center.lat || (center.lnglat && center.lnglat.lat) || center.getLat && center.getLat();
        setAddingPos([lng, lat]);
    };

    const closePopup = () => {
        selectedPlaceRef.current = null;
        setSelectedPlace(null);
        setManageOpen(false);
        setManageMessage("");
    };

    // 定位结果上报给后端（QQ Bot 的 !随机 以它为中心）；登录状态晚于定位就绪时在登录后补报，失败不影响定位本身
    const locationReporterRef = useRef(null);
    if (!locationReporterRef.current) locationReporterRef.current = createLocationReporter(Api.reportUserLocation);
    useEffect(() => {
        locationReporterRef.current.setAuth({ isAuthenticated, token, backendUrl });
    }, [isAuthenticated, token, backendUrl]);

    // auto：App 启动后的自动定位。失败不弹提示（拒绝授权也不打扰）；
    // 等待期间用户已经拖动地图或打开了地点卡片时，只放置位置标记、不再移动地图
    const handleLocateMe = async ({ auto = false } = {}) => {
        if (!mapReady || !mapRef.current) {
            return;
        }

        if (!isLocationAvailable()) {
            if (auto) return;
            const message = t('common:error.geolocationInsecure');
            setLocationError(message);
            showTip(message);
            return;
        }

        // 再次定位时，上一次还在提高精度的定位作废
        locateAbortRef.current?.abort();
        const controller = new AbortController();
        locateAbortRef.current = controller;
        const map = mapRef.current;
        setLocating(true);
        setLocationError("");
        const startCenter = auto ? map.getCenter?.() : null;

        // 网页端和 iOS 之后更准的位置：移动蓝点并补报；地图已移到首个位置、之后用户没拖动也没打开地点卡片时跟着平移（不改缩放）
        let follow = false;
        const stopFollowing = () => { follow = false; };
        map.on?.("dragstart", stopFollowing);
        controller.signal.addEventListener("abort", () => map.off?.("dragstart", stopFollowing), { once: true });
        const onUpdate = (next) => {
            if (controller.signal.aborted || mapRef.current !== map) return;
            ensureUserLocationMarker([next.lng, next.lat]);
            locationReporterRef.current.located(next);
            setLocatedCenter({ lat: next.lat, lng: next.lng });
            if (!follow || selectedPlaceRef.current) return;
            if (typeof map.panTo === "function") map.panTo([next.lng, next.lat]);
            else map.setCenter([next.lng, next.lat]);
        };

        try {
            // 统一返回 GCJ-02：网页端为浏览器定位（本地转换）或高德 IP 定位，Android 为高德定位 SDK（境外才本地转换），iOS 为系统定位 + 本地转换（只转换一次）
            const position = await getCurrentLocation({ map, onUpdate, signal: controller.signal });
            if (controller.signal.aborted || !mapRef.current) return;

            ensureUserLocationMarker([position.lng, position.lat]);
            locationReporterRef.current.located(position);
            setLocatedCenter({ lat: position.lat, lng: position.lng });

            if (auto) {
                const center = mapRef.current.getCenter?.();
                const moved = startCenter && center
                    && (Math.abs(center.getLng() - startCenter.getLng()) > 1e-6 || Math.abs(center.getLat() - startCenter.getLat()) > 1e-6);
                if (moved || selectedPlaceRef.current) return;
            }

            const currentZoomRaw = Number(mapRef.current.getZoom());
            const nextZoom = Number.isFinite(currentZoomRaw)
                ? Math.max(currentZoomRaw, MapUtils.LOCATE_ME_MIN_ZOOM)
                : MapUtils.LOCATE_ME_MIN_ZOOM;
            if (typeof mapRef.current.setZoomAndCenter === "function") {
                mapRef.current.setZoomAndCenter(nextZoom, [position.lng, position.lat]);
            } else {
                mapRef.current.setCenter([position.lng, position.lat]);
                mapRef.current.setZoom(nextZoom);
            }
            follow = true;
        } catch (error) {
            if (controller.signal.aborted) return;
            if (auto) {
                console.warn("启动时自动定位失败", error);
                return;
            }
            const message = describeLocationError(error);
            setLocationError(message);
            console.error("定位失败", error);
            showTip(message);
        } finally {
            if (locateAbortRef.current === controller) setLocating(false);
        }
    };

    // App（安卓 / iOS）进入后自动申请一次定位：首次会弹出系统授权，之后直接定位到当前位置。每次启动只做一次
    useEffect(() => {
        if (!mapReady || autoLocateAttempted || !isNativePlatform()) return;
        autoLocateAttempted = true;
        handleLocateMe({ auto: true });
    }, [mapReady]);

    const openCreateFromPoi = () => {
        if (!selectedPlace) return;
        if (!token) {
            onRequireAuth && onRequireAuth();
            return;
        }
        if (isBanned) {
            showTip(t('map:main.submitBanned'));
            return;
        }
        clearSearchState();
        closePopup();
        setAddingPos([selectedPlace.longitude, selectedPlace.latitude]);
        // 地址单独提交到 address 字段，描述留给用户自己写
        setAddingPrefill({
            name: selectedPlace.name || "",
            category: selectedPlace.amapCategory || "",
            address: String(selectedPlace.address || "").trim().slice(0, 250)
        });
    };

    // 打开管理面板（依据当前用户权限选择直接编辑或提交申请）
    const openManagePanel = async () => {
        if (!selectedPlace) return;
        if (!token) {
            onRequireAuth && onRequireAuth();
            return;
        }
        if (isBanned) {
            showTip(t('map:main.manageBanned'));
            return;
        }
        clearSearchState();
        if (!currentUser && !fetchingUser) {
            try {
                setFetchingUser(true);
                const user = await Api.fetchCurrentUser(backendUrl, token);
                if (user) setCurrentUser(user);
            } catch (e) {
                console.warn("获取当前用户失败", e);
            } finally {
                setFetchingUser(false);
            }
        }
        setManageEdit({
            name: selectedPlace.name || "",
            category: selectedPlace.category || "",
            description: selectedPlace.description || "",
            per_person_cost: selectedPlace.per_person_cost != null ? selectedPlace.per_person_cost : null,
            longitude: selectedPlace.longitude,
            latitude: selectedPlace.latitude,
            exterior_images: MapUtils.parseImageList(selectedPlace.exterior_images),
            menu_images: MapUtils.parseImageList(selectedPlace.menu_images)
        });
        setManageMessage("");
        setManagePositionOpen(false);
        setManageOpen(true);
    };

    // 选点只更新编辑草稿；保存或提交申请时才沿用原有权限流程写入。
    const selectManagePosition = (point) => {
        const longitude = Number(point.lng ?? point.longitude);
        const latitude = Number(point.lat ?? point.latitude);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
        setManageEdit(edit => ({ ...edit, longitude, latitude }));
        setManagePositionOpen(false);
    };

    const buildManagePayload = (edit = manageEdit) => ({
        name: (edit.name || "").trim(),
        category: (edit.category || "").trim(),
        description: (edit.description || "").trim(),
        per_person_cost: edit.per_person_cost,
        exterior_images: (edit.exterior_images || []).filter(Boolean),
        menu_images: (edit.menu_images || []).filter(Boolean),
        // 未调整位置时不提交旧坐标，避免覆盖其他人刚修正的位置。
        ...(Number(edit.longitude) !== Number(selectedPlace.longitude)
            || Number(edit.latitude) !== Number(selectedPlace.latitude)
            ? { longitude: edit.longitude, latitude: edit.latitude } : {})
    });

    // 判断当前用户是否可直接管理
    const canDirectManage = () => {
        if (!selectedPlace || !currentUser) return false;
        const isCreator = String(selectedPlace.creator_id) === String(currentUser.id);
        const isAdmin = !!(currentUser && currentUser.admin_level);
        return isCreator || isAdmin;
    };

    // 直接删除。confirmed：已在 iOS 原生表单里确认过；返回 { ok, message }
    const handleDirectDelete = async ({ confirmed = false } = {}) => {
        if (!selectedPlace) return { ok: false, message: '' };
        if (!token) { onRequireAuth && onRequireAuth(); return { ok: false, message: '' }; }
        if (isBanned) { showTip(t('map:main.deleteBanned')); return { ok: false, message: t('map:main.deleteBanned') }; }
        if (confirmed !== true && !(await confirm(t('map:main.confirmDelete')))) return { ok: false, message: '' };
        setManageSubmitting(true);
        try {
            await Api.deletePlace(backendUrl, token, selectedPlace.id);
            setManageMessage(t('common:status.deleted'));
            setManageOpen(false);
            placeCacheRef.current.remove(selectedPlace);
            closePopup();
            await refreshNearby();
            refreshUserFilter();
            return { ok: true };
        } catch (e) {
            console.error("删除失败", e);
            const message = t('common:error.deleteFailedWithMessage', { message: e.message || e });
            setManageMessage(message);
            return { ok: false, message };
        } finally {
            setManageSubmitting(false);
        }
    };

    // 直接更新。edit 缺省为网页表单的草稿（iOS 原生表单传入自己的内容）；返回 { ok, message }
    const updatePlaceWith = async (edit = manageEdit) => {
        if (!selectedPlace) return { ok: false, message: '' };
        if (!token) { onRequireAuth && onRequireAuth(); return { ok: false, message: '' }; }
        if (isBanned) { showTip(t('map:main.updateBanned')); return { ok: false, message: t('map:main.updateBanned') }; }
        setManageSubmitting(true);
        try {
            const payload = buildManagePayload(edit);
            const result = await Api.putPlace(backendUrl, token, selectedPlace.id, payload);
            // 改出了明显不合规的内容：这次修改转成修改申请等管理员审核，地点保持原样（backend placeModeration.md）
            if (result && result.pending_review) {
                setManageOpen(false);
                showTip(t('map:main.editPendingReview'));
                return { ok: true };
            }
            setManageMessage(t('map:main.updated'));
            setManageOpen(false);
            closePopup();
            await refreshNearby();
            refreshUserFilter();
            return { ok: true };
        } catch (e) {
            console.error("更新失败", e);
            const message = t('map:main.updateFailed', { message: e.message || e });
            setManageMessage(message);
            return { ok: false, message };
        } finally {
            setManageSubmitting(false);
        }
    };
    const handleDirectUpdate = () => updatePlaceWith();

    // 提交修改申请 -> 提交到管理员后台由管理员审核
    const requestModifyWith = async (edit = manageEdit) => {
        if (!selectedPlace) return { ok: false, message: '' };
        if (!token) { onRequireAuth && onRequireAuth(); return { ok: false, message: '' }; }
        if (isBanned) { showTip(t('map:main.requestBanned')); return { ok: false, message: t('map:main.requestBanned') }; }
        setManageSubmitting(true);
        try {
            const payload = {
                place_id: selectedPlace.id,
                proposed: buildManagePayload(edit),
                note: t('map:main.requestNote')
            };
            await Api.postPlaceRequest(backendUrl, token, payload);
            feedback.record('correction', 'map', selectedPlace.id, { reason: 'other' });
            setManageMessage(t('map:main.requestSubmitted'));
            setManageOpen(false);
            showTip(t('map:main.requestSubmitted'));
            return { ok: true };
        } catch (e) {
            console.error("提交申请失败", e);
            const message = t('map:main.requestFailed', { message: e.message || e });
            setManageMessage(message);
            return { ok: false, message };
        } finally {
            setManageSubmitting(false);
        }
    };
    const handleSubmitModifyRequest = () => requestModifyWith();

    const openCommentPanel = async () => {
        if (!selectedPlace) return;
        setCommentMessage("");
        if (!token) {
            onRequireAuth && onRequireAuth();
            return;
        }
        clearSearchState();
        // 当用户被封禁时显示提示（仍允许查看评论，但不能发布）
        if (isBanned) {
            showTip(t('map:main.commentBanned'));
        }
        setCommentOpen(true);
        await fetchComments();
    };

    const closeCommentPanel = () => {
        setCommentOpen(false);
        setCommentsList([]);
        setNewComment("");
        setCommentMessage("");
    };

    const fetchComments = async () => {
        if (!selectedPlace) return;
        setCommentsLoading(true);
        setCommentMessage("");
        try {
            const res = await fetch(`${backendUrl}/comments/place/${selectedPlace.id}`);
            if (!res.ok) throw new Error(`fetch comments failed ${res.status}`);
            const data = await res.json();
            setCommentsList(data || []);
        } catch (e) {
            console.error('fetchComments error', e);
            setCommentMessage(t('map:main.commentsLoadFailed'));
        } finally {
            setCommentsLoading(false);
        }
    };

    const submitComment = async () => {
        if (!selectedPlace) return;
        if (!token) { onRequireAuth && onRequireAuth(); return; }
        if (isBanned) { setCommentMessage(t('map:main.commentBanned')); return; }
        if (!newComment || !newComment.trim()) return;
        setCommentSubmitting(true);
        setCommentMessage("");
        try {
            const res = await fetch(`${backendUrl}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ place_id: selectedPlace.id, content: newComment.trim() })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) { onRequireAuth && onRequireAuth(); return; }
                throw new Error(data.error || `post failed ${res.status}`);
            }
            // prepend new comment
            setCommentsList(list => [data, ...list]);
            setNewComment("");
            setCommentMessage(t('map:main.commentPosted'));
        } catch (e) {
            console.error('submitComment failed', e);
            setCommentMessage(t('map:main.commentFailed', { message: e.message || e }));
        } finally {
            setCommentSubmitting(false);
        }
    };

    const amapFailed = !mapReady && amapState.status === 'error';

    return (
        <>
            {amapFailed && (
                <div role="alert" style={{
                    position: 'absolute', inset: 0, zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 24, boxSizing: 'border-box', background: 'var(--color-bg-base)', color: 'var(--color-text-primary)'
                }}>
                    <div style={{ maxWidth: 360, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 40, color: 'var(--color-text-secondary)' }}>map</span>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>{t('map:main.loadFailed')}</div>
                        <div style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>{describeAmapError(amapState.error)}</div>
                        <Button themeAware onClick={() => retryAmap().catch(() => { })}>{t('map:main.reload')}</Button>
                    </div>
                </div>
            )}
            <MapUI
                feedback={feedback}
                places={places}
                mapRef={mapRef}
                userLocationMarkerRef={userLocationMarkerRef}
                backendUrl={backendUrl}
                token={token}
                containerRef={containerRef}
                searchTerm={searchTerm}
                setSearchTerm={handleSearchTermChange}
                clearSearch={clearSearch}
                searchResetKey={searchResetKey}
                searchServer={searchServer}
                searchResults={searchResults}
                aiThinking={aiThinking}
                aiRecommendations={aiRecommendations}
                onProgrammaticMapMove={armSkipAutoSearch}
                onSelectSuggestion={handleSelectSuggestion}
                mapReady={mapReady}
                searching={searching}
                tipText={tipText}
                customThemeColor={customThemeColor}
                customThemeSecondary={customThemeSecondary}
                onAlongRouteResults={handleAlongRouteResults}
                onSelectAlongRoutePlace={handleSelectAlongRoutePlace}
                onSelectRandomPlace={handleSelectRandomPlace}
                clusterMembers={clusterMembers}
                onCloseClusterMembers={() => setClusterMembers(null)}
                onSelectClusterMember={(place) => {
                    setClusterMembers(null);
                    feedbackRef.current.record('click', 'map', place.id);
                    showPopup(place);
                }}
                authPending={authPending}
                handleLocateMe={handleLocateMe}
                locating={locating}
                addMode={addMode}
                handleToggleAddMode={handleToggleAddMode}
                addPlaceTipText={addPlaceTipText}
                selectedPlace={selectedPlace}
                userFilter={userFilter}
                onOpenUserPlaces={openUserPlaces}
                onExitUserPlaces={() => exitUserFilter({ reload: true })}
                onRetryUserPlaces={() => userFilterRef.current && openUserPlaces(userFilterRef.current.user)}
                onSetUserPlacesBlocked={setUserPlacesBlocked}
                placeFilter={placeFilter}
                placeFilterSource={placeFilterSource}
                onPlaceFilterChange={setPlaceFilter}
                onSelectUserPlace={handleSelectAlongRoutePlace}
                openManagePanel={openManagePanel}
                openCreateFromPoi={openCreateFromPoi}
                openCommentPanel={openCommentPanel}
                closePopup={closePopup}
                manageOpen={manageOpen}
                manageEdit={manageEdit}
                setManageEdit={setManageEdit}
                manageSubmitting={manageSubmitting}
                manageMessage={manageMessage}
                canDirectManage={canDirectManage}
                onManageClose={() => { setManageOpen(false); setManageMessage(""); }}
                onManageSave={handleDirectUpdate}
                onManageDelete={() => handleDirectDelete()}
                onManageSubmitRequest={handleSubmitModifyRequest}
                onManageSubmitWith={(edit) => (canDirectManage() ? updatePlaceWith(edit) : requestModifyWith(edit))}
                onManageDeleteConfirmed={() => handleDirectDelete({ confirmed: true })}
                managePositionOpen={managePositionOpen}
                onManagePickPosition={() => setManagePositionOpen(true)}
                addingPos={addingPos}
                addingPrefill={addingPrefill}
                onAddCancel={() => { setAddingPos(null); setAddMode(false); setAddingPrefill(null); }}
                onAddSubmit={submitPlace}
                favoriteIds={favoriteIds}
                favoriteLoading={favoriteLoading}
                onToggleFavorite={handleToggleFavorite}
                onRatingSummary={applyRatingSummary}
                isAuthenticated={isAuthenticated}
                currentUser={currentUser}
                isAdmin={isAdmin}
                onRequireAuth={onRequireAuth}
                onOpenDinners={onOpenDinners}
                onOpenJourney={() => journeyRef.current?.open()}
                onOpenMine={onOpenMine}
                onLogout={onLogout}
                onOpenAdmin={onOpenAdmin}
                onOpenPosterExport={onOpenPosterExport}
                onOpenFeedback={onOpenFeedback}
                desktopHeaderMenu={desktopHeaderMenu}
                randomFoodRequestId={randomFoodRequestId}
                onOpenPlaceList={onOpenPlaceList}
                onOpenProfile={onOpenProfile}
                myPlacesRequestId={myPlacesRequestId}
                onShowExhibitionVenue={showExhibitionVenue}
                locatedCenter={locatedCenter}
                getMapCenter={currentMapCenter}
                onPickListCenter={pickListCenter}
                onFocusPlaceFromList={focusPlaceFromList}
                onboardingRequestId={onboardingRequestId}
                exhibition={exhibition}
                exhibitionOpen={exhibitionOpen}
                onCloseExhibition={onCloseExhibition}
                pickerMode={pickerMode}
                pickerContext={pickerContext}
                pickedPlaces={pickedPlaces}
                onPickPlace={onPickPlace}
                onRemovePickedPlace={onRemovePickedPlace}
                onPickerClose={onPickerClose}
                pickerTitle={pickerTitle}
                onPickPoint={onPickPoint}
                showTip={showTip}
                chromeOwner={mapPageActive && !pickerMode}
            />

            {!pickerMode && <FullScreenMapPicker
                open={managePositionOpen && manageOpen && !!selectedPlace && canWrite}
                title={t('map:manage.modifyPosition')}
                context="manage"
                center={{ lng: Number(manageEdit.longitude), lat: Number(manageEdit.latitude) }}
                backendUrl={backendUrl}
                token={token}
                isAuthenticated={isAuthenticated}
                onRequireAuth={onRequireAuth}
                onPickPlace={selectManagePosition}
                onPickPoint={selectManagePosition}
                onClose={() => setManagePositionOpen(false)}
            />}
            {!pickerMode && <FullScreenMapPicker
                open={!!listCenterPicker}
                title={t('places:list.center.pickTitle')}
                context="listCenter"
                center={listCenterPicker?.center || undefined}
                backendUrl={backendUrl}
                token={token}
                isAuthenticated={isAuthenticated}
                onRequireAuth={onRequireAuth}
                onPickPlace={selectListCenter}
                onPickPoint={selectListCenter}
                onClose={() => setListCenterPicker(null)}
            />}
            {!pickerMode && <React.Suspense fallback={null}><JourneyWorkspace ref={journeyRef} key={`${backendUrl}:${token || 'guest'}`} backendUrl={backendUrl} token={token}
                isAuthenticated={isAuthenticated} onRequireAuth={onRequireAuth} mapRef={mapRef} mapReady={mapReady}
                selectedPlace={selectedPlace} feedback={feedback} onOpen={() => setAddMode(false)}
                onShowPlace={focusPlaceById} onOpenFeedback={onOpenFeedback} initialPublic={initialDiary} mapPicker={FullScreenMapPicker} /></React.Suspense>}
            {!pickerMode && (
                <CommentPanel
                    open={commentOpen && !!selectedPlace}
                    place={selectedPlace}
                    comments={commentsList}
                    loading={commentsLoading}
                    message={commentMessage}
                    newComment={newComment}
                    setNewComment={setNewComment}
                    submitting={commentSubmitting}
                    onClose={closeCommentPanel}
                    onRefresh={fetchComments}
                    onSubmit={submitComment}
                    canPost={isAuthenticated && !isBanned}
                />
            )}
        </>
    );
}

/**
 * 日记、地点编辑与展会设置共用的全屏地图选点：与地图首页相同的标记、聚合与搜索。可以选中站内标记或搜索结果，
 * 也可以移动地图，用中心图钉选择任意位置。
 */
export function FullScreenMapPicker({ open, title, context = 'journey', center, backendUrl, token, isAuthenticated, onRequireAuth, onPickPlace, onPickPoint, onClose }) {
    const label = title || t('common:action.pickOnMap');
    return (
        <MotionSurface
            show={open}
            portal
            preset="sheet"
            overlay={{ onClose, modal: true, kind: context === 'manage' ? 'place-location-picker' : 'journey-map-picker', label }}
            aria-label={label}
            style={{ position: 'absolute', inset: 0, background: 'var(--color-bg-base)', overflow: 'hidden' }}
        >
            <FullScreenMapContent title={label} onBack={onClose}>
            <MapView
                backendUrl={backendUrl}
                token={token}
                isAuthenticated={isAuthenticated}
                onRequireAuth={onRequireAuth}
                onOpenDinners={() => { }}
                pickerMode
                pickerContext={context}
                pickerTitle={label}
                initialCenter={center}
                onPickPlace={onPickPlace}
                onPickPoint={onPickPoint}
                onPickerClose={onClose}
            />
            </FullScreenMapContent>
        </MotionSurface>
    );
}
