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
        const avatarURL = (value) => (value?.user?.has_avatar
            ? `${backendUrl}/users/${encodeURIComponent(value.user.id)}/avatar`
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

        const handleEvent = async (type, values) => {
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
                profile = await load();
                if (cancelled) return;
                const { registerPlugin } = await import('@capacitor/core');
                if (cancelled) return;
                session = createNativeProfileSession(registerPlugin('NativeProfile'), {
                    userId: String(userId),
                    theme: { primary: themeColor || '#E2789F', dark: !!dark },
                    labels: profileBaseLabels(),
                    profile: view(profile),
                    selfLevels: profileSelfLevels(),
                    widgetOptions: profileWidgetOptions()
                }, {
                    onEvent: handleEvent,
                    onBack: () => { if (!cancelled) onBack?.(); },
                    onOpenPlace: (placeId) => { if (!cancelled) onOpenPlace?.(placeId); },
                    onError: () => { if (!cancelled) onUnavailable?.(); }
                });
                await session.start();
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
