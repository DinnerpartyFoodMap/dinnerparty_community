import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import MapView from "../map/MapView";
import MapExhibition, { useCurrentExhibition } from "../map/MapExhibition";
import AdminDashboard from "../admin/AdminDashboard";
import Settings from "../settings/Settings";
import { supportsNativeSettings } from "../settings/useNativeSettings";
import RoutePageShell from "../components/layout/RoutePageShell";
import EditUsername from "../settings/EditUsername";
import EditPassword from "../settings/EditPassword";
import PersonalizeMap from "../settings/PersonalizeMap";
import CustomThemes from "../settings/CustomThemes";
import EditAvatar from "../settings/EditAvatar";
import AuthPanel from "./components/AuthPanel";
import AuthModal from "../auth/components/AuthModal";
import Notice from "../components/feedback/Notice";
import { AuthProvider } from "../auth/AuthContext";
import BanNotice from "../auth/components/BanNotice";
import { TipsProvider } from "../components/feedback/Tips";
import { ConfirmProvider } from "../components/feedback/Confirm";
import { applyDarkMode, applyThemeColors, resolveThemePrimary, resolveThemeSecondary, getSystemPrefersDark, onSystemColorSchemeChange } from "../theme/theme";
import useDarkMode from "../theme/useDarkMode";
import { DinnerCreatePage, DinnerDetailPage, DinnerListPage, isDinnerPath, parseDinnerIdFromPath } from "../dinners/DinnerPages";
import PosterExportPage from "../poster/PosterExportPage";
import { getNoticeColorOption } from "../components/feedback/noticeColors";
import { reportAuthStage } from "../auth/services/authDiagnostics";
import { preserveJourneyBeforeLeave } from "../journey/navigation";
import { getApiBaseUrl } from "../platform/runtimeConfig";
import { getCurrentPath, navigate, canGoBack } from "../platform/navigation";
import { useBackHandler, refreshBackTarget, BACK_PRIORITY } from "../platform/backButton";
import { onAppStateChange } from "../platform/lifecycle";
import { needsRestore, peekToken, restoreToken, saveToken, clearToken, subscribeExternalTokenChanges, decodeTokenPayload } from "../platform/credentialStore";
import { MotionProvider } from "../motion/MotionProvider";
import PageTransition, { navigationDirection } from "../motion/PageTransition";
import { OverlayHost, useOverlayContentRef } from "../components/overlay/OverlayHost";
import { t } from "../i18n/index.js";

// 应用内容框：模态浮层打开时整体 inert（由 OverlayHost 控制）
function AppFrame({ style, children }) {
    const setContentEl = useOverlayContentRef();
    return <div ref={setContentEl} className="fm-app-root" style={style}>{children}</div>;
}

// API 地址统一由 platform/runtimeConfig 解析（网页保持原有回退逻辑，App 必须显式配置 HTTPS 地址）
const BACKEND_URL = getApiBaseUrl();

function currentPathname() {
    return getCurrentPath();
}

function currentSearch() {
    if (typeof window === "undefined") return "";
    return window.location.search || "";
}

// 只有服务端明确拒绝时才清除本地登录态；网络失败保留凭证，稍后重试，避免离线启动被“登出”。
function isAuthRejection(status) {
    return status === 401 || status === 403 || status === 404;
}

export default function App() {
    const [pathname, setPathname] = useState(currentPathname());
    const [routeSearch, setRouteSearch] = useState(currentSearch());
    const pathnameRef = useRef(pathname), navigationSequence = useRef(0);
    pathnameRef.current = pathname;
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(() => peekToken());
    // App 端需要从系统安全存储异步恢复凭证；恢复完成前不判定为“未登录”，避免启动时误弹登录框。
    const [credentialsRestoring, setCredentialsRestoring] = useState(() => needsRestore());
    const [authCheckFailed, setAuthCheckFailed] = useState(false);
    const [authCheckNonce, setAuthCheckNonce] = useState(0);
    // 游客应先看到地图价值；只有主动登录或执行受保护操作时才打开登录框。
    const [showAuth, setShowAuth] = useState(false);
    const [authPanelDisabled, setAuthPanelDisabled] = useState(false);
    const [desktopHeaderMenu, setDesktopHeaderMenu] = useState(null);
    const [randomFoodRequestId, setRandomFoodRequestId] = useState(0);
    const [siteNotice, setSiteNotice] = useState(null);
    const [dismissedNoticeId, setDismissedNoticeId] = useState(() => {
        try {
            return localStorage.getItem('dismissed_notice_id') || '';
        } catch (e) {
            return '';
        }
    });
    const authPanelRef = useRef(null);
    const [mapCovered, setMapCovered] = useState(false);
    // App 内原生住民设置打不开或异常结束：本次停留在 /settings 期间改用网页版设置页
    const [nativeSettingsFailed, setNativeSettingsFailed] = useState(false);
    const lastPathRef = useRef(pathname);
    const pageDirectionRef = useRef('push');
    const siteNoticeRef = useRef(null);
    const [noticeLayout, setNoticeLayout] = useState({ top: 12, banTop: 84 });

    const goPath = useCallback(async (target, { replace = false } = {}) => {
        if (typeof window === "undefined") return;
        const [path, query = ""] = String(target || "/").split("?");
        const search = query ? `?${query}` : "";
        if (getCurrentPath() === path && currentSearch() === search) {
            setPathname(path);
            setRouteSearch(search);
            return;
        }
        const sequence = ++navigationSequence.current;
        if (!await preserveJourneyBeforeLeave() || sequence !== navigationSequence.current) return;
        navigate(`${path}${search}`, { replace });
        setPathname(path);
        setRouteSearch(search);
    }, []);

    const clearAuthState = useCallback(() => {
        setUser(null);
        setToken(null);
        setAuthCheckFailed(false);
        clearToken();
        setShowAuth(false);
    }, []);

    const handleLoginSuccess = useCallback((u, t, requestId) => {
        // Commit the whole authenticated state in one render. In particular,
        // this prevents a protected-page effect from reopening the login modal
        // between closing it and activating the token on iOS Chrome.
        saveToken(t).then((persisted) => {
            if (!persisted) console.warn('登录成功，但未能持久保存登录状态');
        });
        reportAuthStage(BACKEND_URL, requestId, 'state_commit_started');
        flushSync(() => {
            setUser(u);
            setToken(t);
            setAuthCheckFailed(false);
            setCredentialsRestoring(false);
            setShowAuth(false);
        });
        reportAuthStage(BACKEND_URL, requestId, 'state_commit_finished');
    }, []);

    const handleRequireAuth = useCallback(() => {
        // Open login modal but do not navigate away from current path so user can login in-place
        setShowAuth(true);
    }, []);

    const handleAuthClose = useCallback(() => {
        setShowAuth(false);
    }, []);

    const handleLogout = useCallback(async () => {
        if (!await preserveJourneyBeforeLeave()) return;
        if (token) {
            try {
                await fetch(`${BACKEND_URL}/users/logout`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` }
                });
            } catch (e) {
                console.warn("调用 /users/logout 失败，继续清理本地登录态", e);
            }
        }
        // clear auth state and also reset UI theme and map style to defaults
        try {
            // remove any persisted map settings so logged-out view uses defaults
            try { localStorage.removeItem('map_settings'); } catch (e) { }
            // ensure dark mode off and theme color cleared
            try { applyDarkMode(getSystemPrefersDark()); } catch (e) { }
            try { applyThemeColors('', ''); } catch (e) { }
            // inform map to apply light default style
            try { document.dispatchEvent(new CustomEvent('mapstylechange', { detail: { map_style_light: 'amap://styles/normal' } })); } catch (e) { }
        } catch (e) { /* ignore */ }
        clearAuthState();
        goPath("/");
    }, [token, clearAuthState, goPath]);

    useEffect(() => {
        // On mount, apply localStorage fallback theme if present.
        // Otherwise follow system color scheme preference.
        try {
            const raw = localStorage.getItem('map_settings');
            if (raw) {
                const ms = JSON.parse(raw);
                if (ms && typeof ms.dark_mode !== 'undefined') {
                    applyDarkMode(!!ms.dark_mode);
                } else {
                    applyDarkMode(getSystemPrefersDark());
                }
                try {
                    const pageIsDark = document && document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark';
                    const shouldApplyThemeColor = !!token || !!(ms && ms.dark_mode) || pageIsDark;
                    if (shouldApplyThemeColor) {
                        applyThemeColors(resolveThemePrimary(ms), resolveThemeSecondary(ms));
                    }
                } catch (e) { /* ignore */ }
            } else {
                // No saved settings — follow system
                applyDarkMode(getSystemPrefersDark());
                applyThemeColors(resolveThemePrimary(null), resolveThemeSecondary(null));
            }
        } catch (e) { }

        const onPopstate = async () => {
            const next = currentPathname(), nextSearch = currentSearch(), sequence = ++navigationSequence.current;
            const ready = await preserveJourneyBeforeLeave();
            if (sequence !== navigationSequence.current) return;
            if (ready) {
                setPathname(next);
                setRouteSearch(nextSearch);
            }
            else window.history.replaceState(window.history.state, '', pathnameRef.current);
        };
        window.addEventListener("popstate", onPopstate);
        return () => window.removeEventListener("popstate", onPopstate);
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadNotice = async () => {
            try {
                const res = await fetch(`${BACKEND_URL}/notices/current`);
                if (!res.ok) return;
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                setSiteNotice(data && data.notice ? data.notice : null);
            } catch (e) {
                if (!cancelled) {
                    console.warn('Failed to load site notice', e);
                }
            }
        };

        loadNotice();
        const timer = window.setInterval(loadNotice, 30000);
        window.addEventListener('focus', loadNotice);
        const stopLifecycle = onAppStateChange(({ active }) => { if (active) loadNotice(); });

        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener('focus', loadNotice);
            stopLifecycle();
        };
    }, []);

    // Apply dark mode when user or their map_settings change
    useEffect(() => {
        try {
            if (user && user.map_settings) {
                if (typeof user.map_settings.dark_mode !== 'undefined') applyDarkMode(!!user.map_settings.dark_mode);
                applyThemeColors(resolveThemePrimary(user.map_settings), resolveThemeSecondary(user.map_settings));
                return;
            }

            // fallback to localStorage when no user-specific setting
            const raw = localStorage.getItem('map_settings');
            if (raw) {
                const ms = JSON.parse(raw);
                if (ms && typeof ms.dark_mode !== 'undefined') applyDarkMode(!!ms.dark_mode);
                applyThemeColors(resolveThemePrimary(ms), resolveThemeSecondary(ms));
                return;
            }

            // default: follow system color scheme
            applyDarkMode(getSystemPrefersDark());
            applyThemeColors(resolveThemePrimary(null), resolveThemeSecondary(null));
        } catch (e) { /* ignore */ }
    }, [user]);

    // Follow system color scheme changes when user hasn't set an explicit preference
    useEffect(() => {
        const hasExplicitPreference = () => {
            try {
                if (user?.map_settings && typeof user.map_settings.dark_mode !== 'undefined') return true;
                const raw = localStorage.getItem('map_settings');
                if (raw) {
                    const ms = JSON.parse(raw);
                    if (ms && typeof ms.dark_mode !== 'undefined') return true;
                }
            } catch (e) { /* ignore */ }
            return false;
        };

        const cleanup = onSystemColorSchemeChange((isDark) => {
            if (!hasExplicitPreference()) {
                applyDarkMode(isDark);
                // Re-resolve theme colors for the new mode
                let ms = null;
                try {
                    const raw = localStorage.getItem('map_settings');
                    if (raw) ms = JSON.parse(raw);
                } catch (e) { }
                applyThemeColors(resolveThemePrimary(ms), resolveThemeSecondary(ms));
            }
        });
        return cleanup;
    }, [user]);

    useEffect(() => {
        if (typeof document === "undefined" || typeof window === "undefined") return;

        const root = document.documentElement;
        // 稳定高度：同一宽度下出现过的最大可视高度。App 内键盘只会让 WebView 变矮，
        // 底图按这个高度排版（overlay.css），键盘弹出时地图不会因为容器变矮而重新居中、整体上移
        let stableWidth = 0;
        let stableHeight = 0;
        let shrinkTimer = 0;
        const readViewportHeight = () => Math.round(window.visualViewport ? window.visualViewport.height : window.innerHeight);
        const keyboardOpen = () => root.classList.contains("keyboard-open");
        const updateViewportHeight = () => {
            const viewport = window.visualViewport;
            const viewportHeight = viewport ? viewport.height : window.innerHeight;
            const viewportTop = viewport ? viewport.offsetTop : 0;
            const viewportWidth = Math.round(viewport ? viewport.width : window.innerWidth);
            const height = Math.round(viewportHeight);
            if (viewportWidth !== stableWidth) {
                // 旋转或分屏改变了宽度：重新记录
                stableWidth = viewportWidth;
                stableHeight = 0;
            }
            if (height >= stableHeight) {
                stableHeight = height;
            } else if (!keyboardOpen()) {
                // 变矮但键盘没开（分屏、窗口缩放）：稳定一会儿后采用新高度。
                // 键盘收起时类名先于 WebView 恢复被移除，延迟复查可以跳过这段间隙
                window.clearTimeout(shrinkTimer);
                shrinkTimer = window.setTimeout(() => {
                    const latest = readViewportHeight();
                    if (keyboardOpen() || latest >= stableHeight) return;
                    stableHeight = latest;
                    root.style.setProperty("--app-stable-height", `${stableHeight}px`);
                }, 600);
            }
            root.style.setProperty("--app-height", `${height}px`);
            root.style.setProperty("--app-offset-top", `${Math.round(viewportTop)}px`);
            root.style.setProperty("--app-stable-height", `${stableHeight}px`);
        };

        updateViewportHeight();

        const visualViewport = window.visualViewport;
        window.addEventListener("resize", updateViewportHeight);
        window.addEventListener("orientationchange", updateViewportHeight);
        if (visualViewport) {
            visualViewport.addEventListener("resize", updateViewportHeight);
            visualViewport.addEventListener("scroll", updateViewportHeight);
        }

        return () => {
            window.clearTimeout(shrinkTimer);
            window.removeEventListener("resize", updateViewportHeight);
            window.removeEventListener("orientationchange", updateViewportHeight);
            if (visualViewport) {
                visualViewport.removeEventListener("resize", updateViewportHeight);
                visualViewport.removeEventListener("scroll", updateViewportHeight);
            }
        };
    }, []);

    // Sync token across tabs (web only) and refresh user when token changes
    useEffect(() => {
        const onExternalTokenChange = (newToken) => {
            setToken(newToken);
            if (!newToken) {
                // logged out in another tab
                setUser(null);
                setShowAuth(false);
                // reset theme & map style when user logged out in another tab
                try { applyDarkMode(false); } catch (err) { }
                try { applyThemeColors('', ''); } catch (err) { }
                try { document.dispatchEvent(new CustomEvent('mapstylechange', { detail: { map_style_light: 'amap://styles/normal' } })); } catch (err) { }
                if (pathname === '/admin') goPath('/');
                return;
            }
            // fetch /users/me to refresh user info
            (async () => {
                try {
                    const res = await fetch(`${BACKEND_URL}/users/me`, { headers: { Authorization: `Bearer ${newToken}` } });
                    if (!res.ok) {
                        setUser(null);
                        setShowAuth(false);
                        return;
                    }
                    const data = await res.json();
                    if (data && data.user) setUser(data.user);
                } catch (err) {
                    console.warn('Failed to refresh user after storage token change', err);
                    setUser(null);
                    setShowAuth(false);
                }
            })();
        };
        return subscribeExternalTokenChanges(onExternalTokenChange);
    }, [goPath, pathname]);

    // App 启动：从安全存储恢复登录凭证
    useEffect(() => {
        if (!credentialsRestoring) return;
        let cancelled = false;
        restoreToken().then((restored) => {
            if (cancelled) return;
            setToken((current) => current || restored);
            setCredentialsRestoring(false);
        });
        return () => { cancelled = true; };
    }, [credentialsRestoring]);

    useEffect(() => {
        // If we get a token but no user (e.g., on page load), try to fetch /users/me
        if (!token || user) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${BACKEND_URL}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
                if (cancelled) return;
                if (!res.ok) {
                    if (isAuthRejection(res.status)) {
                        // invalid or revoked token, clear
                        clearAuthState();
                    } else {
                        setAuthCheckFailed(true);
                    }
                    return;
                }
                const data = await res.json();
                if (data && data.user) {
                    setUser(data.user);
                    setAuthCheckFailed(false);
                }
            } catch (e) {
                if (cancelled) return;
                // 网络暂时不可用：保留凭证，联网或回到前台后重试
                console.warn("Failed to fetch /users/me; will retry", { url: `${BACKEND_URL}/users/me`, error: e });
                setAuthCheckFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, [token, user, clearAuthState, authCheckNonce]);

    // 校验失败（网络问题）后：联网、回到前台或 15 秒后重试
    useEffect(() => {
        if (!authCheckFailed || !token) return;
        const retry = () => setAuthCheckNonce((n) => n + 1);
        const timer = window.setTimeout(retry, 15000);
        window.addEventListener('online', retry);
        const stop = onAppStateChange(({ active }) => { if (active) retry(); });
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('online', retry);
            stop();
        };
    }, [authCheckFailed, token]);

    // 从后台恢复：重新确认登录状态（其他设备改密码、退出全部设备后在此处感知）
    useEffect(() => {
        if (!token) return;
        return onAppStateChange(async ({ active, backgroundMs }) => {
            if (!active || backgroundMs < 30000) return;
            try {
                const res = await fetch(`${BACKEND_URL}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
                if (isAuthRejection(res.status)) {
                    clearAuthState();
                    return;
                }
                if (res.ok) {
                    const data = await res.json().catch(() => null);
                    if (data && data.user) setUser(data.user);
                }
            } catch (e) { /* 离线时保持现状 */ }
        });
    }, [token, clearAuthState]);

    // 迁移前签发的旧 token（无会话标识）升级为独立设备会话，之后网页与手机登录互不影响
    useEffect(() => {
        if (!token || !user) return;
        const payload = decodeTokenPayload(token);
        if (!payload || payload.sid) return;
        let cancelled = false;
        fetch(`${BACKEND_URL}/users/me/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (cancelled || !data || !data.token || data.token === token) return;
                saveToken(data.token);
                setToken(data.token);
            })
            .catch(() => { /* 下次启动再试 */ });
        return () => { cancelled = true; };
    }, [token, user]);

    useEffect(() => {
        // 限定页面路径（允许 /, /admin, /settings/*, /dinners*, /posters/new）
        if (pathname !== "/" && pathname !== "/admin" && !pathname.startsWith("/settings") && !isDinnerPath(pathname) && pathname !== '/posters/new') {
            goPath("/");
        }
    }, [pathname, goPath]);

    useEffect(() => {
        // 未登录访问受限页面时，弹出登录对话框但不强制跳转，以便用户在页面内登录
        if (credentialsRestoring) return;
        if ((pathname === "/admin" || pathname.startsWith("/settings") || pathname === "/dinners/new" || pathname === '/posters/new') && !token) {
            setShowAuth(true);
            // do not navigate away; allow login modal to appear over these pages
        }
    }, [pathname, token, credentialsRestoring]);

    const isAuth = !!token && !!user;
    const isAdmin = !!(user && user.admin_level);
    const showAdminPage = pathname === "/admin" && !!token;
    const showSettingsBase = pathname === "/settings";
    // App 内原生住民设置：/settings 不渲染网页页面（没有推入动画与“正在打开设置”），地图留在底下，原生页直接从地图上弹起
    const nativeSettingsActive = showSettingsBase && !!user && !nativeSettingsFailed && supportsNativeSettings();
    const showSettingsEdit = pathname === "/settings/username";
    const showSettingsPassword = pathname === "/settings/password";
    const showSettingsPersonalize = pathname === "/settings/personalize";
    const showSettingsThemes = pathname === "/settings/themes";
    const showSettingsAny = typeof pathname === 'string' && pathname.startsWith("/settings");
    const showSettingsAvatar = pathname === "/settings/avatar";
    const showDinnerList = pathname === "/dinners";
    const showDinnerCreate = pathname === "/dinners/new";
    const dinnerId = parseDinnerIdFromPath(pathname);
    const showDinnerDetail = Number.isFinite(dinnerId) && dinnerId > 0;
    const showAnyDinnerPage = showDinnerList || showDinnerCreate || showDinnerDetail;
    const showPosterExport = pathname === '/posters/new';
    const showMapPage = !showAdminPage && !showSettingsAny && !showAnyDinnerPage && !showPosterExport;
    const siteNoticeVisible = !!(siteNotice && String(siteNotice.id) !== String(dismissedNoticeId || ''));
    // 展会：入口在这里（避让公告），面板由地图渲染（iOS 原生控件接管时为原生面板，随机美食以展会地点为中心）
    const exhibition = useCurrentExhibition(BACKEND_URL, showMapPage);
    const [exhibitionOpen, setExhibitionOpen] = useState(false);
    const closeExhibition = useCallback(() => setExhibitionOpen(false), []);
    useEffect(() => {
        if (!exhibition || !showMapPage) setExhibitionOpen(false);
    }, [exhibition, showMapPage]);

    useLayoutEffect(() => {
        if (typeof window === 'undefined') return;

        const updateNoticeLayout = () => {
            const isMobile = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : (window.innerWidth <= 768);
            if (!siteNoticeVisible) {
                setNoticeLayout((prev) => {
                    const nextBanTop = siteNoticeVisible ? 84 : 12;
                    if (prev.top === 12 && prev.banTop === nextBanTop) return prev;
                    return { top: 12, banTop: nextBanTop };
                });
                return;
            }

            const authRect = authPanelRef.current ? authPanelRef.current.getBoundingClientRect() : null;
            const noticeRect = siteNoticeRef.current ? siteNoticeRef.current.getBoundingClientRect() : null;

            let nextTop = 12;
            let nextBanTop = 84;

            if (authRect && noticeRect) {
                const horizontallyOverlaps = noticeRect.right > authRect.left && noticeRect.left < authRect.right;
                const verticallyOverlaps = noticeRect.bottom > authRect.top && noticeRect.top < authRect.bottom;
                if (horizontallyOverlaps && verticallyOverlaps) {
                    nextTop = Math.ceil(authRect.bottom + 8);
                }
            }

            if (siteNoticeRef.current) {
                const noticeHeight = Math.ceil(siteNoticeRef.current.getBoundingClientRect().height || 0);
                nextBanTop = Math.max(84, Math.ceil(nextTop + noticeHeight + 8));
            }

            setNoticeLayout((prev) => {
                if (prev.top === nextTop && prev.banTop === nextBanTop) return prev;
                return { top: nextTop, banTop: nextBanTop };
            });
        };

        updateNoticeLayout();

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => updateNoticeLayout())
            : null;
        if (resizeObserver) {
            if (authPanelRef.current) resizeObserver.observe(authPanelRef.current);
            if (siteNoticeRef.current) resizeObserver.observe(siteNoticeRef.current);
        }

        const onResize = () => updateNoticeLayout();
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onResize);
        }

        return () => {
            if (resizeObserver) resizeObserver.disconnect();
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', onResize);
            }
        };
    }, [siteNoticeVisible, siteNotice, dismissedNoticeId, pathname]);

    const authValue = {
        token,
        setToken: (t) => { setToken(t); saveToken(t); },
        user,
        setUser,
        onRequireAuth: handleRequireAuth
    };

    // 系统返回（Android）：弹层自行登记更高优先级；这里处理页面层级——
    // 先回到应用内上一页，没有历史时回到上级页面，已在首页则交给系统（退到后台）。
    useBackHandler(true, () => {
        if (canGoBack()) {
            window.history.back();
            return true;
        }
        let parent = null;
        if (pathname.startsWith('/settings/')) parent = '/settings';
        else if (pathname === '/dinners/new' || parseDinnerIdFromPath(pathname)) parent = '/dinners';
        else if (pathname !== '/') parent = '/';
        if (!parent) return false;
        goPath(parent, { replace: true });
        return true;
    }, BACK_PRIORITY.PAGE, () => canGoBack() || pathname !== '/');

    // 离开住民设置后重置：下次进入重新尝试原生设置
    useEffect(() => {
        if (pathname !== '/settings') setNativeSettingsFailed(false);
    }, [pathname]);

    // 页面级可返回状态随路径变化：通知 iOS 侧滑是否接管左边缘
    useEffect(() => { refreshBackTarget(); }, [pathname]);

    // 通过应用链接（如分享的地点链接）打开 App 时跳转到对应页面
    useEffect(() => {
        const onOpenPath = (event) => {
            const path = event && event.detail && event.detail.path;
            if (path) goPath(path);
        };
        window.addEventListener('app:open-path', onOpenPath);
        return () => window.removeEventListener('app:open-path', onOpenPath);
    }, [goPath]);

    const dark = useDarkMode();
    const placeholderStyle = { minHeight: "var(--app-height, 100vh)", display: "flex", alignItems: "center", justifyContent: "center", color: 'var(--color-text-primary)', background: 'var(--color-bg-base)' };

    // 当前覆盖在地图之上的页面；null 表示地图页
    const renderPage = () => {
        if (showDinnerList) return (
            <DinnerListPage
                backendUrl={BACKEND_URL}
                onGoCreate={() => {
                    if (!token) {
                        setShowAuth(true);
                        return;
                    }
                    goPath('/dinners/new');
                }}
                onOpenDetail={(id) => goPath(`/dinners/${id}`)}
                onGoHome={() => goPath('/')}
            />
        );

        if (showDinnerCreate) return (
            <DinnerCreatePage
                backendUrl={BACKEND_URL}
                token={token}
                isAuth={isAuth}
                onRequireAuth={() => setShowAuth(true)}
                onCreated={(dinner) => goPath(`/dinners/${dinner.id}`)}
                onBack={() => goPath('/')}
                onMapPickerOpenChange={setAuthPanelDisabled}
            />
        );

        if (showDinnerDetail) return (
            <DinnerDetailPage
                backendUrl={BACKEND_URL}
                dinnerId={dinnerId}
                token={token}
                currentUserId={user && user.id}
                isAdmin={isAdmin}
                onBackList={() => goPath('/dinners')}
                onGoHome={() => goPath('/')}
            />
        );

        if (showPosterExport) return (
            user ? (
                <PosterExportPage
                    backendUrl={BACKEND_URL}
                    token={token}
                    isAuth={isAuth}
                    onRequireAuth={() => setShowAuth(true)}
                    onMapPickerOpenChange={setAuthPanelDisabled}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showAdminPage) return (
            user ? (
                <AdminDashboard
                    user={user}
                    token={token}
                    backendUrl={BACKEND_URL}
                    onBackHome={() => goPath("/")}
                    onLogout={handleLogout}
                    onRequireAuth={handleRequireAuth}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsBase) return nativeSettingsActive ? null : (
            user ? (
                <Settings
                    user={user}
                    onBack={() => goPath("/")}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                    onLogout={handleLogout}
                    onOpenEditAvatar={() => goPath('/settings/avatar')}
                    onOpenEditUsername={() => goPath('/settings/username')}
                    onOpenEditPassword={() => goPath('/settings/password')}
                    onOpenPersonalize={() => goPath('/settings/personalize')}
                    onOpenThemes={() => goPath('/settings/themes')}
                    nativeDisabled={nativeSettingsFailed}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsPassword) return (
            user ? (
                <EditPassword
                    user={user}
                    onBack={() => goPath('/settings')}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsPersonalize) return (
            user ? (
                <PersonalizeMap
                    user={user}
                    onBack={() => goPath('/settings')}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsThemes) return (
            user ? (
                <CustomThemes
                    user={user}
                    onBack={() => goPath('/settings')}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                />
            ) : (
                <div style={placeholderStyle}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsEdit) return (
            user ? (
                <EditUsername
                    user={user}
                    onBack={() => goPath('/settings')}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                />
            ) : (
                <div style={{ minHeight: "var(--app-height, 100vh)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );

        if (showSettingsAvatar) return (
            user ? (
                <EditAvatar
                    user={user}
                    onBack={() => goPath('/settings')}
                    backendUrl={BACKEND_URL}
                    token={token}
                    onUpdateUser={handleLoginSuccess}
                />
            ) : (
                <div style={{ minHeight: "var(--app-height, 100vh)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {t('common:app.verifyingSession')}
                </div>
            )
        );
        return null;
    };
    const pageElement = renderPage();
    const pageKey = pageElement ? pathname : null;
    // 层级方向：更深为 push，更浅为 pop（返回）
    if (lastPathRef.current !== pathname) {
        pageDirectionRef.current = navigationDirection(lastPathRef.current, pathname);
        lastPathRef.current = pathname;
    }
    const pageDirection = pageDirectionRef.current;
    // 主地图常驻：子页面完全进入后才隐藏地图，转场途中地图保持可见
    const mapHidden = !showMapPage && mapCovered;

    return (
        <MotionProvider>
        <OverlayHost>
        <AuthProvider value={authValue}>
            <TipsProvider>
                <ConfirmProvider>
                    <AppFrame style={{
                        // 安全区：App 全屏 WebView 会延伸到状态栏/刘海下方，顶部与左右让出系统区域；
                        // 底部仍由各面板按 env(safe-area-inset-bottom) 自行处理。普通桌面与竖屏 Safari 下这些值为 0。
                        position: 'fixed',
                        left: 'var(--safe-left, 0px)',
                        right: 'var(--safe-right, 0px)',
                        top: 'calc(var(--app-offset-top, 0px) + var(--safe-top, 0px))',
                        height: "calc(var(--app-height, 100vh) - var(--safe-top, 0px))",
                        overflow: 'hidden',
                        overscrollBehavior: 'none'
                    }}>
                        <BanNotice style={siteNoticeVisible ? { top: noticeLayout.banTop + 55 } : undefined} />
                        {siteNoticeVisible && (
                            <Notice
                                ref={siteNoticeRef}
                                title={siteNotice.title}
                                backgroundColor={getNoticeColorOption(siteNotice.color_key).backgroundColor}
                                canClose
                                onClose={() => {
                                    const nextId = String(siteNotice.id);
                                    setDismissedNoticeId(nextId);
                                    try { localStorage.setItem('dismissed_notice_id', nextId); } catch (e) { }
                                }}
                                zIndex={1700}
                                style={{ top: noticeLayout.top + 55, zIndex: 1700 }}
                            >
                                <div style={{ whiteSpace: 'pre-wrap' }}>{siteNotice.content}</div>
                            </Notice>
                        )}
                        {showMapPage && <MapExhibition exhibition={exhibition} open={exhibitionOpen} onOpen={() => setExhibitionOpen(true)}
                            backendUrl={BACKEND_URL} noticeRef={siteNoticeRef} noticeVisible={siteNoticeVisible} noticeTop={noticeLayout.top + 55} />}
                        <div style={{ display: mapHidden ? 'none' : 'block', width: '100%', height: '100%' }} aria-hidden={showMapPage ? undefined : true} inert={showMapPage ? undefined : 'true'}>
                            <MapView
                                backendUrl={BACKEND_URL}
                                routeSearch={routeSearch}
                                token={token}
                                isAuthenticated={isAuth}
                                isAdmin={isAdmin}
                                onRequireAuth={() => setShowAuth(true)}
                                onOpenDinners={() => goPath('/dinners')}
                                onOpenAdmin={() => goPath('/admin')}
                                onOpenPosterExport={() => {
                                    if (!isAuth) {
                                        setShowAuth(true);
                                        return;
                                    }
                                    goPath('/posters/new');
                                }}
                                onOpenMine={() => {
                                    if (!isAuth) {
                                        setShowAuth(true);
                                        return;
                                    }
                                    goPath('/settings');
                                }}
                                onLogout={handleLogout}
                                desktopHeaderMenu={desktopHeaderMenu}
                                randomFoodRequestId={randomFoodRequestId}
                                exhibition={exhibition}
                                exhibitionOpen={exhibitionOpen}
                                onCloseExhibition={closeExhibition}
                                mapPageActive={showMapPage}
                            />
                        </div>

                        <PageTransition pageKey={pageKey} direction={pageDirection} onCoveredChange={setMapCovered}>
                            {pageElement && <RoutePageShell path={pathname} onNavigate={goPath}>{pageElement}</RoutePageShell>}
                        </PageTransition>

                        {/* 原生住民设置：不占网页页面，只负责驱动原生设置页与执行它交回的账号请求 */}
                        {nativeSettingsActive && (
                            <Settings
                                user={user}
                                onBack={() => goPath("/")}
                                backendUrl={BACKEND_URL}
                                token={token}
                                onUpdateUser={handleLoginSuccess}
                                onLogout={handleLogout}
                                onOpenEditAvatar={() => goPath('/settings/avatar')}
                                onOpenEditUsername={() => goPath('/settings/username')}
                                onOpenEditPassword={() => goPath('/settings/password')}
                                onOpenPersonalize={() => goPath('/settings/personalize')}
                                onOpenThemes={() => goPath('/settings/themes')}
                                headless
                                onNativeUnavailable={() => setNativeSettingsFailed(true)}
                            />
                        )}

                        <AuthPanel
                            ref={authPanelRef}
                            user={user}
                            isAuth={isAuth}
                            isAdmin={isAdmin}
                            onLogout={handleLogout}
                            onOpenAuth={() => setShowAuth(true)}
                            onOpenAdmin={() => goPath("/admin")}
                            onOpenSettings={() => goPath("/settings")}
                            onOpenDinners={() => goPath('/dinners')}
                            onOpenPosterExport={() => goPath('/posters/new')}
                            onGoHome={() => goPath("/")}
                            onMenuOpenChange={setDesktopHeaderMenu}
                            onOpenRandomFood={showMapPage ? () => setRandomFoodRequestId((id) => id + 1) : undefined}
                            pathname={pathname}
                            backendUrl={BACKEND_URL}
                            interactionDisabled={authPanelDisabled}
                        />

                        <AuthModal
                            open={showAuth}
                            backendUrl={BACKEND_URL}
                            onLoginSuccess={handleLoginSuccess}
                            onClose={handleAuthClose}
                        />
                    </AppFrame>
                </ConfirmProvider>
            </TipsProvider>
        </AuthProvider>
        </OverlayHost>
        </MotionProvider>
    );
}
