import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import Tooltip from "../components/primitives/Tooltip";
import Button from "../components/primitives/Button";
import ManagePanel from "../places/components/ManagePanel";
import AddForm from "../places/components/AddPlaceForm";
import PlaceDetailPanel, { parseImages as parsePlaceImages } from "../places/components/PlaceDetailPanel";
import PlaceRatingPanel from "../places/components/PlaceRatingPanel";
import usePlaceRating from "../places/hooks/usePlaceRating";
import { isAvoidedPlace, tierForAverage, ratingTierFor, tierLabel, formatAverage, summaryText, summaryFromPlace } from "../places/rating";
import useDarkMode from "../theme/useDarkMode";
import { useSearchPanel } from "../discovery/hooks/useSearchPanel";
import { useExternalSearch } from '../discovery/hooks/useExternalSearch';
import { currentMapCenter, unmarkedExternalPlaces } from '../discovery/externalSearch';
import ScrollableView from "../components/layout/ScrollableView";
import Notice from "../components/feedback/Notice";
import { fetchFavorites } from "../api/client";
import { getThemeColor, pickContrastTextColor } from "../theme/theme";
import defaultAvatar from '../img/default.png';
import AlongRoutePanel from "../discovery/components/AlongRoutePanel";
import { recordPlaceBehavior, sharePlaceContent, copyPlaceContent } from "../places/placeBehavior";
import { buildShareCardModel } from "../places/shareCard";
import useShareCard from "../places/hooks/useShareCard";
import RandomFoodPanel from "../discovery/components/RandomFoodPanel";
import { Exposure } from '../journey/feedback';
import { usePlaceDiaryCount } from '../journey/PlaceDiaryList';
import { buildPublicUrl, imageThumbnailUrl } from '../platform/runtimeConfig';
import { shareContent, copyText } from '../platform/share';
import { openExternal } from '../platform/navigation';
import { getPlatform, APP_VERSION } from '../platform/env';
import { AnimatePresence, motion } from 'motion/react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import MotionSurface from '../components/overlay/MotionSurface';
import MapAnchoredCard from './MapAnchoredCard';
import MapPanel from './MapPanel';
import { useLayoutPolicy, useMotionFlags } from '../motion/MotionProvider';
import { getPreset } from '../motion/presets';
import { placeKey } from './cluster/engine';
import { useMapChrome } from './useMapChrome';
import MapOnboarding from './MapOnboarding';
import { buildOnboardingSteps, readOnboardingSeen, rememberOnboardingSeen } from './onboarding';
import { getOverlayEntries, subscribeOverlays } from '../components/overlay/overlayStack';
import { ExhibitionPanel } from './MapExhibition';
import { exhibitionChromeSheet, exhibitionRandomOrigin } from './exhibition';
import { exhibitionIconSource } from '../components/primitives/ExhibitionIcon';
import { t, tx } from '../i18n/index.js';

const POPUP_GHOST_CLICK_GUARD_MS = 400;
// 窄屏底部元素需要避开底部安全区（iPhone 主屏指示条、Android 手势条）；桌面与多数浏览器场景下为 0
const BOTTOM_INSET = 'var(--safe-bottom, env(safe-area-inset-bottom, 0px))';
const aboveBottomInset = (px) => `calc(${px}px + ${BOTTOM_INSET})`;
const ICP_BEIAN_TEXT = import.meta.env.VITE_ICP_BEIAN_TEXT;
const ICP_BEIAN_URL = import.meta.env.VITE_ICP_BEIAN_URL;
const GONGAN_BEIAN_TEXT = import.meta.env.VITE_GONGAN_BEIAN_TEXT;
const GONGAN_BEIAN_URL = import.meta.env.VITE_GONGAN_BEIAN_URL;

function getPlaceKey(place) {
    if (place?.id !== undefined && place?.id !== null && String(place.id) !== '') {
        return `id:${place.id}`;
    }

    const longitude = Number(place?.longitude);
    const latitude = Number(place?.latitude);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
        return `coord:${longitude.toFixed(6)},${latitude.toFixed(6)}`;
    }

    return `name:${String(place?.name || place?.address || '').trim()}`;
}

function buildNavigationTargets(place) {
    const latitude = Number(place?.latitude);
    const longitude = Number(place?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

    const rawLabel = (place?.name || place?.address || t('map:ui.nav.destination')).trim();
    const label = encodeURIComponent(rawLabel);

    return [
        {
            id: 'system-default',
            name: t('map:ui.nav.systemMap'),
            url: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${label})`,
            mobileOnly: true,
            prefersLocationHref: true
        },
        {
            id: 'apple-maps',
            name: t('map:ui.nav.appleMaps'),
            url: `http://maps.apple.com/?daddr=${latitude},${longitude}&q=${label}`,
            iosOnly: true,
            prefersLocationHref: true
        },
        {
            id: 'amap',
            name: t('map:ui.nav.amap'),
            url: `https://uri.amap.com/navigation?to=${longitude},${latitude},${label}&mode=car&src=yUYUko_food_MAP`
        },
        {
            id: 'tencent',
            name: t('map:ui.nav.tencentMap'),
            url: `https://apis.map.qq.com/uri/v1/routeplan?type=drive&tocoord=${latitude},${longitude}&to=${label}&policy=0&referer=yUYUko_food_MAP`
        },
        {
            id: 'google',
            name: 'Google Maps',
            url: `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`
        }
    ];
}

// ---- 分享工具函数 ----

function buildPlaceShareUrl(place) {
    const id = place?.id;
    if (!id) return '';
    // 公开 HTTPS 地址：App 内的本地 origin（https://localhost 等）不能用于分享
    return buildPublicUrl(`/p/${id}`);
}

function buildAmapShareUrl(place) {
    const id = place?.id;
    if (!id) return '';
    return buildPublicUrl(`/p/${id}?nav=amap`);
}

async function buildPlaceClipboardText(place, backendUrl) {
    const name = place?.name || t('map:ui.unknownPlace');
    const link = buildPlaceShareUrl(place);

    // 优先使用已有地址，否则通过服务端代调的高德逆地理编码获取详细地址（Web 服务 key 只保存在服务端）
    let address = place?.address || '';
    if (!address && place?.longitude && place?.latitude && backendUrl) {
        try {
            const location = `${Number(place.longitude)},${Number(place.latitude)}`;
            const res = await fetch(`${backendUrl}/api/amap/regeo?location=${encodeURIComponent(location)}`);
            if (res.ok) {
                const data = await res.json();
                if (data?.formatted_address) {
                    address = data.formatted_address;
                }
            }
        } catch (e) {
            // 忽略逆地理编码失败
        }
    }

    return `${name}${address ? '\n' + address : ''}\n${link}`;
}

async function copyToClipboard(text) {
    return copyText(text);
}

// ---- ShareOptionButton 组件 ----

function ShareOptionButton({ icon, label, description, onClick, dark }) {
    return (
        React.createElement(Button, {
            onClick,
            style: {
                background: 'transparent',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10
            },
            full: true
        },
            React.createElement('span', { className: 'material-symbols-outlined', style: { fontSize: 24, flexShrink: 0, marginTop: 2 } }, icon),
            React.createElement('div', { style: { flex: 1 } },
                React.createElement('div', { style: { fontSize: 14, fontWeight: 500 } }, label),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 } }, description)
            )
        )
    );
}

// 原生图集：方块（148pt，3 倍屏约 450px）用 OSS 缩略图，点开的大图用原图
const NATIVE_GALLERY_THUMB_WIDTH = 450;
function nativeGalleryGroup(id, title, value) {
    const images = parsePlaceImages(value);
    return { id, title, images, thumbnails: images.map((url) => imageThumbnailUrl(url, NATIVE_GALLERY_THUMB_WIDTH)) };
}

export default function MapUI(props) {
    const { feedback } = props;
    const {
        places,
        mapRef,
        userLocationMarkerRef,
        backendUrl,
        token,
        containerRef,
        searchTerm,
        setSearchTerm,
        clearSearch,
        searchResetKey,
        searchServer,
        searchResults,
        aiThinking,
        aiRecommendations = [],
        onProgrammaticMapMove,
        onSelectSuggestion,
        mapReady,
        searching,
        tipText,
        customThemeColor,
        customThemeSecondary,
        onAlongRouteResults,
        onSelectAlongRoutePlace,
        onSelectRandomPlace,
        clusterMembers,
        onCloseClusterMembers,
        onSelectClusterMember,
        authPending,
        handleLocateMe,
        locating,
        addMode,
        handleToggleAddMode,
        addPlaceTipText,
        selectedPlace,
        getLastModifierText,
        openManagePanel,
        openCreateFromPoi,
        openCommentPanel,
        closePopup,
        manageOpen,
        manageEdit,
        setManageEdit,
        manageSubmitting,
        manageMessage,
        canDirectManage,
        onManageClose,
        onManageSave,
        onManageDelete,
        onManageSubmitRequest,
        onManagePickPosition,
        addingPos,
        addingPrefill,
        onAddCancel,
        onAddSubmit,
        favoriteIds,
        favoriteLoading,
        onToggleFavorite,
        isAuthenticated,
        currentUser,
        isAdmin,
        onRequireAuth,
        onOpenDinners,
        onOpenMine,
        onLogout,
        onOpenAdmin,
        onOpenPosterExport,
        desktopHeaderMenu,
        randomFoodRequestId = 0,
        onboardingRequestId = 0,
        exhibition = null,
        exhibitionOpen = false,
        onCloseExhibition,
        pickerMode,
        pickerContext,
        pickedPlaces,
        onPickPlace,
        onRemovePickedPlace,
        onPickerClose,
        pickerTitle,
        onPickPoint,
        showTip,
        onRatingSummary,
        chromeOwner = false
    } = props;

    const ua = navigator.userAgent || '';
    const platform = getPlatform();
    // iPadOS 默认以桌面版 UA 访问，需要结合触点数判断
    const isIOS = platform === 'ios' || /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = platform === 'android' || /Android/i.test(ua);
    const isMobile = isIOS || isAndroid;

    const navigationTargets = (selectedPlace ? buildNavigationTargets(selectedPlace) : []).filter((item) => {
        if (item.iosOnly && !isIOS) return false;
        if (item.mobileOnly && !isMobile) return false;
        return true;
    });

    const hasNavigationTarget = navigationTargets.length > 0;

    const recordSelectedPlaceBehavior = (eventType, channel) => {
        if (!isAuthenticated || authPending || currentUser?.is_banned || selectedPlace?.isMarked === false) return;
        void recordPlaceBehavior(backendUrl, token, selectedPlace?.id, eventType, channel);
    };

    const handleSharePlace = async (channel) => {
        // Capture the place/auth closure before the OS share UI can change focus.
        const record = recordSelectedPlaceBehavior;
        const isAmap = channel === 'amap';
        const url = isAmap ? buildAmapShareUrl(selectedPlace) : buildPlaceShareUrl(selectedPlace);
        // 地点卡片的大标题是“店名 · 分类”，与后端分享页（backend/routes/placeShare.js）的卡片标题一致：
        // 通过系统分享面板发到 QQ 时，QQ 直接用分享文字作卡片标题，所以文字里不再带详情
        const placeTitle = selectedPlace.category
            ? t('map:ui.share.placeTitle', { name: selectedPlace.name, category: selectedPlace.category })
            : selectedPlace.name;
        const title = isAmap ? t('map:ui.share.navigateTitle', { name: selectedPlace.name }) : placeTitle;
        const text = isAmap
            ? t('map:ui.share.navigateText', { name: selectedPlace.name, address: selectedPlace.address ? ' · ' + selectedPlace.address : '' })
            : placeTitle;
        setShareOpen(false);
        const result = await sharePlaceContent({
            data: { title, text, url },
            // 系统分享面板（网页端取决于浏览器支持；App 内为原生分享）。取消分享不算失败、也不复制
            nativeShare: (data) => shareContent(data),
            copy: copyToClipboard,
            record,
            channel
        });
        if (result === 'copied' && showTip) showTip(isAmap ? t('map:ui.share.amapLinkCopied') : t('map:ui.share.linkCopied'));
    };

    const openNavigationTarget = (target) => {
        if (!target || !target.url) return;
        recordSelectedPlaceBehavior('navigation', target.id);

        // 交给系统打开：App 内可唤起已安装的地图应用，未安装时回退到浏览器
        openExternal(target.url, { sameWindow: isMobile && target.prefersLocationHref }).then((opened) => {
            if (!opened && showTip) showTip(t('map:ui.nav.openFailed'));
        });
    };

    const handleNavigate = () => {
        if (!hasNavigationTarget) return;

        setNavPickerOpen(true);
    };

    const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
    const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
    const [searchResultsVisible, setSearchResultsVisible] = useState(true);
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailFocus, setDetailFocus] = useState(null);
    // 地点小卡上的「相关日记 N 篇」：只统计仍公开的日记，按篇计数
    const diaryCount = usePlaceDiaryCount(selectedPlace && selectedPlace.isMarked !== false && !pickerMode ? selectedPlace.id : null, backendUrl);
    const openDiaries = () => { setDetailFocus('diaries'); setDetailOpen(true); };
    // 评价：小卡显示汇总，点开评价面板查看分布、按口味加权并选择自己的评价
    const ratingPlaceId = selectedPlace && selectedPlace.isMarked !== false && !pickerMode ? selectedPlace.id : null;
    const placeRating = usePlaceRating({ backendUrl, token: isAuthenticated ? token : null, placeId: ratingPlaceId, onSummary: onRatingSummary });
    const [ratingOpen, setRatingOpen] = useState(false);
    const openRating = () => setRatingOpen(true);
    const ratingSummary = placeRating.data ? placeRating.data.summary : summaryFromPlace(selectedPlace);
    const myRatingTier = placeRating.data && placeRating.data.mine ? ratingTierFor(placeRating.data.mine.score) : null;
    const personalizedRating = placeRating.data && placeRating.data.personalized;
    const [favPageOpen, setFavPageOpen] = useState(false);
    const [pickedPageOpen, setPickedPageOpen] = useState(false);
    const [favItems, setFavItems] = useState([]);
    const [favLoading, setFavLoading] = useState(false);
    const [favError, setFavError] = useState('');
    const [navPickerOpen, setNavPickerOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    // 图片卡片：横竖版在预览里切换，生成一次后缓存同一地点的两版
    const shareCard = useShareCard({ onRecord: recordSelectedPlaceBehavior, onTip: showTip });

    const openShareCard = () => {
        const place = selectedPlace;
        if (!place) return;
        const model = buildShareCardModel(place, {
            title: t('map:ui.share.cardTitle'),
            siteName: t('common:app.name'),
            tagline: t('map:ui.share.cardTagline'),
            metaText: place.per_person_cost != null ? t('map:ui.perPersonCost', { per_person_cost: place.per_person_cost }) : '',
            ratingText: ratingSummary && ratingSummary.count > 0 ? summaryText(ratingSummary) : '',
            scanHint: t('map:ui.share.cardScanHint'),
            url: buildPlaceShareUrl(place),
            mapServiceUrl: backendUrl ? `${String(backendUrl).replace(/\/+$/, '')}/api/amap/staticmap` : '',
            fallbackName: t('common:label.unnamedPlace'),
            fallbackCategory: t('common:label.uncategorized')
        });
        setShareOpen(false);
        shareCard.start(model);
    };
    const [alongRouteOpen, setAlongRouteOpen] = useState(false);
    const [randomFoodOpen, setRandomFoodOpen] = useState(false);
    // 随机美食的固定中心（展会地点）；null 表示按地图中心
    const [randomFoodOrigin, setRandomFoodOrigin] = useState(null);
    const handledRandomFoodRequest = useRef(0);
    // 布局策略集中判断（640px 窄屏基线）
    const layout = useLayoutPolicy();
    const motionFlags = useMotionFlags();
    const isNarrow = layout.narrow;
    const iosApp = getPlatform() === 'ios';
    const inputRef = useRef(null);
    const [searchFocused, setSearchFocused] = useState(false);
    // iOS App 窄屏：搜索框不常驻，点工具栏“搜索”后工具栏变成输入框（原生玻璃控件，或同样布局的网页控件）。
    // 输入中右侧头像位置变为“收起键盘”按钮；收起键盘后头像回来，左侧返回圆钮退出搜索。
    const compactSearch = iosApp && isNarrow && !pickerMode;
    const [searchExpanded, setSearchExpanded] = useState(false);
    // 网页输入框的“输入中”布局：失焦稍后生效，避免点“收起键盘”时按钮先被换回头像、点击落空
    const [webSearchEditing, setWebSearchEditing] = useState(false);
    const webBlurTimerRef = useRef(0);
    // 原生输入框：网页发出的聚焦/失焦请求（每个 token 执行一次）
    const [nativeFocusRequest, setNativeFocusRequest] = useState({ token: 0, focus: false });
    // 原生输入框回传、尚未在网页提交的文本。网页自己改写文本（选中建议、清空等）时递增版本号，原生据此覆盖输入框
    const pendingNativeTextsRef = useRef([]);
    const [searchTextVersion, setSearchTextVersion] = useState(0);
    const popupRef = useRef(null);
    const popupOpenedAtRef = useRef(0);
    const searchBarRef = useRef(null);
    const dinnerBtnRef = useRef(null);
    // 系统返回与 Escape：所有面板/弹层登记到统一浮层栈，按真实打开顺序逐层关闭（见 components/overlay）
    const dark = useDarkMode();
    const hideNonSearchButtons = false;
    const isPosterPicker = pickerMode && pickerContext === 'poster';
    // 日记选点：除了标记与搜索结果，还可以用地图中心的图钉选择任意位置
    const canPickPoint = pickerMode && typeof onPickPoint === 'function';
    const pickCenterPoint = () => {
        const center = mapRef?.current?.getCenter?.();
        if (!center) return;
        const lng = Number(typeof center.getLng === 'function' ? center.getLng() : center.lng);
        const lat = Number(typeof center.getLat === 'function' ? center.getLat() : center.lat);
        if (Number.isFinite(lng) && Number.isFinite(lat)) onPickPoint({ lng, lat });
    };
    const normalizedPickedPlaces = Array.isArray(pickedPlaces) ? pickedPlaces : [];
    const selectedPlaceAlreadyPicked = !!selectedPlace && normalizedPickedPlaces.some((place) => getPlaceKey(place) === getPlaceKey(selectedPlace));
    const popupActionButtonStyle = {
        background: 'transparent',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-primary)',
        padding: '9px 10px',
        minWidth: 44,
        minHeight: 44,
        borderRadius: 'var(--radius-sm)',
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        touchAction: 'manipulation'
    };
    const popupActionIconStyle = { display: 'inline-block', fontSize: 20 };
    const popupActionLabelStyle = { fontSize: 11, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap' };
    const mobileNavButtonStyle = {
        flex: 1,
        minWidth: 0,
        minHeight: 58,
        padding: '6px 2px',
        border: 0,
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        color: 'var(--color-text-primary)',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        fontSize: 11,
        lineHeight: 1.1,
        touchAction: 'manipulation'
    };

    const toggleFavorites = () => {
        if (!isAuthenticated) {
            onRequireAuth?.();
            return;
        }
        setFavPageOpen((open) => !open);
        setPickedPageOpen(false);
        setMobileMoreOpen(false);
        setMobileAccountOpen(false);
        setAlongRouteOpen(false);
        setRandomFoodOpen(false);
    };

    const openAlongRoute = () => {
        setRandomFoodOpen(false);
        setAlongRouteOpen(true);
        setFavPageOpen(false);
        setPickedPageOpen(false);
        setMobileMoreOpen(false);
        setMobileAccountOpen(false);
        clearSearch?.({ resetTerm: true, closeSearchUi: true, reloadPlaces: false });
    };

    const closeAlongRoute = () => setAlongRouteOpen(false);

    const openRandomFoodAt = (origin) => {
        setAlongRouteOpen(false);
        setFavPageOpen(false);
        setPickedPageOpen(false);
        setMobileMoreOpen(false);
        setMobileAccountOpen(false);
        closePopup?.();
        if (addMode) handleToggleAddMode();
        clearSearch?.();
        setRandomFoodOrigin(origin || null);
        setRandomFoodOpen(true);
    };
    const openRandomFood = () => openRandomFoodAt(null);

    // 展会面板的“展会附近随机美食”：收起展会面板，以展会地点为本轮中心抽取
    const openExhibitionRandom = () => {
        const origin = exhibitionRandomOrigin(exhibition);
        if (!origin) return;
        onCloseExhibition?.();
        openRandomFoodAt(origin);
    };

    // 打开展会面板时收起菜单类浮层（原生模式下它们与展会面板共用同一个系统面板位置）
    useEffect(() => {
        if (!exhibitionOpen) return;
        setMobileMoreOpen(false);
        setMobileAccountOpen(false);
        setFavPageOpen(false);
    }, [exhibitionOpen]);

    useEffect(() => {
        if (!mapReady || !randomFoodRequestId || handledRandomFoodRequest.current === randomFoodRequestId) return;
        handledRandomFoodRequest.current = randomFoodRequestId;
        openRandomFood();
    }, [randomFoodRequestId, mapReady]);

    const toggleMobileMore = () => {
        setRandomFoodOpen(false);
        setMobileMoreOpen((open) => !open);
        setMobileAccountOpen(false);
        setFavPageOpen(false);
    };

    const runMobileMoreAction = (action) => {
        setMobileMoreOpen(false);
        action?.();
    };

    // 操作指引：第一次打开地图时自动出现（见下方 canAutoOnboard），也可以从“更多”里再次打开
    const [onboardingOpen, setOnboardingOpen] = useState(false);
    // 每次打开从第一步开始：关闭动画还没结束就再次打开时，浮层会复用退出中的实例，靠场次号重置步骤
    const [onboardingSession, setOnboardingSession] = useState(0);
    const handledOnboardingRequest = useRef(0);
    const showOnboarding = () => {
        setOnboardingSession((session) => session + 1);
        setOnboardingOpen(true);
    };
    const openOnboarding = () => {
        setMobileMoreOpen(false);
        setMobileAccountOpen(false);
        setFavPageOpen(false);
        if (addMode) handleToggleAddMode();
        showOnboarding();
    };
    const closeOnboarding = () => {
        rememberOnboardingSeen();
        setOnboardingOpen(false);
    };

    const toggleMobileAccount = () => {
        setRandomFoodOpen(false);
        if (!isAuthenticated) {
            onOpenMine?.();
            return;
        }
        setMobileAccountOpen((open) => !open);
        setMobileMoreOpen(false);
        setFavPageOpen(false);
    };

    const runMobileAccountAction = (action) => {
        setMobileAccountOpen(false);
        action?.();
    };

    const externalSearch = useExternalSearch(searchTerm, searchResetKey, backendUrl);

    // ---- 搜索输入：网页输入框与原生输入框共用；输入及回车仅搜索已收录地点 ----
    const handleSearchInput = (value) => {
        feedback?.beginSearch();
        setSearchTerm(value);
        if (!value || !value.trim()) {
            setSearchResultsVisible(false);
            clearSearch();
        } else {
            setSearchResultsVisible(true);
        }
    };

    const submitSearch = (value) => {
        if (!value || !value.trim()) return;
        feedback?.beginSearch();
        feedback?.record('search', 'search');
        setSearchResultsVisible(true);
        searchServer({ q: value, autoFit: false });
    };

    const requestNativeSearchFocus = (focus) => setNativeFocusRequest((prev) => ({ token: prev.token + 1, focus }));

    const searchUnlistedPlaces = () => {
        if (!mapReady || !searchTerm.trim()) return;
        inputRef.current?.blur();
        requestNativeSearchFocus(false);
        void externalSearch.search({ center: currentMapCenter(mapRef), source: 'map_manual' });
    };

    const openCompactSearch = () => {
        setSearchExpanded(true);
        setSearchResultsVisible(true);
    };

    // 网页控件：同步渲染输入框后在同一次点按内聚焦，iOS 才会弹出键盘
    const openWebCompactSearch = () => {
        flushSync(() => {
            openCompactSearch();
            setWebSearchEditing(true);
        });
        inputRef.current?.focus({ preventScroll: true });
        stabilizeMobileSearchViewport();
    };

    const closeCompactSearch = () => {
        window.clearTimeout(webBlurTimerRef.current);
        setSearchExpanded(false);
        setWebSearchEditing(false);
        setSearchFocused(false);
        setSearchResultsVisible(false);
        inputRef.current?.blur();
        if (searchTerm || pendingNativeTextsRef.current.length || Array.isArray(searchResults)) {
            feedback?.beginSearch();
            setSearchTerm('');
            clearSearch();
        }
    };

    const blurWebSearch = () => {
        window.clearTimeout(webBlurTimerRef.current);
        setWebSearchEditing(false);
        inputRef.current?.blur();
    };

    // 收起键盘：还没输入内容时同时退出搜索
    const dismissWebSearchKeyboard = () => {
        if (!searchTerm.trim()) closeCompactSearch();
        else blurWebSearch();
    };

    const handleNativeSearch = (event) => {
        switch (event.type) {
            case 'input': {
                const text = event.text || '';
                const pending = pendingNativeTextsRef.current;
                pending.push(text);
                if (pending.length > 20) pending.shift();
                handleSearchInput(text);
                return;
            }
            case 'submit':
                submitSearch(event.text || '');
                return;
            case 'focus':
                setSearchFocused(!!event.focused);
                if (event.focused && (event.text || '').trim()) setSearchResultsVisible(true);
                return;
            case 'close':
                closeCompactSearch();
                return;
            default:
        }
    };

    // ---- iOS 原生玻璃控件：按钮快照与动作白名单（网页工具栏的同一组操作） ----
    // sheetWhenNative：原生模式下打开系统面板（未登录时仍是网页登录浮层）。“更多”不在工具栏里：原生工具栏上滑展开（drawer）
    const chromeItems = [
        { id: 'favorites', title: t('map:ui.favorites'), symbol: favPageOpen ? 'heart.fill' : 'heart', selected: favPageOpen, opensOverlay: true, sheetWhenNative: isAuthenticated },
        { id: 'journey', title: t('map:ui.diaryCommunity'), symbol: 'book.closed', opensOverlay: true },
        {
            id: 'add',
            title: addMode ? t('map:ui.cancelAdd') : t('map:ui.add'),
            symbol: addMode ? 'xmark.circle.fill' : 'plus.circle.fill',
            tone: addMode ? 'danger' : 'accent',
            selected: addMode,
            disabled: !mapReady || authPending,
            opensOverlay: false
        },
        { id: 'search', title: t('common:action.search'), symbol: 'magnifyingglass', selected: searchExpanded, disabled: !mapReady, opensOverlay: false },
        {
            id: 'account',
            title: isAuthenticated ? t('map:ui.openUserMenu') : t('map:ui.login'),
            symbol: isAuthenticated ? 'person.crop.circle.badge.checkmark' : 'person.crop.circle',
            avatarURL: isAuthenticated && currentUser ? (currentUser.has_avatar ? `${backendUrl}/users/${currentUser.id}/avatar` : (currentUser.avatar || defaultAvatar)) : defaultAvatar,
            placement: 'account',
            selected: mobileAccountOpen,
            opensOverlay: true,
            sheetWhenNative: isAuthenticated
        },
        { id: 'locate', title: locating ? t('map:ui.locating') : t('map:ui.locate'), symbol: locating ? 'location.fill' : 'location', placement: 'floating', busy: locating, disabled: !mapReady || locating, opensOverlay: false }
    ];
    const handleChromeAction = (actionId) => {
        switch (actionId) {
            case 'more': toggleMobileMore(); return true;
            case 'favorites': toggleFavorites(); return true;
            case 'journey':
                setFavPageOpen(false);
                runMobileMoreAction(props.onOpenJourney);
                return true;
            case 'add':
                handleToggleAddMode();
                setMobileMoreOpen(false);
                setFavPageOpen(false);
                return true;
            case 'alongRoute':
                if (alongRouteOpen) setAlongRouteOpen(false);
                else openAlongRoute();
                return true;
            case 'account': toggleMobileAccount(); return true;
            case 'search':
                if (nativeChrome) {
                    openCompactSearch();
                    requestNativeSearchFocus(true);
                } else if (compactSearch) {
                    openWebCompactSearch();
                } else {
                    setSearchResultsVisible(true);
                    inputRef.current?.focus({ preventScroll: true });
                }
                return true;
            case 'locate': handleLocateMe(); return true;
            default: return false;
        }
    };

    // ---- 原生面板（iOS 26 系统 sheet）：与网页面板同一组操作。原生只拿到展示字段，点按回传行 id，这里查表执行 ----
    const moreMenuEntries = [
        iosApp && { id: 'alongRoute', title: t('map:ui.alongRoute'), symbol: 'point.topleft.down.to.point.bottomright.curvepath', disabled: !mapReady, run: openAlongRoute },
        { id: 'random', title: t('map:ui.randomFood'), symbol: 'dice', disabled: !mapReady, run: openRandomFood },
        isAuthenticated && { id: 'dinners', title: t('map:ui.dinners'), symbol: 'fork.knife', run: onOpenDinners },
        isAuthenticated && { id: 'poster', title: t('map:ui.posterExport'), symbol: 'photo.on.rectangle', run: onOpenPosterExport },
        isAdmin && { id: 'admin', title: t('map:ui.admin'), symbol: 'gearshape.2', run: onOpenAdmin },
        { id: 'guide', title: t('map:onboarding.menuEntry'), symbol: 'questionmark.circle', run: openOnboarding }
    ].filter(Boolean);
    const moreFootnoteEntries = [
        ICP_BEIAN_TEXT && ICP_BEIAN_URL && { id: 'icp', title: ICP_BEIAN_TEXT, symbol: 'doc.text', url: ICP_BEIAN_URL },
        GONGAN_BEIAN_TEXT && GONGAN_BEIAN_URL && { id: 'gongan', title: GONGAN_BEIAN_TEXT, symbol: 'checkmark.shield', url: GONGAN_BEIAN_URL }
    ].filter(Boolean);
    const accountMenuEntries = [
        { id: 'settings', title: t('map:ui.accountSettings'), symbol: 'person.crop.circle', run: onOpenMine },
        { id: 'logout', title: t('map:ui.logout'), symbol: 'rectangle.portrait.and.arrow.right', tone: 'danger', run: onLogout }
    ];
    const toSheetRows = (entries) => entries.map(({ run, url, ...row }) => row);
    const favoriteRowId = (item) => `place-${item.place_id}`;

    const openSheetId = (isAuthenticated && mobileAccountOpen) ? 'account'
        : (isAuthenticated && favPageOpen) ? 'favorites'
        // 展会面板盖在地点卡片之上：关闭后仍选中的地点卡片重新出现
        : (exhibitionOpen && exhibition && !pickerMode) ? 'exhibition'
        : (selectedPlace && !pickerMode) ? 'place'
        : null;
    // 每次打开面板分配新 token：用户在原生侧关闭后，同一 token 的旧快照不会再弹出，迟到的事件也不会作用到新面板
    const sheetTokenRef = useRef({ id: null, token: 0 });
    if (sheetTokenRef.current.id !== openSheetId) {
        sheetTokenRef.current = { id: openSheetId, token: sheetTokenRef.current.token + (openSheetId ? 1 : 0) };
    }
    let chromeSheet = null;
    if (openSheetId === 'account') {
        chromeSheet = {
            id: 'account',
            title: currentUser?.username || t('map:ui.defaultUsername'),
            subtitle: t('map:ui.verified'),
            size: 'fit',
            sections: [{ id: 'account', rows: toSheetRows(accountMenuEntries) }]
        };
    } else if (openSheetId === 'favorites') {
        chromeSheet = {
            id: 'favorites',
            title: t('map:ui.myFavorites'),
            size: 'list',
            message: favLoading ? t('common:status.loading') : favError || (favItems.length === 0 ? t('map:ui.noFavorites') : undefined),
            messageTone: favLoading ? 'loading' : (favError ? 'danger' : undefined),
            sections: favLoading || favError ? [] : [{
                id: 'places',
                rows: favItems.map((item) => {
                    const located = !!(item.longitude && item.latitude);
                    return {
                        id: favoriteRowId(item),
                        title: item.name || t('map:ui.deletedPlace', { place_id: item.place_id }),
                        subtitle: item.name && !located
                            ? t('map:ui.missingCoordinates', { prefix: item.category ? `${item.category} · ` : '' })
                            : (item.category || undefined),
                        symbol: 'mappin.circle.fill',
                        tone: !item.name ? 'muted' : (!located ? 'warning' : undefined),
                        disabled: !located
                    };
                })
            }]
        };
    } else if (openSheetId === 'exhibition') {
        chromeSheet = exhibitionChromeSheet(exhibition, { iconUrl: exhibitionIconSource(exhibition.icon_url, backendUrl) });
    } else if (openSheetId === 'place') {
        // 地点卡片：两段停靠。第一段是摘要（左上角分享、右上角关闭、一排等宽操作按钮），地图保持可操作，点其他地点时原地更新；
        // 上滑或点“详情”到全屏，显示完整简介、地址、相关日记与图片。操作按钮不收起面板：
        // 打开的网页浮层（分享、导航选择、编辑、日记）期间原生面板暂时让位，关闭后回来。
        const unmarked = selectedPlace.isMarked === false;
        const favorited = !!(favoriteIds && favoriteIds.has(selectedPlace.id));
        // 评价：摘要高度只显示标题行与按钮，所以评价汇总放在副标题最前面；全屏详情里另有一行可点开评价面板
        const ratingTier = tierForAverage(ratingSummary.average);
        const ratingCompact = !unmarked && ratingSummary.count > 0
            ? t('map:rating.summary.compact', { tier: tierLabel(ratingTier), average: formatAverage(ratingSummary.average), count: ratingSummary.count })
            : null;
        const ratingRow = !unmarked && {
            id: 'rating',
            title: summaryText(ratingSummary),
            subtitle: [
                personalizedRating ? t('map:rating.native.rowSubtitlePersonalized', { tier: tierLabel(tierForAverage(personalizedRating.average)), average: formatAverage(personalizedRating.average) }) : null,
                myRatingTier ? t('map:rating.native.rowSubtitleMine', { tier: tierLabel(myRatingTier) }) : t('map:rating.native.rowSubtitleRate')
            ].filter(Boolean).join(' · '),
            symbol: ratingTier ? ratingTier.symbol : 'hand.thumbsup',
            keepsOpen: true
        };
        chromeSheet = {
            id: 'place',
            title: selectedPlace.name || t('common:label.unnamedPlace'),
            subtitle: [ratingCompact, selectedPlace.category || t('common:label.uncategorized'), selectedPlace.per_person_cost != null ? t('map:ui.perPersonCost', { per_person_cost: selectedPlace.per_person_cost }) : null].filter(Boolean).join(' · '),
            size: 'card',
            leading: { id: 'share', title: t('map:ui.share.title'), symbol: 'square.and.arrow.up', keepsOpen: true },
            detail: String(selectedPlace.description || '').trim() || undefined,
            caption: String(selectedPlace.address || '').trim() || undefined,
            actions: [
                { id: 'navigate', title: t('map:ui.nav.title'), symbol: 'arrow.triangle.turn.up.right.diamond.fill', tone: 'accent', disabled: !hasNavigationTarget, keepsOpen: true },
                // 高德临时地点还没有收录，不能收藏
                !unmarked && {
                    id: 'favorite',
                    title: favorited ? t('map:ui.favorited') : t('map:ui.favorites'),
                    symbol: favorited ? 'heart.fill' : 'heart',
                    disabled: !!favoriteLoading,
                    keepsOpen: true
                },
                // 自己评过时按钮显示自己的评价
                !unmarked && {
                    id: 'rate',
                    title: myRatingTier ? tierLabel(myRatingTier) : t('map:rating.card.rate'),
                    symbol: myRatingTier ? myRatingTier.symbol : 'hand.thumbsup',
                    keepsOpen: true
                },
                unmarked
                    ? { id: 'create', title: t('map:ui.createPlace'), symbol: 'plus.circle', keepsOpen: true }
                    : { id: 'edit', title: t('map:ui.edit'), symbol: 'pencil', keepsOpen: true },
                // 原生侧展开到全屏详情，不回传
                { id: 'details', title: t('map:ui.details'), symbol: 'info.circle', keepsOpen: true, expands: true }
            ].filter(Boolean),
            sections: [
                ratingRow && { id: 'rating', title: t('map:rating.panel.title'), rows: [ratingRow] },
                { id: 'meta', footer: t('map:ui.lastModified', { modifier: getLastModifierText(selectedPlace) }), rows: diaryCount > 0 ? [{ id: 'diaries', title: t('map:ui.diaryCount', { diaryCount }), symbol: 'book.pages', keepsOpen: true }] : [] }
            ].filter(Boolean),
            gallery: unmarked ? [] : [
                nativeGalleryGroup('exterior', t('map:ui.exteriorImages'), selectedPlace.exterior_images),
                nativeGalleryGroup('menu', t('common:label.menu'), selectedPlace.menu_images)
            ]
        };
    }
    if (chromeSheet) chromeSheet.token = sheetTokenRef.current.token;

    // 原生工具栏上滑展开的“更多功能”：网页“更多”菜单的同一组操作
    const chromeDrawer = {
        sections: [
            { id: 'actions', title: t('map:ui.moreFeatures'), rows: toSheetRows(moreMenuEntries) },
            { id: 'about', style: 'footnote', rows: toSheetRows(moreFootnoteEntries), footer: t('map:ui.versionFooter', { version: APP_VERSION }) }
        ]
    };

    const handleNativeDrawer = ({ rowId }) => {
        const entry = [...moreMenuEntries, ...moreFootnoteEntries].find((item) => item.id === rowId);
        if (!entry || entry.disabled) return;
        if (entry.url) openExternal(entry.url);
        else runMobileMoreAction(entry.run);
    };

    const handleNativeSheet = ({ type, sheetId, token, rowId }) => {
        if (sheetId !== sheetTokenRef.current.id || token !== sheetTokenRef.current.token) return;
        if (sheetId === 'account') {
            const entry = type === 'select' && accountMenuEntries.find((item) => item.id === rowId);
            if (entry) runMobileAccountAction(entry.run);
            else setMobileAccountOpen(false);
        } else if (sheetId === 'favorites') {
            setFavPageOpen(false);
            const item = type === 'select' && favItems.find((fav) => favoriteRowId(fav) === rowId);
            if (item) navigateToPlace(item.longitude, item.latitude);
        } else if (sheetId === 'exhibition') {
            if (type === 'dismiss') onCloseExhibition?.();
            else if (rowId === 'random') openExhibitionRandom();
        } else if (sheetId === 'place') {
            if (type === 'dismiss') {
                closePopup?.();
                return;
            }
            if (!selectedPlace) return;
            switch (rowId) {
                case 'navigate': handleNavigate(); break;
                case 'share': setShareOpen(true); break;
                case 'favorite':
                    if (selectedPlace.isMarked !== false && !favoriteLoading) onToggleFavorite?.(selectedPlace);
                    break;
                case 'create': openCreateFromPoi?.(); break;
                case 'edit': openManagePanel?.(); break;
                case 'diaries': openDiaries(); break;
                case 'rate':
                case 'rating': openRating(); break;
                default:
            }
        }
    };

    const chrome = useMapChrome({
        enabled: chromeOwner && layout.sheet && !pickerMode,
        items: chromeItems,
        theme: { primary: customThemeColor, onPrimary: pickContrastTextColor(customThemeColor), dark },
        floatingGap: 14,
        search: compactSearch ? {
            expanded: searchExpanded,
            placeholder: t('map:ui.searchPlaceholderShort'),
            hint: t('map:ui.search.nativeHint'),
            busyLabel: externalSearch.loading ? t('map:ui.search.externalLoading') : t('map:ui.search.loading'),
            busy: !!searching || externalSearch.loading,
            text: searchTerm,
            textVersion: searchTextVersion,
            focusToken: nativeFocusRequest.token,
            focus: nativeFocusRequest.focus
        } : undefined,
        sheet: chromeSheet,
        drawer: chromeDrawer,
        onAction: handleChromeAction,
        onSearch: handleNativeSearch,
        onSheet: handleNativeSheet,
        onDrawer: handleNativeDrawer
    });
    // 原生控件接管后：网页工具栏、定位按钮与输入框不再渲染（也从读屏树中移除），网页只保留原生输入框上方的搜索结果
    const nativeChrome = chrome.mode === 'native';

    // 指引按当前布局介绍按钮：原生控件握手中先不弹出，免得指向随后被替换的网页工具栏
    const onboardingVariant = nativeChrome ? 'native' : (isNarrow ? (iosApp ? 'ios' : 'mobile') : 'desktop');
    const onboardingSteps = React.useMemo(
        () => buildOnboardingSteps({ variant: onboardingVariant, isAuthenticated }),
        [onboardingVariant, isAuthenticated]
    );
    const canAutoOnboard = chromeOwner && mapReady && !pickerMode && !chrome.connecting && !onboardingOpen
        && !selectedPlace && !addMode && !searchFocused && !favPageOpen && !mobileAccountOpen && !mobileMoreOpen;
    useEffect(() => {
        if (!canAutoOnboard || readOnboardingSeen()) return undefined;
        let timer = 0;
        // 其他浮层（登录框、分享链接打开的地点卡片、展会面板等）都关闭后，地图静置片刻再出现
        const schedule = (list) => {
            window.clearTimeout(timer);
            if (!list.length) timer = window.setTimeout(showOnboarding, 900);
        };
        schedule(getOverlayEntries());
        const unsubscribe = subscribeOverlays(schedule);
        return () => {
            window.clearTimeout(timer);
            unsubscribe();
        };
    }, [canAutoOnboard]);
    useEffect(() => {
        if (!mapReady || !onboardingRequestId || handledOnboardingRequest.current === onboardingRequestId) return;
        handledOnboardingRequest.current = onboardingRequestId;
        openOnboarding();
    }, [onboardingRequestId, mapReady]);
    // 离开地图页（例如从应用链接打开别的页面）时收起，不算看过
    useEffect(() => {
        if (!chromeOwner) setOnboardingOpen(false);
    }, [chromeOwner]);

    // 文本变化若不是原生刚回传的输入，就是网页自己改写的（选中建议、清空、分享链接等）：递增版本号让原生覆盖输入框。
    // 按队列比对而不是只比最新值：快速输入时较早一次渲染的提交可能晚于下一次回传。
    useEffect(() => {
        const pending = pendingNativeTextsRef.current;
        const index = pending.indexOf(searchTerm);
        if (index >= 0) {
            pending.splice(0, index + 1);
            return;
        }
        pending.length = 0;
        setSearchTextVersion((version) => version + 1);
    }, [searchTerm]);

    // 有进行中的搜索（例如分享链接定位到地点）时保持展开，否则搜索结果留在地图上却无处清除
    useEffect(() => {
        if (compactSearch && !searchExpanded && (searchTerm.trim() || Array.isArray(searchResults))) {
            setSearchExpanded(true);
        }
    }, [compactSearch, searchExpanded, searchTerm, searchResults]);

    // 展开时点地图：收起搜索结果与键盘，方便查看地图上的结果
    useEffect(() => {
        const el = containerRef?.current;
        if (!compactSearch || !searchExpanded || !el) return undefined;
        const onPointerDown = () => {
            setSearchResultsVisible(false);
            if (nativeChrome) {
                if (searchFocused) requestNativeSearchFocus(false);
            } else if (document.activeElement === inputRef.current) {
                inputRef.current.blur();
            }
        };
        el.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
        return () => el.removeEventListener('pointerdown', onPointerDown, { capture: true });
    }, [compactSearch, searchExpanded, nativeChrome, searchFocused]);

    useEffect(() => () => window.clearTimeout(webBlurTimerRef.current), []);

    useEffect(() => {
        if (!isAuthenticated) setMobileAccountOpen(false);
    }, [isAuthenticated]);

    const stabilizeMobileSearchViewport = () => {
        if (!isNarrow) return;
        const anchorViewport = () => {
            // Mobile browsers may scroll the layout viewport while revealing the keyboard.
            // The map is a fixed app surface, so always keep that viewport anchored at zero.
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
        };
        window.requestAnimationFrame(anchorViewport);
        window.setTimeout(anchorViewport, 250);
    };

    // 当外部通过 searchResetKey 信号要求关闭搜索建议面板时（如分享链接跳转），
    // 收起下拉建议让搜索框呈现"已提交"的外观
    useEffect(() => {
        if (searchResetKey > 0) {
            setSearchResultsVisible(false);
            // 外部清空了搜索（开始添加地点、顺路吃等）：收回工具栏
            if (!searchTerm) {
                setSearchExpanded(false);
                setWebSearchEditing(false);
            }
        }
    }, [searchResetKey]);

    // Keep the search bar centered in wide mode.
    useLayoutEffect(() => {
        if (isNarrow) return;
        const searchEl = searchBarRef.current;
        if (!searchEl) return;

        const updatePosition = () => {
            searchEl.style.left = '50%';
            searchEl.style.transform = 'translateX(-50%)';
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        return () => window.removeEventListener('resize', updatePosition);
    }, [isNarrow, pickerMode]);

    useEffect(() => {
        if (!selectedPlace) {
            setNavPickerOpen(false);
            setShareOpen(false);
        }
    }, [selectedPlace]);

    // 按地点身份计时：同一地点的字段更新（例如评价汇总刷新）不重新触发防误触
    const selectedPlaceKey = selectedPlace ? placeKey(selectedPlace) : null;
    useLayoutEffect(() => {
        if (!selectedPlaceKey) {
            popupOpenedAtRef.current = 0;
            return;
        }
        popupOpenedAtRef.current = window.performance.now();
    }, [selectedPlaceKey]);

    // 原生展会面板第一段时地图仍可点选：选中另一个地点就收起展会面板，让地点卡片出现
    const exhibitionOpenRef = useRef(exhibitionOpen);
    exhibitionOpenRef.current = exhibitionOpen;
    useEffect(() => {
        if (selectedPlaceKey && exhibitionOpenRef.current) onCloseExhibition?.();
    }, [selectedPlaceKey]);

    const handlePopupButtonClickCapture = (event) => {
        const button = event.target.closest?.('button');
        if (!button || !event.currentTarget.contains(button)) return;
        const elapsed = window.performance.now() - popupOpenedAtRef.current;
        if (popupOpenedAtRef.current && elapsed < POPUP_GHOST_CLICK_GUARD_MS) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
    };

    const { results: spResults, loading: spLoading } = useSearchPanel(searchTerm, mapRef, backendUrl, mapReady, places);

    // Close detail and rating panels if popup closes
    useEffect(() => {
        if (!selectedPlace) {
            setDetailOpen(false);
            setRatingOpen(false);
        }
    }, [selectedPlace]);

    // search bar stays open by default — collapse behaviors removed

    // Load favorites when panel opens
    useEffect(() => {
        if (!favPageOpen) return;
        if (!isAuthenticated || !token) return;
        let active = true;
        setFavLoading(true);
        setFavError('');
        (async () => {
            try {
                const rows = await fetchFavorites(backendUrl, token);
                if (active) setFavItems(rows || []);
            } catch (e) {
                if (active) setFavError(t('map:ui.loadFavoritesFailed', { message: e.message || e }));
            } finally {
                if (active) setFavLoading(false);
            }
        })();
        return () => { active = false; };
    }, [favPageOpen, isAuthenticated, token, backendUrl]);

    const FAVORITE_LOCATION_ZOOM_LEVEL = 16;

    const navigateToPlace = (longitude, latitude) => {
        if (!longitude || !latitude || !mapRef?.current) return;
        if (typeof onProgrammaticMapMove === 'function') {
            onProgrammaticMapMove();
        }
        mapRef.current.setCenter([longitude, latitude]);
        mapRef.current.setZoom(FAVORITE_LOCATION_ZOOM_LEVEL);
    };

    const hexToRgba = (hex, a = 1) => {
        try {
            let h = (hex || '').replace('#', '');
            if (h.length === 3) h = h.split('').map(c => c + c).join('');
            const bigint = parseInt(h, 16);
            const r = (bigint >> 16) & 255;
            const g = (bigint >> 8) & 255;
            const b = bigint & 255;
            return `rgba(${r},${g},${b},${a})`;
        } catch (e) {
            return `rgba(0,0,0,${a})`;
        }
    };

    const hasSubmittedSearch = Array.isArray(searchResults);
    const searchButtonLabel = hasSubmittedSearch
        ? (searchResultsVisible ? t('map:ui.collapseResults') : t('map:ui.expandResults'))
        : (tipText || t('common:action.search'));
    const searchButtonIconColor = pickContrastTextColor(customThemeColor);

    const handleSearchButtonClick = () => {
        if (hasSubmittedSearch) {
            setSearchResultsVisible((visible) => !visible);
            return;
        }
        submitSearch(searchTerm);
    };

    const handleClearSearchInput = () => {
        feedback?.beginSearch();
        setSearchTerm('');
        setSearchResultsVisible(false);
        clearSearch();
        if (inputRef.current) inputRef.current.focus();
    };

    const handleSelectSpItem = (item, event) => {
        feedback?.record('click', 'search', item.id, {card_id:event?.currentTarget?.dataset.feedbackCard});
        setSearchTerm(item.name || item.address);
        setSearchResultsVisible(false);
        if (compactSearch) {
            // 选中后收起键盘，地点卡片接管底部
            if (nativeChrome) requestNativeSearchFocus(false);
            else blurWebSearch();
        }
        if (onSelectSuggestion) {
            onSelectSuggestion(item);
        }
        if (mapRef?.current && item.longitude && item.latitude) {
            if (typeof onProgrammaticMapMove === 'function') {
                onProgrammaticMapMove();
            }
            mapRef.current.setCenter([item.longitude, item.latitude]);
            mapRef.current.setZoom(16);
        }
    };

    const renderSpSection = (title, items, hasMore, onMore) => {
        if (!items || items.length === 0) return null;
        return (
            <div style={{ marginBottom: 12 }}>
                <div style={{ padding: '4px 12px', fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{title}</span>
                    {hasMore && onMore && (
                        <span onClick={onMore} style={{ cursor: 'pointer', color: customThemeSecondary || customThemeColor }}>{t('map:ui.seeMore')}</span>
                    )}
                </div>
                {items.map((item, rank) => {
                    const isAmapResult = item.isMarked === false;
                    return (
                        <Exposure feedback={feedback} placeId={item.id} surface="search" rank={rank}
                            key={item.id}
                            onClick={(event) => handleSelectSpItem(item,event)}
                            style={{
                                padding: '8px 12px',
                                cursor: 'pointer',
                                borderBottom: '1px solid var(--color-border)',
                                display: 'flex',
                                flexDirection: 'column',
                                background: isAmapResult ? 'var(--theme-secondary-0-12)' : 'transparent'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--color-bg-overlay)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = isAmapResult ? 'var(--theme-secondary-0-12)' : 'transparent'}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                                <span style={{ fontSize: 14, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{item.name}</span>
                                {isAmapResult && (
                                    <span style={{
                                        flexShrink: 0,
                                        padding: '1px 6px',
                                        borderRadius: 999,
                                        border: '1px solid var(--theme-secondary)',
                                        background: 'var(--color-bg-surface)',
                                        color: 'var(--theme-secondary)',
                                        fontSize: 10,
                                        fontWeight: 700
                                    }}>{t('map:ui.nav.amap')}</span>
                                )}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, paddingRight: 8 }}>
                                    {item.address || item.category || item.description || ''}
                                </span>
                                {Number.isFinite(item.dist) && (
                                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                        {tx('map:ui.distance', { distance: item.dist < 1000 ? t('map:ui.metersShort', { dist: Math.round(item.dist) }) : t('map:ui.kilometersShort', { dist: (item.dist / 1000).toFixed(1) }) })}
                                    </span>
                                )}
                            </div>
                        </Exposure>
                    );
                })}
            </div>
        );
    };

    const renderAiRecommendations = () => {
        const recommendations = (Array.isArray(aiRecommendations) ? aiRecommendations : [])
            .filter((recommendation) => recommendation?.place)
            .slice(0, 3);
        return recommendations.map((recommendation, index) => {
            const place = recommendation.place;
            const matchPercent = Number.isFinite(Number(recommendation.match_percent))
                ? Math.round(Number(recommendation.match_percent))
                : Math.round((Number(recommendation.score) || 0) * 100);
            const distanceKm = recommendation.distance_km == null ? Number.NaN : Number(recommendation.distance_km);
            const distanceText = Number.isFinite(distanceKm)
                ? (distanceKm < 1 ? t('map:ui.fromCenterMeters', { distance: Math.round(distanceKm * 1000) }) : t('map:ui.fromCenterKilometers', { distance: distanceKm.toFixed(1) }))
                : '';
            return (
                <Exposure feedback={feedback} placeId={place.id} surface="search" rank={index}
                    key={`ai-recommendation-${place.id ?? index}`}
                    onClick={(event) => handleSelectSpItem(place,event)}
                    style={{
                        margin: `${index === 0 ? 10 : 0}px 10px 12px`,
                        padding: 12,
                        cursor: 'pointer',
                        borderRadius: 12,
                        border: '1px solid var(--theme-primary)',
                        background: 'var(--color-bg-surface)',
                        boxShadow: '0 0 8px var(--theme-primary-0-25)',
                        animation: 'yuyuko-card-in 200ms ease-out both',
                        animationDelay: `${index * 60}ms`
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-primary)', fontWeight: 700, fontSize: 13 }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--theme-icon)' }}>restaurant_menu</span>
                            {tx('map:ui.recommendTitle', { counter: recommendations.length > 1 ? ` ${index + 1}/${recommendations.length}` : '' })}
                        </div>
                        <span style={{
                            color: 'var(--color-text-primary)',
                            background: 'var(--theme-secondary-0-12)',
                            border: '1px solid var(--theme-secondary)',
                            borderRadius: 999,
                            padding: '2px 7px',
                            fontSize: 12,
                            fontWeight: 700,
                            whiteSpace: 'nowrap'
                        }}>{tx('map:ui.matchPercent', { matchPercent })}</span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>{place.name}</div>
                    {(place.category || place.per_person_cost || distanceText) && (
                        <div style={{ marginTop: 3, color: 'var(--color-text-secondary)', fontSize: 12 }}>
                            {[place.category, place.per_person_cost ? t('map:ui.perPersonAbout', { per_person_cost: place.per_person_cost }) : '', distanceText].filter(Boolean).join(' · ')}
                        </div>
                    )}
                    <div style={{ marginTop: 8, color: 'var(--color-text-primary)', fontSize: 13, lineHeight: 1.55 }}>
                        {recommendation.reason}
                    </div>
                </Exposure>
            );
        });
    };

    const handlePickPlace = () => {
        if (!selectedPlace) return;
        if (isPosterPicker && selectedPlaceAlreadyPicked) {
            if (typeof onRemovePickedPlace === 'function') onRemovePickedPlace(selectedPlace);
        } else if (typeof onPickPlace === 'function') {
            onPickPlace(selectedPlace);
        }
        if (typeof closePopup === 'function') closePopup();
    };

    const openDetailPanel = () => {
        setDetailOpen(true);
    };

    const getPopupDescriptionPreview = (place) => {
        const raw = String(place?.description || '').replace(/\s+/g, ' ').trim();
        if (!raw) return { text: '', hasMore: false };
        const limit = 80;
        if (raw.length <= limit) return { text: raw, hasMore: false };
        return { text: `${raw.slice(0, limit).trimEnd()}…`, hasMore: true };
    };

    // 搜索结果下拉：窄屏搜索框在底部，结果向上展开
    const searchDropdownPreset = getPreset('dropdown', { ...motionFlags, opensUp: isNarrow });

    // 小卡上的评价摘要：档位词带颜色、分数、人数；登录后附带按口味加权与自己的评价。点开评价面板
    const renderRatingRow = () => {
        const tier = tierForAverage(ratingSummary.average);
        return (
            <button
                type="button"
                onClick={openRating}
                aria-label={t('map:rating.card.openLabel', { summary: summaryText(ratingSummary) })}
                className="fm-pressable"
                style={{
                    marginTop: 8, width: '100%', minHeight: 40, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6,
                    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'transparent',
                    color: 'var(--color-text-primary)', fontSize: 13, textAlign: 'left', cursor: 'pointer', touchAction: 'manipulation'
                }}
            >
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20, flexShrink: 0, color: tier ? tier.tone : 'var(--color-text-muted)' }}>{tier ? tier.icon : 'rate_review'}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 2, alignItems: 'baseline' }}>
                    <span style={{ whiteSpace: 'nowrap' }}>
                        {ratingSummary.count > 0
                            ? tx('map:rating.card.summary', {
                                tier: <strong style={{ color: tier.tone }}>{tierLabel(tier)}</strong>,
                                average: formatAverage(ratingSummary.average),
                                count: ratingSummary.count
                            })
                            : t('map:rating.summary.none')}
                    </span>
                    {personalizedRating && (
                        <span style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                            {t('map:rating.card.personalized', { average: formatAverage(personalizedRating.average) })}
                        </span>
                    )}
                </span>
                <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: myRatingTier ? myRatingTier.tone : 'var(--theme-primary)' }}>
                    {myRatingTier ? t('map:rating.card.mine', { tier: tierLabel(myRatingTier) }) : t('map:rating.card.rateNow')}
                </span>
                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18, flexShrink: 0, color: 'var(--color-text-muted)' }}>chevron_right</span>
            </button>
        );
    };

    // 地点卡片内容：宽屏卡片与窄屏底部面板共用
    const renderPlaceCard = (inSheet) => (
        <div
            ref={popupRef}
            onClickCapture={handlePopupButtonClickCapture}
            style={inSheet
                ? { padding: '2px 16px 14px', color: 'var(--color-text-primary)' }
                : { background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)', padding: 10, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-surface)', minWidth: 200, width: 'min(92vw, 320px)', maxWidth: 'min(92vw, 320px)', boxSizing: 'border-box' }}
        >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>{selectedPlace.name}</strong>
                {!hideNonSearchButtons && (
                    <Button onClick={closePopup} style={{ padding: "2px 8px", borderRadius: 'var(--radius-sm)', border: "none", background: "transparent", cursor: "pointer", fontSize: 18, lineHeight: 1, color: 'var(--color-text-secondary)' }} title={t('common:action.close')}>×</Button>
                )}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                {(() => {
                    const { text, hasMore } = getPopupDescriptionPreview(selectedPlace);
                    return (
                        <>
                            <span>{text}</span>
                            {hasMore && !pickerMode && (
                                <span
                                    onClick={openDetailPanel}
                                    style={{ marginLeft: 4, color: 'var(--color-text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                    title={t('map:ui.card.seeMoreTitle')}
                                >
                                    {t('map:ui.card.seeMore')}
                                </span>
                            )}
                        </>
                    );
                })()}
            </div>
            <div style={{ marginTop: 6, color: 'var(--color-text-secondary)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>{tx('map:ui.card.category', { category: selectedPlace.category || "-" })}</span>
                {selectedPlace.per_person_cost != null && <span>{tx('map:ui.perPersonCost', { per_person_cost: selectedPlace.per_person_cost })}</span>}
            </div>

            {ratingPlaceId != null && renderRatingRow()}

            {!pickerMode && (
                <div style={{ marginTop: 8, color: 'var(--color-text-muted)', fontSize: 12 }}>
                    {tx('map:ui.lastModified', { modifier: getLastModifierText(selectedPlace) })}
                </div>
            )}
            {!pickerMode && diaryCount > 0 && (
                <button
                    type="button"
                    onClick={openDiaries}
                    style={{ marginTop: 6, padding: 0, border: 0, background: 'transparent', color: 'var(--theme-primary)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
                >
                    {tx('map:ui.diaryCount', { diaryCount })}
                </button>
            )}

            {pickerMode ? (
                <div style={{ marginTop: 10, textAlign: 'right' }}>
                    {!hideNonSearchButtons && (
                        <Button
                            onClick={handlePickPlace}
                            aria-label={isPosterPicker && selectedPlaceAlreadyPicked ? t('map:ui.card.unpick') : t('map:ui.card.pick')}
                            style={{
                                ...(isPosterPicker && selectedPlaceAlreadyPicked ? { background: 'var(--color-danger)' } : {}),
                                color: isPosterPicker && selectedPlaceAlreadyPicked ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                border: 0
                            }}
                        >
                            {isPosterPicker && selectedPlaceAlreadyPicked ? t('map:ui.card.unpickShort') : t('map:ui.card.pick')}
                        </Button>
                    )}
                </div>
            ) : (
                !hideNonSearchButtons && (
                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Tooltip text={hasNavigationTarget ? t('map:ui.card.navigateTooltip') : t('map:ui.card.noCoordinates')}>
                            <Button
                                onClick={handleNavigate}
                                disabled={!hasNavigationTarget}
                                aria-label={t('map:ui.card.navigateLabel')}
                                style={popupActionButtonStyle}
                            >
                                <span className="material-symbols-outlined" style={popupActionIconStyle}>near_me</span>
                                <span style={popupActionLabelStyle}>{t('map:ui.nav.title')}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip text={t('map:ui.card.share')}>
                            <Button
                                onClick={() => setShareOpen(true)}
                                aria-label={t('map:ui.card.share')}
                                style={popupActionButtonStyle}
                            >
                                <span className="material-symbols-outlined" style={popupActionIconStyle}>
                                    share
                                </span>
                                <span style={popupActionLabelStyle}>{t('map:ui.share.title')}</span>
                            </Button>
                        </Tooltip>
                        {/* 评论功能暂不开放，待敏感词机制完善后再开放 */}
                        { /*<Tooltip text="在这里留下你的评论">
                        <Button onClick={openCommentPanel} style={{ background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)', padding: '6px 10px', borderRadius: 'var(--radius-sm)' }}>评论</Button>
                    </Tooltip>
                    <span style={{ padding: 4 }}></span> */ }
                        {selectedPlace.isMarked !== false && (
                            <Tooltip text={favoriteIds && favoriteIds.has(selectedPlace.id) ? t('map:ui.card.favoritedTooltip') : (isAuthenticated ? t('map:ui.card.favoriteTooltip') : t('map:ui.card.loginToFavorite'))}>
                                <Button
                                    onClick={() => onToggleFavorite && onToggleFavorite(selectedPlace)}
                                    disabled={favoriteLoading}
                                    aria-label={favoriteIds && favoriteIds.has(selectedPlace.id) ? t('map:ui.card.unfavoriteLabel') : t('map:ui.card.favoriteLabel')}
                                    aria-pressed={favoriteIds && favoriteIds.has(selectedPlace.id)}
                                    style={{ ...popupActionButtonStyle, color: favoriteIds && favoriteIds.has(selectedPlace.id) ? 'var(--color-primary)' : popupActionButtonStyle.color }}
                                >
                                    <span className="material-symbols-outlined" style={popupActionIconStyle}>
                                        {favoriteIds && favoriteIds.has(selectedPlace.id) ? 'heart_minus' : 'heart_plus'}
                                    </span>
                                </Button>
                            </Tooltip>
                        )}
                        <Tooltip text={selectedPlace.isMarked === false ? t('map:ui.card.create') : t('map:ui.card.manage')}>
                            {selectedPlace.isMarked === false ? (
                                <Button onClick={openCreateFromPoi} aria-label={t('map:ui.card.create')} style={popupActionButtonStyle}>
                                    <span className="material-symbols-outlined" style={popupActionIconStyle}>add_circle</span>
                                </Button>
                            ) : (
                                <Button onClick={openManagePanel} aria-label={t('map:ui.card.editLabel')} style={popupActionButtonStyle}>
                                    <span className="material-symbols-outlined" style={popupActionIconStyle}>edit</span>
                                </Button>
                            )}
                        </Tooltip>
                        <Tooltip text={t('map:ui.card.detailsTooltip')}>
                            <Button onClick={() => { setDetailFocus(null); setDetailOpen(true); }} aria-label={t('map:ui.card.detailsLabel')} style={popupActionButtonStyle}>
                                <span className="material-symbols-outlined" style={popupActionIconStyle}>more_horiz</span>
                            </Button>
                        </Tooltip>
                    </div>
                )
            )}
        </div>
    );

    // 搜索建议与结果：placement 决定相对输入框的位置（窄屏向上展开）
    const renderSearchDropdown = (placement) => (
        <AnimatePresence>
        {searchTerm && searchResultsVisible && (aiThinking || aiRecommendations.length > 0 || Array.isArray(searchResults) || spLoading || Array.isArray(spResults)) && (
            <ScrollableView
                key="search-results"
                className="fm-search-results"
                as={motion.div}
                initial={searchDropdownPreset.initial}
                animate={searchDropdownPreset.animate}
                exit={searchDropdownPreset.exit}
                style={{
                position: 'absolute',
                overscrollBehavior: 'contain',
                transformOrigin: isNarrow ? '50% 100%' : '50% 0%',
                background: 'var(--color-bg-surface)',
                borderRadius: 'var(--radius-md)',
                boxShadow: `0 4px 12px ${hexToRgba(customThemeColor, 0.2)}`,
                border: `1px solid ${dark ? 'var(--color-border)' : hexToRgba(customThemeColor, 0.5)}`,
                zIndex: 2002,
                display: 'flex',
                flexDirection: 'column',
                color: 'var(--color-text-primary)',
                ...placement
            }}>
                {aiThinking && (
                    <div style={{
                        padding: '10px 12px 6px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        color: 'var(--color-text-secondary)',
                        fontSize: 12,
                        fontWeight: 700
                    }}>
                        <span className="material-symbols-outlined" style={{
                            color: 'var(--theme-icon)',
                            fontSize: 18,
                            animation: 'yuyuko-thinking-spin 1s linear infinite'
                        }}>progress_activity</span>
                        {t('map:ui.search.loadingFun')}
                    </div>
                )}
                {renderAiRecommendations()}
                {(() => {
                    const baseResults = Array.isArray(searchResults) ? searchResults : spResults;
                    const recommendedIds = new Set(aiRecommendations.map((recommendation) => String(recommendation?.place?.id)));
                    const visibleResults = Array.isArray(baseResults)
                        ? baseResults.filter((place) => !recommendedIds.has(String(place.id)))
                        : [];
                    const siteResults = visibleResults.filter((place) => place.isMarked !== false);
                    const amapResults = unmarkedExternalPlaces(externalSearch.results, [...(places || []), ...siteResults], currentMapCenter(mapRef));
                    if (!Array.isArray(baseResults) && spLoading) {
                        return <div style={{ padding: 12, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>{t('map:ui.search.loading')}</div>;
                    }
                    return (
                        <>
                            {renderSpSection(t('map:ui.search.sitePlaces'), siteResults, false, null)}
                            {renderSpSection(t('map:ui.search.amapResults'), amapResults, false, null)}
                            {!visibleResults.length && !amapResults.length && !aiThinking && aiRecommendations.length === 0 && !spLoading && (
                                <div style={{ padding: 12, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>{t('map:ui.search.noResults')}</div>
                            )}
                            {!aiThinking && aiRecommendations.length === 0 && !Array.isArray(searchResults) && Array.isArray(spResults) && !spLoading && (
                                <div style={{ padding: '10px 12px 12px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 12 }}>
                                    {compactSearch ? t('map:ui.search.aiHintMobile') : t('map:ui.search.aiHint')}
                                </div>
                            )}
                            <div style={{ padding: '10px 12px 12px', borderTop: '1px solid var(--color-border)' }}>
                                {externalSearch.error && <p role="alert" style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{externalSearch.error}</p>}
                                {externalSearch.loaded && !amapResults.length && <p role="status" style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--color-text-muted)' }}>{t('map:ui.search.externalEmpty')}</p>}
                                <Button type="button" onClick={searchUnlistedPlaces}
                                    disabled={!mapReady || externalSearch.loading || externalSearch.loaded}
                                    aria-busy={externalSearch.loading}
                                    style={{ width: '100%', textAlign: 'center', padding: '10px 12px', color: 'var(--color-primary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}>
                                    {externalSearch.loading ? t('map:ui.search.externalLoading') : externalSearch.loaded ? t('map:ui.search.externalLoaded') : externalSearch.error ? t('map:ui.search.externalRetry') : t('map:ui.search.findUnlisted')}
                                </Button>
                                {!externalSearch.loaded && !externalSearch.loading && <p style={{ margin: '6px 0 0', textAlign: 'center', fontSize: 12, color: 'var(--color-text-muted)' }}>{t('map:ui.search.externalHint')}</p>}
                            </div>
                        </>
                    );
                })()}
            </ScrollableView>
        )}
        </AnimatePresence>
    );

    // 结果列表最多占到页眉下方：键盘弹出时 --app-height 随 WebView 缩小
    const compactDropdownMaxHeight = (bottomPx) => `min(60vh, calc(var(--app-height, 100vh) - var(--safe-top, 0px) - ${bottomPx + 88}px))`;

    // iOS App 窄屏搜索。原生控件：输入框在原生层，网页只渲染其上方的结果；
    // 网页控件：与原生同样的布局——工具栏位置换成输入框，输入中头像位置换成“收起键盘”。
    const renderCompactSearch = () => {
        if (nativeChrome) {
            const bottom = chrome.bottomOccupied + 8;
            return (
                <div className="fm-map-search" style={{ position: 'absolute', zIndex: 2000, left: 12, right: 12, bottom, height: 0 }}>
                    {renderSearchDropdown({ left: 0, right: 0, bottom: 0, maxHeight: compactDropdownMaxHeight(bottom) })}
                </div>
            );
        }
        if (!searchExpanded) return null;
        const editing = webSearchEditing;
        return (
            <div data-map-search-bar data-map-occluder="" className="fm-compact-search" style={{ position: 'absolute', zIndex: 2050, left: 12, right: 76, bottom: aboveBottomInset(4), height: 60 }}>
                {!editing && (
                    <button type="button" className="fm-compact-search__back fm-pressable" onClick={closeCompactSearch} aria-label={t('map:ui.search.exit')}>
                        <span className="material-symbols-outlined" aria-hidden="true">arrow_back_ios_new</span>
                    </button>
                )}
                <div className="fm-compact-search__field" style={{ left: editing ? 0 : 62 }}>
                    <span className="material-symbols-outlined fm-compact-search__icon" aria-hidden="true">search</span>
                    <input
                        ref={inputRef}
                        className="fm-compact-search__input"
                        aria-label={t('map:ui.search.label')}
                        enterKeyHint="search"
                        placeholder={t('map:ui.searchPlaceholderShort')}
                        value={searchTerm}
                        disabled={!mapReady}
                        onFocus={() => {
                            window.clearTimeout(webBlurTimerRef.current);
                            setSearchFocused(true);
                            setWebSearchEditing(true);
                            if (searchTerm.trim()) setSearchResultsVisible(true);
                            stabilizeMobileSearchViewport();
                        }}
                        onBlur={() => {
                            setSearchFocused(false);
                            window.clearTimeout(webBlurTimerRef.current);
                            webBlurTimerRef.current = window.setTimeout(() => setWebSearchEditing(false), 180);
                        }}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        onKeyDown={(e) => {
                            // 输入法组字时的回车只是确认候选词
                            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                            e.preventDefault();
                            submitSearch(searchTerm);
                            blurWebSearch();
                        }}
                    />
                    {searching ? (
                        <span className="material-symbols-outlined fm-compact-search__trailing" role="status" aria-label={t('map:ui.search.searching')} style={{ animation: 'yuyuko-thinking-spin 1s linear infinite' }}>progress_activity</span>
                    ) : searchTerm ? (
                        <button
                            type="button"
                            className="fm-compact-search__trailing"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={handleClearSearchInput}
                            aria-label={t('map:ui.search.clear')}
                        >
                            <span className="material-symbols-outlined" aria-hidden="true">cancel</span>
                        </button>
                    ) : null}
                </div>
                {renderSearchDropdown({ left: 0, right: -64, bottom: 68, maxHeight: compactDropdownMaxHeight(68) })}
            </div>
        );
    };

    return (
        <div className="fm-map-root" style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
            {/* iOS App 中底图延伸到状态栏下方（见 overlay.css .fm-map-canvas），其余界面仍在安全区内 */}
            <div ref={containerRef} id="map" className="fm-map-canvas" style={{ width: "100%", height: "100%", position: "relative" }}></div>
            {/* 状态栏区域登记为遮挡：地图居中、聚合展开时避开它（网页中高度为 0，不生效） */}
            <div className="fm-statusbar-occluder" data-map-occluder="" aria-hidden="true" />

            {pickerMode && (
                <Notice title={pickerTitle || (isPosterPicker ? t('map:ui.picker.posterTitle', { count: normalizedPickedPlaces.length }) : t('map:ui.picker.dinnerTitle'))} tone="warning"
                    style={isNarrow ? undefined : { top: 64, width: 'min(560px, calc(100% - 140px))' }}>
                    {canPickPoint && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                            <span>{t('map:ui.picker.hint')}</span>
                            <Button onClick={pickCenterPoint} disabled={!mapReady} style={{ border: 0, padding: '4px 12px' }}>{t('map:ui.picker.useCenter')}</Button>
                        </div>
                    )}
                </Notice>
            )}
            {canPickPoint && (
                <span aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -100%)', zIndex: 1500, pointerEvents: 'none', fontSize: 34, lineHeight: 1, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' }}>📍</span>
            )}

            {compactSearch && renderCompactSearch()}

            {!compactSearch && <div ref={searchBarRef} data-map-search-bar data-tour="search" className="fm-map-search" style={(() => {
                const base = { position: "absolute", zIndex: 2000 };
                if (isNarrow) {
                    return {
                        ...base,
                        left: 12,
                        right: 12,
                        bottom: aboveBottomInset(pickerMode ? 12 : 78),
                        display: 'block'
                    };
                }
                return { ...base, top: 10, left: '50%', transform: 'translateX(-50%)' };
            })()}>
                <div style={{
                    position: 'relative', height: 44, zIndex: 2001,
                    width: isNarrow ? '100%' : 'min(420px, calc(100vw - 104px))'
                }}>
                    <input
                        ref={inputRef}
                        className="fm-map-search__input"
                        aria-label={t('map:ui.search.label')}
                        enterKeyHint="search"
                        placeholder={t('map:ui.searchPlaceholder')}
                        value={searchTerm}
                        onFocus={() => { setSearchFocused(true); stabilizeMobileSearchViewport(); }}
                        onBlur={() => setSearchFocused(false)}
                        onChange={(e) => handleSearchInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                submitSearch(searchTerm);
                            }
                        }}
                        disabled={!mapReady}
                        style={{
                            position: 'absolute',
                            left: 12,
                            top: 0,
                            height: 44,
                            right: 56,
                            boxSizing: 'border-box',
                            padding: '6px 34px 6px 12px',
                            borderRadius: 22,
                            border: `2px solid ${dark ? 'var(--color-border)' : customThemeColor}`,
                            background: 'var(--color-bg-overlay)',
                            color: 'var(--color-text-primary)',
                            outline: 'none',
                            boxShadow: `0 4px 12px ${hexToRgba(customThemeColor, 0.2)}, 0 0 8px ${hexToRgba(customThemeColor, 0.25)}`,
                            zIndex: 2002
                        }}
                    />

                    {searchTerm && (
                        <Button
                            onClick={handleClearSearchInput}
                            title={t('map:ui.search.clear')}
                            disabled={!mapReady}
                            style={{
                                position: 'absolute',
                                right: 64,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                width: 20,
                                height: 20,
                                borderRadius: '50%',
                                border: 'none',
                                padding: 0,
                                minWidth: 20,
                                fontSize: 18,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'transparent',
                                color: 'var(--color-text-secondary)',
                                cursor: !mapReady ? 'not-allowed' : 'pointer',
                                opacity: !mapReady ? 0.55 : 1,
                                zIndex: 2003
                            }}
                        >
                            ×
                        </Button>
                    )}

                    {renderSearchDropdown({ ...(isNarrow ? { bottom: 48 } : { top: 48 }), right: 0, width: '100%', maxHeight: '60vh' })}

                    <div style={{ position: 'absolute', right: 0, top: 0 }}>
                        <Tooltip text={searchButtonLabel} placement="top">
                            <Button
                                onClick={handleSearchButtonClick}
                                className="fm-map-search__submit"
                                disabled={!mapReady || !searchTerm.trim()}
                                aria-label={searchButtonLabel}
                                style={{
                                    width: 44,
                                    height: 44,
                                    padding: 0,
                                    borderRadius: '50%',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: customThemeColor,
                                    color: searchButtonIconColor,
                                    border: 'none',
                                    boxShadow: `0 4px 12px ${hexToRgba(customThemeColor, 0.2)}`,
                                    transition: 'background 180ms ease, transform 220ms ease',
                                    cursor: (!mapReady || authPending) ? 'not-allowed' : 'pointer',
                                    opacity: (!mapReady || authPending) ? 0.6 : 1
                                }}
                            >
                                {searching ? (
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 36 }}>progress_activity</span>
                                ) : hasSubmittedSearch ? (
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 32 }}>
                                        {searchResultsVisible ? 'expand_less' : 'expand_more'}
                                    </span>
                                ) : (
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 32 }}>search</span>
                                )}
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            </div>}

            <AlongRoutePanel
                open={alongRouteOpen}
                onClose={closeAlongRoute}
                mapRef={mapRef}
                backendUrl={backendUrl}
                customThemeColor={customThemeColor}
                customThemeSecondary={customThemeSecondary}
                isNarrow={isNarrow}
                placement={desktopHeaderMenu === 'more' ? 'right' : 'left'}
                mapReady={mapReady}
                onResults={onAlongRouteResults}
                onSelectPlace={onSelectAlongRoutePlace}
            />

            {!pickerMode && <ExhibitionPanel
                open={exhibitionOpen && !nativeChrome}
                exhibition={exhibition}
                backendUrl={backendUrl}
                onClose={() => onCloseExhibition?.()}
                onRandomNearby={openExhibitionRandom}
            />}

            {!pickerMode && <RandomFoodPanel
                open={randomFoodOpen}
                origin={randomFoodOrigin}
                feedback={feedback}
                mapRef={mapRef} backendUrl={backendUrl} isNarrow={isNarrow}
                token={isAuthenticated ? token : null}
                placement={desktopHeaderMenu === 'more' ? 'left' : 'right'}
                onClose={() => setRandomFoodOpen(false)} onSelectPlace={onSelectRandomPlace}
            />}

            {chromeOwner && <MapOnboarding
                open={onboardingOpen}
                session={onboardingSession}
                steps={onboardingSteps}
                accent={customThemeColor}
                onAccent={pickContrastTextColor(customThemeColor)}
                onClose={closeOnboarding}
            />}

            {!hideNonSearchButtons && isNarrow && !pickerMode && !nativeChrome && !(compactSearch && searchExpanded) && (
                <div style={{ position: 'absolute', right: 12, bottom: aboveBottomInset(compactSearch ? 78 : 130), zIndex: 2000 }}>
                    <Tooltip text={locating ? t('map:ui.locating') : t('map:ui.locateTooltip')} placement="top">
                        <div style={{ display: 'inline-block' }}>
                            <Button
                                data-tour="locate"
                                onClick={handleLocateMe}
                                disabled={!mapReady || locating}
                                aria-label={locating ? t('map:ui.locatingLabel') : t('map:ui.locateLabel')}
                                style={{
                                    width: 44,
                                    height: 44,
                                    padding: 0,
                                    borderRadius: '50%',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: locating ? 'var(--color-success)' : customThemeColor,
                                    color: locating ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                    border: 'none',
                                    boxShadow: `0 4px 12px ${hexToRgba(customThemeColor, 0.2)}`,
                                    opacity: (!mapReady || locating) ? 0.65 : 1
                                }}
                            >
                                <span className="material-symbols-outlined" style={{ fontSize: 26 }}>
                                    {locating ? 'my_location' : 'location_searching'}
                                </span>
                            </Button>
                        </div>
                    </Tooltip>
                </div>
            )}

            {!hideNonSearchButtons && pickerMode && !iosApp && (
                <div ref={dinnerBtnRef} style={{ position: "absolute", left: 16, bottom: isNarrow ? 68 : 12, zIndex: 2000 }}>
                    <Tooltip text={isPosterPicker ? t('map:ui.picker.backToPoster') : pickerContext === 'manage' ? t('map:manage.backToEdit') : pickerContext === 'journey' ? t('map:ui.picker.backToDiary') : pickerContext === 'exhibition' ? t('map:ui.picker.backToExhibition') : t('map:ui.picker.backToDinner')} placement="top">
                        <div style={{ display: "inline-block" }}>
                            <Button
                                onClick={onPickerClose}
                                aria-label={t('common:action.back')}
                                style={{
                                    width: 64,
                                    height: 64,
                                    padding: 0,
                                    borderRadius: '50%',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: customThemeColor,
                                    color: '#FFFFFF',
                                    border: 'none',
                                    boxShadow: `0 4px 12px ${hexToRgba(customThemeColor, 0.2)}`,
                                    transition: 'background 180ms ease, transform 220ms ease',
                                    cursor: 'pointer'
                                }}
                            >
                                <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 36 }}>
                                    arrow_back
                                </span>
                            </Button>
                        </div>
                    </Tooltip>
                </div>
            )}

            {!hideNonSearchButtons && (!isNarrow || pickerMode) && (
                <div style={{
                    position: "absolute",
                    ...(desktopHeaderMenu === 'more' ? { left: 8 } : { right: 8 }),
                    top: canPickPoint && isNarrow ? 128 : 72,
                    zIndex: 2000
                }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                        {!pickerMode && (
                            <Tooltip text={alongRouteOpen ? t('map:ui.alongRouteClose') : t('map:ui.alongRouteTooltip')}>
                                <div style={{ display: 'inline-block' }}>
                                    <Button
                                        data-tour="alongRoute"
                                        onClick={() => alongRouteOpen ? setAlongRouteOpen(false) : openAlongRoute()}
                                        disabled={!mapReady}
                                        aria-label={alongRouteOpen ? t('map:ui.alongRouteClose') : t('map:ui.alongRouteOpen')}
                                        aria-pressed={alongRouteOpen}
                                        style={{
                                            width: 44,
                                            height: 44,
                                            padding: 0,
                                            borderRadius: '50%',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: alongRouteOpen ? 'var(--color-primary-active)' : customThemeColor,
                                            color: '#FFFFFF',
                                            border: 'none',
                                            boxShadow: '0 4px 12px var(--color-glow)',
                                            opacity: mapReady ? 1 : 0.6
                                        }}
                                    >
                                        <span className="material-symbols-outlined" style={{ fontSize: 28 }}>route</span>
                                    </Button>
                                </div>
                            </Tooltip>
                        )}

                        {!pickerMode && (
                            <div style={{ display: "inline-block" }}>
                                <Tooltip text={addPlaceTipText}>
                                    <div style={{ display: "inline-block" }}>
                                        <Button
                                            data-tour="add"
                                            onClick={handleToggleAddMode}
                                            disabled={!mapReady || authPending}
                                            aria-label={addPlaceTipText}
                                            style={{
                                                width: 44,
                                                height: 44,
                                                padding: 0,
                                                borderRadius: '50%',
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                background: addMode ? 'var(--color-danger)' : customThemeColor,
                                                color: addMode ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                                border: 'none',
                                                boxShadow: addMode ? '0 4px 12px rgba(217,83,79,0.22)' : '0 4px 12px var(--color-glow)',
                                                transition: 'background 180ms ease, transform 220ms ease',
                                                cursor: (!mapReady || authPending) ? 'not-allowed' : 'pointer',
                                                opacity: (!mapReady || authPending) ? 0.6 : 1
                                            }}
                                        >
                                            <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 36, transform: addMode ? 'rotate(-45deg)' : 'rotate(0deg)', transition: 'transform 220ms ease' }}>add</span>
                                        </Button>
                                    </div>
                                </Tooltip>
                            </div>
                        )}

                        <Tooltip text={authPending ? t('map:ui.authPending') : (favPageOpen ? t('map:ui.closeFavorites') : t('map:ui.openFavorites'))}>
                            <div style={{ display: "inline-block" }}>
                                <Button
                                    data-tour="favorites"
                                    onClick={toggleFavorites}
                                    disabled={!mapReady}
                                    aria-label={favPageOpen ? t('map:ui.closeFavorites') : t('map:ui.openFavorites')}
                                    style={{
                                        width: 44,
                                        height: 44,
                                        padding: 0,
                                        borderRadius: '50%',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: favPageOpen ? 'var(--color-primary-active)' : customThemeColor,
                                        color: favPageOpen ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                        border: 'none',
                                        transition: 'background 180ms ease, transform 220ms ease',
                                        cursor: (!mapReady || authPending) ? 'not-allowed' : 'pointer',
                                        opacity: (!mapReady || authPending) ? 0.6 : 1
                                    }}
                                >
                                    <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 30 }}>favorite</span>
                                </Button>
                            </div>
                        </Tooltip>

                        {isPosterPicker && (
                            <Tooltip text={pickedPageOpen ? t('map:ui.closePicked') : t('map:ui.viewPickedCount', { count: normalizedPickedPlaces.length })}>
                                <div style={{ display: "inline-block" }}>
                                    <Button
                                        onClick={() => {
                                            setPickedPageOpen((open) => !open);
                                            setFavPageOpen(false);
                                        }}
                                        disabled={!mapReady}
                                        aria-label={pickedPageOpen ? t('map:ui.closePicked') : t('map:ui.viewPicked')}
                                        style={{
                                            width: 44,
                                            height: 44,
                                            padding: 0,
                                            borderRadius: '50%',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            position: 'relative',
                                            background: pickedPageOpen ? 'var(--color-primary-active)' : customThemeColor,
                                            color: pickedPageOpen ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                            border: 'none',
                                            transition: 'background 180ms ease, transform 220ms ease',
                                            cursor: !mapReady ? 'not-allowed' : 'pointer',
                                            opacity: !mapReady ? 0.6 : 1
                                        }}
                                    >
                                        <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 29 }}>format_list_numbered</span>
                                        <span style={{
                                            position: 'absolute',
                                            right: -3,
                                            top: -3,
                                            minWidth: 18,
                                            height: 18,
                                            padding: '0 4px',
                                            borderRadius: 'var(--radius-full)',
                                            boxSizing: 'border-box',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'var(--color-bg-surface)',
                                            color: customThemeColor,
                                            border: `1px solid ${customThemeColor}`,
                                            fontSize: 10,
                                            fontWeight: 700
                                        }}>
                                            {normalizedPickedPlaces.length}
                                        </span>
                                    </Button>
                                </div>
                            </Tooltip>
                        )}

                        {!pickerMode && (
                            <Tooltip text={authPending ? t('map:ui.authPending') : t('map:ui.locateTooltip')}>
                                <div style={{ display: "inline-block" }}>
                                    <Button
                                        data-tour="locate"
                                        onClick={handleLocateMe}
                                        disabled={!mapReady || locating}
                                        aria-label={t('map:ui.addAtLocation')}
                                        style={{
                                            width: 44,
                                            height: 44,
                                            padding: 0,
                                            borderRadius: '50%',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: locating ? 'var(--color-success)' : customThemeColor,
                                            color: locating ? 'var(--color-on-emphasis)' : '#FFFFFF',
                                            border: 'none',
                                            transition: 'background 180ms ease, transform 220ms ease',
                                            cursor: (!mapReady || authPending) ? 'not-allowed' : 'pointer',
                                            opacity: (!mapReady || authPending) ? 0.6 : 1
                                        }}
                                    >
                                        {locating ? (
                                            <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 30 }}>my_location</span>
                                        ) : (
                                            <span className="material-symbols-outlined" style={{ display: 'inline-block', fontSize: 30 }}>location_searching</span>
                                        )}
                                    </Button>
                                </div>
                            </Tooltip>
                        )}
                    </div>
                </div>
            )}

            {!hideNonSearchButtons && isNarrow && !pickerMode && (
                <>
                    <ResponsivePanel
                        open={mobileMoreOpen && !nativeChrome}
                        onClose={() => setMobileMoreOpen(false)}
                        title={t('map:ui.moreFeatures')}
                        kind="more-menu"
                        mobile="sheet"
                        desktop="center"
                    >
                        <div role="menu" aria-label={t('map:ui.moreFeatures')} className="fm-menu" style={{ display: 'flex', flexDirection: 'column', padding: '4px 0' }}>
                            {iosApp && <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} disabled={!mapReady} onClick={() => runMobileMoreAction(openAlongRoute)}>
                                {t('map:ui.alongRoute')}
                            </Button>}
                            <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} disabled={!mapReady} onClick={() => runMobileMoreAction(openRandomFood)}>
                                {t('map:ui.randomFood')}
                            </Button>
                            <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} onClick={() => runMobileMoreAction(props.onOpenJourney)}>
                                {t('map:ui.diaryCommunity')}
                            </Button>
                            {isAuthenticated && (
                                <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} onClick={() => runMobileMoreAction(onOpenDinners)}>
                                    {t('map:ui.dinners')}
                                </Button>
                            )}
                            {isAuthenticated && (
                                <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} onClick={() => runMobileMoreAction(onOpenPosterExport)}>
                                    {t('map:ui.posterExport')}
                                </Button>
                            )}
                            {isAdmin && (
                                <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} onClick={() => runMobileMoreAction(onOpenAdmin)}>
                                    {t('map:ui.admin')}
                                </Button>
                            )}
                            <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48 }} onClick={openOnboarding}>
                                {t('map:onboarding.menuEntry')}
                            </Button>
                            <div style={{ marginTop: 4, padding: '10px', borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 12 }}>
                                <div>{tx('map:ui.versionFooter', { version: APP_VERSION })}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, marginTop: 6 }}>
                                    <a
                                        href={ICP_BEIAN_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => setMobileMoreOpen(false)}
                                        style={{ color: 'inherit', textDecoration: 'none' }}
                                    >
                                        {ICP_BEIAN_TEXT}
                                    </a>
                                    <a
                                        href={GONGAN_BEIAN_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => setMobileMoreOpen(false)}
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit', textDecoration: 'none' }}
                                    >
                                        <img src="/ghs.png" alt="" aria-hidden="true" style={{ width: 14, height: 14, objectFit: 'contain' }} />
                                        {GONGAN_BEIAN_TEXT}
                                    </a>
                                </div>
                            </div>
                        </div>
                    </ResponsivePanel>

                    <ResponsivePanel
                        open={isAuthenticated && mobileAccountOpen && !nativeChrome}
                        onClose={() => setMobileAccountOpen(false)}
                        title={currentUser?.username || t('map:ui.defaultUsername')}
                        label={t('map:ui.userMenu')}
                        kind="account-menu"
                        mobile="sheet"
                        desktop="center"
                    >
                        <div role="menu" aria-label={t('map:ui.userMenu')} className="fm-menu" style={{ display: 'flex', flexDirection: 'column', padding: '4px 0 8px' }}>
                            <div style={{ padding: '4px 16px 10px', fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:ui.verified')}</div>
                            <Button themeAware variant="menu" full role="menuitem" style={{ minHeight: 48, padding: '8px 16px' }} onClick={() => runMobileAccountAction(onOpenMine)}>
                                {t('map:ui.accountSettings')}
                            </Button>
                            <div style={{ height: 1, background: 'var(--color-border)' }} />
                            <Button themeAware variant="menu" full role="menuitem" onClick={() => runMobileAccountAction(onLogout)} style={{ minHeight: 48, padding: '8px 16px', color: 'var(--color-danger)' }}>
                                {t('map:ui.logout')}
                            </Button>
                        </div>
                    </ResponsivePanel>

                    {!nativeChrome && !(compactSearch && searchExpanded) && <nav
                        className="fm-map-toolbar"
                        aria-label={t('map:ui.mainActions')}
                        data-hide-when-keyboard=""
                        data-map-occluder=""
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: 2050,
                            minHeight: 66,
                            padding: '4px 6px calc(4px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))',
                            boxSizing: 'border-box',
                            display: 'flex',
                            alignItems: 'stretch',
                            gap: 2,
                            background: 'color-mix(in srgb, var(--color-bg-surface) 94%, transparent)',
                            borderTop: '1px solid var(--color-border)',
                            boxShadow: '0 -6px 20px rgba(18, 16, 22, 0.10)',
                            backdropFilter: 'blur(12px)'
                        }}
                    >
                        <Button data-tour="more" onClick={toggleMobileMore} aria-pressed={mobileMoreOpen} style={{ ...mobileNavButtonStyle, color: mobileMoreOpen ? customThemeColor : mobileNavButtonStyle.color }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>more_horiz</span>
                            <span>{t('common:action.more')}</span>
                        </Button>
                        <Button data-tour="favorites" onClick={toggleFavorites} aria-pressed={favPageOpen} style={{ ...mobileNavButtonStyle, color: favPageOpen ? customThemeColor : mobileNavButtonStyle.color }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>favorite</span>
                            <span>{t('map:ui.favorites')}</span>
                        </Button>
                        <Button
                            data-tour="add"
                            onClick={() => {
                                handleToggleAddMode();
                                setMobileMoreOpen(false);
                                setFavPageOpen(false);
                            }}
                            disabled={!mapReady || authPending}
                            aria-pressed={addMode}
                            style={{ ...mobileNavButtonStyle, color: addMode ? 'var(--color-danger)' : customThemeColor }}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: 27, transform: addMode ? 'rotate(-45deg)' : 'none', transition: 'transform 180ms ease' }}>add_circle</span>
                            <span>{addMode ? t('map:ui.cancelAdd') : t('map:ui.add')}</span>
                        </Button>
                        {iosApp ? <Button
                            data-tour="search"
                            onClick={() => handleChromeAction('search')}
                            disabled={!mapReady}
                            aria-pressed={searchFocused}
                            style={{ ...mobileNavButtonStyle, color: searchFocused ? customThemeColor : mobileNavButtonStyle.color }}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>search</span>
                            <span>{t('common:action.search')}</span>
                        </Button> : <Button
                            data-tour="alongRoute"
                            onClick={() => alongRouteOpen ? setAlongRouteOpen(false) : openAlongRoute()}
                            disabled={!mapReady}
                            aria-pressed={alongRouteOpen}
                            aria-label={alongRouteOpen ? t('map:ui.alongRouteClose') : t('map:ui.alongRouteOpen')}
                            style={{ ...mobileNavButtonStyle, color: alongRouteOpen ? customThemeColor : mobileNavButtonStyle.color }}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>route</span>
                            <span>{t('map:ui.alongRoute')}</span>
                        </Button>}
                        {!iosApp && <Button
                            data-tour="account"
                            onClick={toggleMobileAccount}
                            aria-label={isAuthenticated ? t('map:ui.openUserMenuNamed', { username: currentUser?.username || '' }) : t('map:ui.openLoginEntry')}
                            aria-haspopup={isAuthenticated ? 'menu' : undefined}
                            aria-expanded={isAuthenticated ? mobileAccountOpen : undefined}
                            style={{ ...mobileNavButtonStyle, color: mobileAccountOpen ? customThemeColor : mobileNavButtonStyle.color }}
                        >
                            {isAuthenticated && currentUser ? (
                                <img
                                    src={currentUser.has_avatar ? `${backendUrl}/users/${currentUser.id}/avatar` : (currentUser.avatar || defaultAvatar)}
                                    alt={currentUser.username || t('map:ui.avatarAlt')}
                                    style={{ width: 25, height: 25, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${customThemeColor}` }}
                                />
                            ) : (
                                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>{isAuthenticated ? 'person' : 'login'}</span>
                            )}
                            <span style={{ maxWidth: '64px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {isAuthenticated ? (currentUser?.username || t('map:ui.resident')) : t('map:ui.login')}
                            </span>
                        </Button>}
                    </nav>}
                    {iosApp && !nativeChrome && compactSearch && searchExpanded && webSearchEditing && <button
                        type="button"
                        className="fm-map-account fm-map-account--close fm-pressable"
                        data-map-occluder=""
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={dismissWebSearchKeyboard}
                        aria-label={t('map:ui.dismissKeyboard')}
                    >
                        <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>}
                    {iosApp && !nativeChrome && !(compactSearch && searchExpanded && webSearchEditing) && <button
                        type="button"
                        className="fm-map-account fm-pressable"
                        data-map-occluder=""
                        data-hide-when-keyboard=""
                        data-tour="account"
                        onClick={toggleMobileAccount}
                        aria-label={isAuthenticated ? t('map:ui.openUserMenu') : t('map:ui.login')}
                        aria-expanded={isAuthenticated ? mobileAccountOpen : undefined}
                    >
                        <img
                            src={isAuthenticated && currentUser ? (currentUser.has_avatar ? `${backendUrl}/users/${currentUser.id}/avatar` : (currentUser.avatar || defaultAvatar)) : defaultAvatar}
                            alt=""
                            onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = defaultAvatar; }}
                        />
                    </button>}
                </>
            )}

            {!isNarrow && !pickerMode && (
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: 8,
                        zIndex: 1800,
                        transform: 'translateX(-50%)',
                        padding: '4px 9px',
                        border: '1px solid color-mix(in srgb, var(--color-border) 82%, transparent)',
                        borderRadius: 'var(--radius-full)',
                        background: 'color-mix(in srgb, var(--color-bg-surface) 82%, transparent)',
                        boxShadow: 'var(--shadow-sm)',
                        backdropFilter: 'blur(8px)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 12,
                        lineHeight: 1.4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        whiteSpace: 'nowrap'
                    }}
                >
                    <a
                        href={ICP_BEIAN_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                        {ICP_BEIAN_TEXT}
                    </a>
                    <span aria-hidden="true" style={{ opacity: 0.55 }}>·</span>
                    <a
                        href={GONGAN_BEIAN_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit', textDecoration: 'none' }}
                    >
                        <img src="/ghs.png" alt="" aria-hidden="true" style={{ width: 14, height: 14, objectFit: 'contain' }} />
                        {GONGAN_BEIAN_TEXT}
                    </a>
                </div>
            )}

            {/* 地点卡片：宽屏由地图覆盖物承载、与图标同帧定位；窄屏固定为底部紧凑面板，不再假装跟随地理点 */}
            {layout.sheet ? (
                <ResponsivePanel
                    open={!!selectedPlace && !nativeChrome}
                    onClose={closePopup}
                    modal={false}
                    backdrop={false}
                    mobile="sheet"
                    desktop="center"
                    plain
                    showClose={false}
                    kind="place-card"
                    label={selectedPlace ? t('map:ui.placeIntroNamed', { name: selectedPlace.name }) : t('map:ui.placeIntro')}
                    maxHeight="min(62%, 520px)"
                >
                    {selectedPlace && renderPlaceCard(true)}
                </ResponsivePanel>
            ) : (
                <MapAnchoredCard
                    show={!!selectedPlace && !!mapRef?.current}
                    cardKey={selectedPlace ? (placeKey(selectedPlace) || 'place') : 'none'}
                    map={mapRef?.current}
                    coordinate={selectedPlace ? [Number(selectedPlace.longitude), Number(selectedPlace.latitude)] : null}
                    onClose={closePopup}
                    onAutoPan={onProgrammaticMapMove}
                    label={selectedPlace ? t('map:ui.placeIntroNamed', { name: selectedPlace.name }) : t('map:ui.placeIntro')}
                >
                    {selectedPlace && renderPlaceCard(false)}
                </MapAnchoredCard>
            )}

            {!hideNonSearchButtons && !pickerMode && (
                <ManagePanel
                    open={manageOpen && !!selectedPlace}
                    backendUrl={backendUrl}
                    token={token}
                    selectedPlace={selectedPlace}
                    manageEdit={manageEdit}
                    setManageEdit={setManageEdit}
                    manageSubmitting={manageSubmitting}
                    manageMessage={manageMessage}
                    canDirectManage={canDirectManage}
                    onClose={onManageClose}
                    onSave={onManageSave}
                    onDelete={onManageDelete}
                    onSubmitRequest={onManageSubmitRequest}
                    onPickPosition={onManagePickPosition}
                />
            )}

            <ResponsivePanel
                open={navPickerOpen && !!selectedPlace}
                onClose={() => setNavPickerOpen(false)}
                title={t('map:ui.nav.chooseApp')}
                kind="nav-picker"
                desktop="center"
                mobile="sheet"
                width="min(420px, 92vw)"
            >
                <div style={{ padding: 14 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                        {tx('map:ui.nav.goingTo', { name: selectedPlace?.name || t('map:ui.thisPlace') })}
                    </div>
                    <div role="menu" className="fm-menu" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {navigationTargets.map((target) => (
                            <Button
                                key={target.id}
                                role="menuitem"
                                onClick={() => {
                                    setNavPickerOpen(false);
                                    openNavigationTarget(target);
                                }}
                                style={{ background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)', padding: '10px 12px', minHeight: 44, borderRadius: 'var(--radius-sm)', textAlign: 'left' }}
                                full
                            >
                                {target.name}
                            </Button>
                        ))}
                    </div>
                </div>
            </ResponsivePanel>

            <ResponsivePanel
                open={shareOpen && !!selectedPlace}
                onClose={() => setShareOpen(false)}
                title={t('map:ui.share.panelTitle')}
                kind="share"
                desktop="center"
                mobile="sheet"
                width="min(420px, 92vw)"
            >
                {selectedPlace && (
                    <div style={{ padding: 14 }}>
                        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                            {tx('map:ui.share.sharing', { name: selectedPlace.name || t('map:ui.thisPlace') })}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {/* 选项1: 分享到 QQ/微信 */}
                            <ShareOptionButton
                                icon="share"
                                label={t('map:ui.share.qqWechat')}
                                description={t('map:ui.share.qqWechatHint')}
                                onClick={() => handleSharePlace('place')}
                                dark={dark}
                            />

                            {/* 选项2: 复制地点信息到剪贴板 */}
                            <ShareOptionButton
                                icon="content_copy"
                                label={t('map:ui.share.copyInfo')}
                                description={t('map:ui.share.copyInfoHint')}
                                onClick={async () => {
                                    const record = recordSelectedPlaceBehavior;
                                    setShareOpen(false);
                                    const info = await buildPlaceClipboardText(selectedPlace, backendUrl);
                                    const result = await copyPlaceContent({ text: info, copy: copyToClipboard, record, channel: 'place_info' });
                                    if (result === 'copied' && showTip) showTip(t('map:ui.share.infoCopied'));
                                }}
                                dark={dark}
                            />

                            {/* 选项3: 分享高德导航链接 */}
                            <ShareOptionButton
                                icon="navigation"
                                label={t('map:ui.share.amapLink')}
                                description={t('map:ui.share.amapLinkHint')}
                                onClick={() => handleSharePlace('amap')}
                                dark={dark}
                            />

                            {/* 选项4: 生成以地图为中心的图片卡片 */}
                            <ShareOptionButton
                                icon="image"
                                label={t('map:ui.share.cardOption')}
                                description={t('map:ui.share.cardOptionHint')}
                                onClick={openShareCard}
                                dark={dark}
                            />
                        </div>
                    </div>
                )}
            </ResponsivePanel>

            <ResponsivePanel
                open={shareCard.visible}
                onClose={shareCard.close}
                title={t('map:ui.share.cardPanelTitle')}
                kind="share-card"
                desktop="center"
                mobile="center"
                width="min(440px, 92vw)"
            >
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {[
                            ['portrait', t('map:ui.share.cardPortrait')],
                            ['landscape', t('map:ui.share.cardLandscape')]
                        ].map(([key, label]) => {
                            const active = shareCard.orientation === key;
                            return (
                                <div key={key} style={{ flex: 1 }}>
                                    <Button
                                        full
                                        onClick={() => shareCard.switchTo(key)}
                                        disabled={shareCard.busy}
                                        aria-pressed={active}
                                        style={{
                                            background: active ? 'var(--theme-primary)' : 'transparent',
                                            color: active ? pickContrastTextColor(getThemeColor()) : 'var(--color-text-primary)',
                                            border: '1px solid var(--color-border)'
                                        }}
                                    >
                                        {label}
                                    </Button>
                                </div>
                            );
                        })}
                    </div>

                    <div style={{ minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                        {shareCard.busy && t('map:ui.share.cardGenerating')}
                        {!shareCard.busy && shareCard.failed && (
                            <span style={{ color: 'var(--color-danger)' }}>{t('map:ui.share.cardFailed')}</span>
                        )}
                        {!shareCard.busy && !shareCard.failed && shareCard.view && (
                            <img
                                src={shareCard.view.url}
                                alt={t('map:ui.share.cardPreviewAlt', { name: shareCard.view.name })}
                                style={{ maxWidth: '100%', maxHeight: '54vh', borderRadius: 10, display: 'block' }}
                            />
                        )}
                    </div>

                    {!shareCard.busy && shareCard.failed && (
                        <Button full onClick={shareCard.retry}>{t('map:ui.share.cardRetry')}</Button>
                    )}

                    <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <Button full onClick={shareCard.share} disabled={!shareCard.view || shareCard.busy}>
                                {t('map:ui.share.cardShare')}
                            </Button>
                        </div>
                        <div style={{ flex: 1 }}>
                            <Button full onClick={shareCard.save} disabled={!shareCard.view || shareCard.busy}>
                                {t('map:ui.share.cardSave')}
                            </Button>
                        </div>
                    </div>
                </div>
            </ResponsivePanel>

            <ResponsivePanel
                open={!hideNonSearchButtons && !pickerMode && !!addingPos}
                onClose={onAddCancel}
                title={t('map:ui.addPlace')}
                kind="add-place"
                desktop="center"
                mobile="sheet"
                width="min(520px, calc(100vw - 24px))"
                bodyStyle={{ padding: 12 }}
            >
                {addingPos && (
                    <AddForm backendUrl={backendUrl} token={token} defaultPos={addingPos} onCancel={onAddCancel} onSubmit={onAddSubmit} defaultName={addingPrefill?.name} defaultCategory={addingPrefill?.category} defaultDescription={addingPrefill?.description} defaultAddress={addingPrefill?.address} />
                )}
            </ResponsivePanel>

            {!hideNonSearchButtons && !pickerMode && (
                <>
                    <PlaceDetailPanel open={detailOpen && !!selectedPlace} place={selectedPlace} focus={detailFocus} backendUrl={backendUrl} onClose={() => setDetailOpen(false)} onNavigate={handleNavigate}
                        rating={ratingPlaceId != null ? { summary: ratingSummary, mine: myRatingTier } : null} onOpenRating={openRating} />
                    <PlaceRatingPanel
                        open={ratingOpen && ratingPlaceId != null}
                        onClose={() => setRatingOpen(false)}
                        place={selectedPlace}
                        rating={placeRating}
                        isAuthenticated={isAuthenticated}
                        banned={!!currentUser?.is_banned}
                        onRequireAuth={onRequireAuth}
                        showTip={showTip}
                    />
                </>
            )}

            {/* 最大缩放下仍重合的地点：成员列表保证每家店都能访问 */}
            <ResponsivePanel
                open={!!clusterMembers}
                onClose={() => onCloseClusterMembers && onCloseClusterMembers()}
                title={clusterMembers ? t('map:ui.clusterTitle', { count: clusterMembers.places.length }) : ''}
                kind="cluster-members"
                desktop="center"
                mobile="sheet"
                width="min(400px, calc(100vw - 24px))"
                maxHeight="min(70%, 560px)"
            >
                {clusterMembers && (
                    <div role="list">
                        {clusterMembers.places.map((place) => (
                            <button
                                key={placeKey(place)}
                                type="button"
                                role="listitem"
                                className="fm-pressable"
                                onClick={() => onSelectClusterMember && onSelectClusterMember(place)}
                                style={{
                                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%',
                                    padding: '11px 16px', minHeight: 48, border: 0, borderBottom: '1px solid var(--color-border)',
                                    background: 'transparent', color: 'var(--color-text-primary)', textAlign: 'left', cursor: 'pointer',
                                    transition: 'background-color 120ms ease, transform 120ms ease'
                                }}
                            >
                                <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere', color: isAvoidedPlace(place) ? 'var(--color-danger)' : undefined }}>{place.name || t('common:label.unnamedPlace')}</span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{place.category || t('common:label.uncategorized')}{place.per_person_cost != null ? t('common:label.perPersonCost', { per_person_cost: place.per_person_cost }) : ''}</span>
                            </button>
                        ))}
                    </div>
                )}
            </ResponsivePanel>

            <MapPanel
                open={!hideNonSearchButtons && favPageOpen && !nativeChrome}
                onClose={() => setFavPageOpen(false)}
                title={t('map:ui.myFavorites')}
                kind="favorites"
                desktopStyle={{ right: 60, top: 72, width: 300, maxHeight: '60vh' }}
            >
                {!isAuthenticated ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                        {t('map:ui.loginToViewFavorites')}
                    </div>
                ) : favLoading ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                        {t('map:ui.search.loading')}
                    </div>
                ) : favError ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-danger)', fontSize: 13 }}>
                        {favError}
                    </div>
                ) : favItems.length === 0 ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                        {t('map:ui.noFavorites')}
                    </div>
                ) : (
                    favItems.map(item => (
                        <div
                            key={item.place_id}
                            onClick={() => {
                                navigateToPlace(item.longitude, item.latitude);
                                setFavPageOpen(false);
                            }}
                            style={{
                                padding: '10px 16px',
                                cursor: (item.longitude && item.latitude) ? 'pointer' : 'default',
                                borderBottom: '1px solid var(--color-border)',
                                display: 'flex',
                                flexDirection: 'column'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--color-bg-overlay)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                            <span style={{ fontSize: 14, color: item.name ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {item.name || t('map:ui.deletedPlace', { place_id: item.place_id })}
                            </span>
                            {item.category && (
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>{item.category}</span>
                            )}
                            {item.name && (!item.longitude || !item.latitude) && (
                                <span style={{ fontSize: 11, color: 'var(--color-warning)', marginTop: 2 }}>{t('map:ui.missingCoordinatesShort')}</span>
                            )}
                        </div>
                    ))
                )}
            </MapPanel>

            <MapPanel
                open={isPosterPicker && pickedPageOpen}
                onClose={() => setPickedPageOpen(false)}
                title={t('map:ui.pickedTitle', { count: normalizedPickedPlaces.length })}
                label={t('map:ui.pickedLabel')}
                kind="picked-places"
                desktopStyle={{ right: 60, top: 8, width: 'min(300px, calc(100vw - 80px))', maxHeight: '60vh' }}
            >
                {normalizedPickedPlaces.length === 0 ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                        {t('map:ui.pickedEmpty')}
                    </div>
                ) : (
                    normalizedPickedPlaces.map((item, index) => (
                        <div
                            key={getPlaceKey(item)}
                            onClick={() => {
                                navigateToPlace(item.longitude, item.latitude);
                                setPickedPageOpen(false);
                            }}
                            style={{
                                padding: '10px 12px 10px 16px',
                                cursor: (item.longitude && item.latitude) ? 'pointer' : 'default',
                                borderBottom: '1px solid var(--color-border)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 9
                            }}
                            onMouseEnter={(event) => { event.currentTarget.style.backgroundColor = 'var(--color-bg-overlay)'; }}
                            onMouseLeave={(event) => { event.currentTarget.style.backgroundColor = 'transparent'; }}
                        >
                            <span style={{
                                width: 24,
                                height: 24,
                                borderRadius: '50%',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                                background: customThemeColor,
                                color: '#FFFFFF',
                                fontSize: 11,
                                fontWeight: 700
                            }}>
                                {index + 1}
                            </span>
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: 14, color: 'var(--color-text-primary)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {item.name || item.address || t('common:label.unnamedPlace')}
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                                    {item.category || t('common:label.uncategorized')}
                                </span>
                            </div>
                            <Button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (typeof onRemovePickedPlace === 'function') onRemovePickedPlace(item);
                                }}
                                aria-label={t('map:ui.removePicked', { name: item.name || item.address || t('map:ui.thisPlaceShort') })}
                                style={{ padding: '3px 7px', background: 'transparent', border: 'none', color: 'var(--color-danger)', fontSize: 12 }}
                            >
                                {t('common:action.remove')}
                            </Button>
                        </div>
                    ))
                )}
            </MapPanel>
        </div>
    );
}
