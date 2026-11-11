// 原生住民主页的网页侧入口：取 profile、执行屏蔽 / 偏好 / 小组件请求，并把最新视图模型回传原生。
// 调用方负责判断平台与插件可用性；失败时由调用方切回网页 UserProfilePage。
import { useEffect } from 'react';
import {
    fetchUserProfile,
    saveProfileWidgets,
    saveTasteLevel,
    setUserBlocked
} from '../api/client.js';
import { createNativeProfileSession } from '../platform/nativeProfile.js';
import { nativeThemeColors } from '../theme/theme.js';
import { isPluginAvailable, getPlatform } from '../platform/env.js';
import { userReportPrefill } from '../feedback/feedbackTypes.js';
import {
    buildProfileViewModel,
    profileBaseLabels,
    profileSelfLevels,
    profileWidgetOptions
} from './profileViewModel.js';

/** 当前安装包能否用原生住民主页（iOS App 且包含插件） */
export function supportsNativeProfile() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeProfile');
}

export default function useNativeProfile({
    userId,
    backendUrl,
    token,
    currentUser,
    dark,
    themeColor,
    onBack,
    onOpenPlace,
    onOpenFeedback,
    onRequireAuth,
    onUnavailable
}) {
    useEffect(() => {
        if (!userId) return undefined;
        let cancelled = false;
        let session = null;
        let profile = null;
        const latest = { token, currentUser, dark };
        // 没有上传头像时用服务器的默认头像（与网页 img/default.png 相同）
        const avatarURL = (value) => (value?.user?.id
            ? `${backendUrl}/users/${encodeURIComponent(value.user.id)}/avatar${value.user.has_avatar ? '' : '?fallback=default'}`
            : '');
        const view = (value) => buildProfileViewModel(value, {
            currentUser: latest.currentUser,
            tokenPresent: !!latest.token,
            avatarURL: avatarURL(value),
            labels: profileBaseLabels()
        });
        const load = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                profile = await fetchUserProfile(backendUrl, userId, { token: latest.token, signal: controller.signal });
                return profile;
            } finally {
                clearTimeout(timer);
            }
        };

        // 主页读取失败：原生页留在原地显示原因与“重试”（不再退回网页）
        const loadIntoSession = async () => {
            try {
                profile = await load();
                if (!cancelled) session?.update({ profile: view(profile) });
            } catch (error) {
                if (cancelled) return;
                const message = error?.status === 404 ? profileBaseLabels().notFound : (error?.message || profileBaseLabels().loadFailed);
                session?.update({ error: String(message).slice(0, 200) });
            }
        };

        const handleEvent = async (type, values) => {
            if (type === 'reload') {
                loadIntoSession();
                return { ok: true };
            }
            if (!latest.token) {
                onRequireAuth?.();
                return { ok: false, message: '' };
            }
            if (type === 'setTasteLevel') {
                const data = await saveTasteLevel(backendUrl, latest.token, values.key, values.level);
                profile = { ...profile, taste: data.taste };
                return { ok: true, profile: view(profile) };
            }
            if (type === 'saveWidgets') {
                await saveProfileWidgets(backendUrl, latest.token, values.widgets);
                profile = await load();
                return { ok: true, profile: view(profile) };
            }
            if (type === 'setBlocked') {
                await setUserBlocked(backendUrl, latest.token, userId, values.blocked);
                if (values.blocked) onOpenFeedback?.(userReportPrefill(profile.user));
                profile = await load();
                return { ok: true, profile: view(profile) };
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
                    theme: { ...nativeThemeColors(), primary: themeColor || nativeThemeColors().primary, dark: !!dark },
                    labels: profileBaseLabels(),
                    loading: true,
                    profile: { labels: profileBaseLabels() },
                    selfLevels: profileSelfLevels(),
                    widgetOptions: profileWidgetOptions()
                }, {
                    onEvent: handleEvent,
                    onBack: () => { if (!cancelled) onBack?.(); },
                    onOpenPlace: (placeId) => { if (!cancelled) onOpenPlace?.(placeId); },
                    onError: () => { if (!cancelled) onUnavailable?.(); }
                });
                const started = session.start();
                loadIntoSession();
                await started;
            } catch (error) {
                if (!cancelled) onUnavailable?.(error);
            }
        })();
        return () => {
            cancelled = true;
            session?.stop();
        };
    }, [userId, backendUrl, token, currentUser?.id]);
}
