// 原生住民主页的网页侧入口：取 profile、执行屏蔽 / 偏好 / 小组件请求，并把最新视图模型回传原生。
// 同好、角色观察屋和同好里点开的其他住民主页是原生主页里推入的二级页：数据同样由这里读取、整理后回传。
// 调用方负责判断平台与插件可用性；失败时由调用方切回网页 UserProfilePage。
import { useEffect, useRef } from 'react';
import {
    fetchUserProfile,
    saveFavoriteVisibility,
    saveProfileWidgets,
    saveTasteLevel,
    setUserBlocked
} from '../api/client.js';
import { createNativeProfileSession } from '../platform/nativeProfile.js';
import { nativeThemeColors } from '../theme/theme.js';
import { isPluginAvailable, getPlatform } from '../platform/env.js';
import { userReportPrefill } from '../feedback/feedbackTypes.js';
import { saveActiveCompanion } from '../skins/skinApi.js';
import { publishMapConsent, request } from '../journey/feedback';
import { t } from '../i18n/index.js';
import {
    buildProfileViewModel,
    profileBaseLabels,
    profileSelfLevels,
    profileWidgetOptions
} from './profileViewModel.js';
import { buildCompanionViewModel, createCommunityController } from './communityViewModel.js';

/** 当前安装包能否用原生住民主页（iOS App 且包含插件） */
export function supportsNativeProfile() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeProfile');
}

function themeSnapshot(dark, themeColor) {
    const colors = nativeThemeColors();
    return { ...colors, primary: themeColor || colors.primary, dark: !!dark };
}

export default function useNativeProfile({
    userId,
    backendUrl,
    token,
    currentUser,
    dark,
    themeColor,
    companion,
    companionEnabled = true,
    onCompanionUpdate,
    onCompanionEnabledChange,
    onBack,
    onOpenPlace,
    onOpenCommunity,
    onOpenSettings,
    onAction,
    onOpenFeedback,
    onRequireAuth,
    onUnavailable
}) {
    // 会话打开期间可能变化的值：请求处理时读最新的，不重开原生页
    const latest = useRef({});
    latest.current = { token, currentUser, companion, companionEnabled, onCompanionUpdate, onCompanionEnabledChange, onOpenSettings };
    const sessionRef = useRef(null);
    const reloadRef = useRef(null);

    useEffect(() => {
        if (!userId) return undefined;
        let cancelled = false;
        let session = null;
        let profile = null;
        // 页面栈里其他住民的主页（同好点开），按编号保存最近一次读到的数据
        const others = new Map();
        const view = (value) => buildProfileViewModel(value, {
            currentUser: latest.current.currentUser,
            tokenPresent: !!latest.current.token,
            backendUrl,
            labels: profileBaseLabels()
        });
        const fetchProfile = async (id) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                return await fetchUserProfile(backendUrl, id, { token: latest.current.token, signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }
        };
        const loadFailure = (error) => (error?.status === 404 ? profileBaseLabels().notFound : (error?.message || profileBaseLabels().loadFailed));
        const community = createCommunityController({
            backendUrl,
            getToken: () => latest.current.token,
            getUser: () => latest.current.currentUser,
            request,
            publishMapConsent
        });
        const companionView = () => buildCompanionViewModel(latest.current.companion, { enabled: latest.current.companionEnabled });

        // 主页读取失败：原生页留在原地显示原因与“重试”（不再退回网页）
        const loadIntoSession = async () => {
            try {
                profile = await fetchProfile(userId);
                if (!cancelled) session?.update({ profile: view(profile) });
            } catch (error) {
                if (cancelled) return;
                session?.update({ error: String(loadFailure(error)).slice(0, 200) });
            }
        };

        const handleEvent = async (type, values) => {
            if (type === 'reload') {
                loadIntoSession();
                return { ok: true };
            }
            if (type === 'loadProfile') {
                try {
                    const data = await fetchProfile(values.userId);
                    others.set(String(values.userId), data);
                    return { ok: true, profile: view(data) };
                } catch (error) {
                    return { ok: false, message: String(loadFailure(error)).slice(0, 200) };
                }
            }
            if (!latest.current.token) {
                onRequireAuth?.();
                return { ok: false, message: '' };
            }
            const self = !!profile?.relation?.self;
            if (type === 'setTasteLevel') {
                const data = await saveTasteLevel(backendUrl, latest.current.token, values.key, values.level);
                profile = { ...profile, taste: data.taste };
                return { ok: true, profile: view(profile) };
            }
            if (type === 'saveWidgets' && self) {
                await saveProfileWidgets(backendUrl, latest.current.token, values.widgets, values.hiddenWidgets);
                profile = await fetchProfile(userId);
                return { ok: true, profile: view(profile) };
            }
            if (type === 'setCollectionVisibility' && self) {
                const data = await saveFavoriteVisibility(backendUrl, latest.current.token, values.isPublic);
                profile = { ...profile, collection_visibility: data.is_public };
                return { ok: true, profile: view(profile) };
            }
            if (type === 'setBlocked') {
                const target = values.userId ? String(values.userId) : String(userId);
                const nested = target !== String(userId);
                const known = nested ? others.get(target) : profile;
                await setUserBlocked(backendUrl, latest.current.token, target, values.blocked);
                if (values.blocked) onOpenFeedback?.(userReportPrefill(known?.user || { id: target }));
                const data = await fetchProfile(target);
                if (nested) others.set(target, data);
                else profile = data;
                return { ok: true, profile: view(data) };
            }
            // 以下只在自己的主页里出现
            if (!self) return { ok: false, message: '' };
            if (type === 'openSettings') {
                // 住民设置在主页之上打开，主页留在下面；返回时侧滑就能看到主页
                const opened = await latest.current.onOpenSettings?.();
                return { ok: opened !== false };
            }
            if (type === 'loadCommunity') return { ok: true, community: await community.load() };
            if (type === 'loadCommunitySettings') return { ok: true, community: await community.loadSettings() };
            if (type === 'saveCommunitySettings') return { ok: true, community: await community.save(values) };
            if (type === 'clearInteractions') return { ok: true, community: await community.clear() };
            if (type === 'loadCompanion') return { ok: true, companion: companionView() };
            if (type === 'setCompanionEnabled') {
                try {
                    await latest.current.onCompanionEnabledChange?.(values.enabled);
                } catch (error) {
                    return { ok: false, message: error?.message || t('settings:personalizeMap.saveFailed') };
                }
                latest.current = { ...latest.current, companionEnabled: values.enabled };
                return { ok: true, companion: companionView() };
            }
            if (type === 'chooseCompanion') {
                const state = await saveActiveCompanion(backendUrl, latest.current.token, values.id);
                latest.current.onCompanionUpdate?.(state);
                latest.current = { ...latest.current, companion: state };
                return { ok: true, companion: companionView() };
            }
            return { ok: false, message: '' };
        };

        (async () => {
            try {
                const { registerPlugin } = await import('@capacitor/core');
                if (cancelled) return;
                // 不等主页数据：原生页先滑入并显示加载中，数据到了再用 update 补上
                session = createNativeProfileSession(registerPlugin('NativeProfile'), {
                    userId: String(userId),
                    theme: themeSnapshot(dark, themeColor),
                    labels: profileBaseLabels(),
                    loading: true,
                    profile: { labels: profileBaseLabels() },
                    selfLevels: profileSelfLevels(),
                    widgetOptions: profileWidgetOptions()
                }, {
                    onEvent: handleEvent,
                    onBack: () => { if (!cancelled) onBack?.(); },
                    onOpenPlace: (placeId) => { if (!cancelled) onOpenPlace?.(placeId); },
                    // 旧安装包：同好仍是结束主页后打开的网页
                    onOpenCommunity: () => { if (!cancelled && profile?.relation?.self) onOpenCommunity?.(); },
                    onAction: (action, { userId: target } = {}) => {
                        if (cancelled) return;
                        const nested = target && String(target) !== String(userId) ? others.get(String(target)) : null;
                        const owner = nested || profile;
                        if (!owner || owner.relation?.blocked) return;
                        const ownerId = owner.user?.id ?? userId;
                        if (action === 'openFavorites') {
                            if (owner.content?.collection?.length) onAction?.('favorites', ownerId, owner.user?.username);
                        } else if (action === 'my-locations' || (!nested && owner.relation?.self)) {
                            onAction?.(action, ownerId, owner.user?.username);
                        }
                    },
                    onError: () => { if (!cancelled) onUnavailable?.(); }
                });
                sessionRef.current = session;
                reloadRef.current = loadIntoSession;
                const started = session.start();
                loadIntoSession();
                await started;
            } catch (error) {
                if (!cancelled) onUnavailable?.(error);
            }
        })();
        return () => {
            cancelled = true;
            if (sessionRef.current === session) {
                sessionRef.current = null;
                reloadRef.current = null;
            }
            session?.stop();
        };
    }, [userId, backendUrl, token, currentUser?.id]);

    // 主页开着时在住民设置里改了明暗或主题色：主页与二级页跟着换
    const firstTheme = useRef(true);
    useEffect(() => {
        if (firstTheme.current) { firstTheme.current = false; return; }
        sessionRef.current?.update({ theme: themeSnapshot(dark, themeColor) });
    }, [dark, themeColor]);

    // 在叠在主页上的住民设置里改了住民名或头像：返回前把主页重新读一遍
    const identityKey = `${currentUser?.username}:${currentUser?.avatar_url}:${currentUser?.has_avatar}`;
    const firstIdentity = useRef(true);
    useEffect(() => {
        if (firstIdentity.current) { firstIdentity.current = false; return; }
        reloadRef.current?.();
    }, [identityKey]);

    // 小伙伴状态变化（打卡投喂、切换角色、开关观察屋）：观察屋开着时立即刷新
    const companionKey = `${companionEnabled}:${companion?.active}:${companion?.satiety}:${(companion?.owned || []).length}`;
    const firstCompanion = useRef(true);
    useEffect(() => {
        if (firstCompanion.current) { firstCompanion.current = false; return; }
        sessionRef.current?.update({ companion: buildCompanionViewModel(companion, { enabled: companionEnabled }) });
    }, [companionKey]);
}
