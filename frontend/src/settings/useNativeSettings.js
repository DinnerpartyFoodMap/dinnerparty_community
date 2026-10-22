import { useEffect, useRef, useState } from 'react';
import { useIsPresent } from 'motion/react';
import { getPlatform, isPluginAvailable } from '../platform/env';
import { createNativeSettingsSession } from '../platform/nativeSettings';
import { getNativeChromeStatus } from '../platform/nativeMapChrome';
import { getMotionPolicy, setMotionPreferences } from '../motion/policy';
import { applyDarkMode, applyThemeColors, resolveThemePrimary, resolveThemeSecondary } from "../theme/theme";
import useDarkMode from "../theme/useDarkMode";
import { readMapSettingsForm, buildMapSettings, saveMapSettings } from './mapSettings';
import { saveUsername, savePassword, uploadAvatar, patchMapSettings } from './accountSettings';
import { readThemeForm, styleOptionsFor, notifyMapStyleChange } from './themeOptions';
import { MOTION_ITEMS, describeNativeChrome } from './MotionSettings';
import { t } from '../i18n/index.js';

// “个性化地图”原生页：初值、动效开关与全部文案都由网页提供（文案走 i18n），原生只负责展示与输入
function buildMapPage(user) {
    const policy = getMotionPolicy();
    return {
        values: readMapSettingsForm(user),
        motion: Object.fromEntries(MOTION_ITEMS.map((item) => [item.key, !!policy.preferences[item.key]])),
        motionItems: MOTION_ITEMS.map(({ key, label, hint }) => ({ key, label, hint })),
        labels: {
            title: t('common:nav.personalizeMap'),
            mapStyle: t('settings:personalizeMap.mapStyleLabel'),
            styleStandard: t('settings:personalizeMap.mapStyle.standard'),
            centerLat: t('settings:personalizeMap.centerLat'),
            centerLng: t('settings:personalizeMap.centerLng'),
            zoom: t('settings:personalizeMap.zoom'),
            save: t('common:action.save'),
            saving: t('settings:common.status.saving'),
            motionTitle: t('settings:motion.title'),
            motionFooter: t('settings:motion.localOnly', { reducedMotion: policy.reducedMotion ? t('settings:motion.reducedMotion') : '' }),
            nativeGlassStatus: describeNativeChrome(getNativeChromeStatus())
        }
    };
}

// 原生设置首页与头像、住民名、通行密码、个性化主题四个子页面的文案
function buildLabels() {
    return {
        title: t('common:nav.accountSettings'),
        backToMap: t('common:action.backToMap'),
        avatar: t('common:label.avatar'),
        mapTitle: t('common:nav.personalizeMap'),
        logoutAll: t('settings:main.logoutAll.title'),
        logoutAllHint: t('settings:main.logoutAll.hint'),
        logoutAllConfirmTitle: t('settings:main.logoutAll.confirmTitle'),
        logoutAllConfirmMessage: t('settings:main.logoutAll.confirmMessage'),
        logoutAllButton: t('settings:main.logoutAll.button'),
        deleteAccount: t('settings:main.deleteAccount.title'),
        deleteAccountHint: t('settings:main.deleteAccount.hint'),
        deleteAccountConfirmTitle: t('settings:main.deleteAccount.confirmTitle'),
        deleteAccountConfirmMessage: t('settings:main.deleteAccount.confirmMessage'),
        deleteAccountButton: t('settings:main.deleteAccount.button'),
        ok: t('common:action.ok'),
        timeout: t('common:error.timeout'),
        saveFailed: t('settings:common.status.saveFailed'),
        save: t('common:action.save'),
        saving: t('settings:common.status.saving'),
        cancel: t('common:action.cancel'),
        avatarTitle: t('common:nav.editAvatar'),
        chooseFromAlbum: t('common:action.chooseFromAlbum'),
        takePhoto: t('common:action.takePhoto'),
        avatarZoom: t('settings:editAvatar.zoom').replace(/[:：]\s*$/, ''),
        avatarSave: t('settings:editAvatar.saveChanges'),
        avatarUploading: t('settings:editAvatar.uploading'),
        avatarUnreadable: t('settings:editAvatar.unreadable'),
        usernameTitle: t('common:nav.editUsername'),
        usernameLabel: t('settings:editUsername.label'),
        passwordTitle: t('common:nav.editPassword'),
        passwordCurrent: t('settings:editPassword.current'),
        passwordNew: t('settings:editPassword.new'),
        passwordConfirm: t('settings:editPassword.confirm'),
        themesTitle: t('common:nav.customThemes'),
        skinsTitle: t('common:nav.skins'),
        darkMode: t('settings:customThemes.darkMode'),
        darkModeHint: t('settings:customThemes.darkModeHint'),
        themeColor: t('settings:customThemes.themeColor'),
        themeColorHint: t('settings:customThemes.themeColorHint'),
        secondaryColor: t('settings:customThemes.secondaryColor'),
        secondaryColorHint: t('settings:customThemes.secondaryColorHint'),
        mapStyleTitle: t('settings:customThemes.mapStyleTitle'),
        mapStyleHint: t('settings:customThemes.mapStyleHint'),
        darkStyleCurrent: t('settings:customThemes.darkStyleCurrent'),
        lightStyleCurrent: t('settings:customThemes.lightStyleCurrent')
    };
}

function buildThemes(user) {
    return { ...readThemeForm(user), styleOptions: { dark: styleOptionsFor(true), light: styleOptionsFor(false) } };
}

function base64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
}

/** 当前安装包能否用原生住民设置（iOS App 且包含插件） */
export function supportsNativeSettings() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeSettings');
}

// disabled：原生设置已经失败过一次（App 已切回网页版设置页），不再重试
export default function useNativeSettings({ user, backendUrl, token, onUpdateUser, actions, disabled = false }) {
    const supported = !disabled && supportsNativeSettings();
    const present = useIsPresent();
    const dark = useDarkMode();
    const [failed, setFailed] = useState(false);
    const latest = useRef({ actions, user, token, onUpdateUser, dark });
    latest.current = { actions, user, token, onUpdateUser, dark };
    // 依赖只保留住民身份：原生页内改住民名、头像、明暗后用户对象会变，重新打开会把正在编辑的原生页收起
    useEffect(() => {
        if (!supported || !present) return undefined;
        let cancelled = false, session;
        const avatarURLOf = (u, bust) => (u?.has_avatar ? `${backendUrl}/users/${u.id}/avatar${bust ? `?t=${Date.now()}` : ''}` : undefined);

        // 原生子页面的请求：账号请求留在网页层，成功后更新应用状态并回传原生需要刷新的字段
        const handleEvent = async (event) => {
            const { user: currentUser, token: currentToken, onUpdateUser: update } = latest.current;
            const commit = (nextUser, nextToken = currentToken) => {
                if (nextUser && typeof update === 'function') update(nextUser, nextToken);
            };
            const { values } = event;
            switch (event.type) {
                case 'motion':
                    setMotionPreferences({ [event.key]: event.value });
                    return { ok: true };
                case 'saveMap': {
                    const built = buildMapSettings(currentUser, values);
                    if (built.error) return { ok: false, message: built.error };
                    const result = await saveMapSettings({ backendUrl, token: currentToken, mapSettings: built.mapSettings });
                    if (result.ok) commit(result.user);
                    return result;
                }
                case 'saveUsername': {
                    const result = await saveUsername({ backendUrl, token: currentToken, username: values.username });
                    if (result.ok && result.user && result.token) commit(result.user, result.token);
                    return { ...result, state: result.ok && result.user ? { username: result.user.username } : undefined };
                }
                case 'savePassword': {
                    const result = await savePassword({ backendUrl, token: currentToken, currentPassword: values.current, newPassword: values.next, confirmPassword: values.confirm });
                    if (result.ok && result.user && result.token) commit(result.user, result.token);
                    return result;
                }
                case 'uploadAvatar': {
                    const result = await uploadAvatar({ backendUrl, token: currentToken, blob: base64ToBlob(values.image, 'image/jpeg') });
                    if (result.ok) commit(result.user);
                    return { ...result, state: result.ok ? { avatarURL: avatarURLOf(result.user, true) } : undefined };
                }
                case 'setDarkMode': {
                    // 与网页主题页一致：先立即切换，再保存
                    applyDarkMode(values.value);
                    const result = await patchMapSettings({ user: currentUser, backendUrl, token: currentToken, patch: { dark_mode: values.value } });
                    if (result.ok) commit(result.user);
                    const settings = (result.user && result.user.map_settings) || result.settings;
                    return { ...result, state: { dark: values.value, primary: resolveThemePrimary(settings), secondary: resolveThemeSecondary(settings) } };
                }
                case 'saveThemeColors': {
                    const result = await patchMapSettings({ user: currentUser, backendUrl, token: currentToken, patch: { theme_color: values.primary || '', theme_color_secondary: values.secondary || '' } });
                    if (!result.ok) return result;
                    commit(result.user);
                    const settings = (result.user && result.user.map_settings) || result.settings;
                    const primary = resolveThemePrimary(settings), secondary = resolveThemeSecondary(settings);
                    try { applyThemeColors(primary, secondary); } catch (e) { /* ignore */ }
                    return { ...result, state: { primary, secondary } };
                }
                case 'setMapStyle': {
                    const allowed = styleOptionsFor(values.which === 'map_style_dark').map((option) => option.id);
                    if (!allowed.includes(values.value)) return { ok: false, message: t('settings:customThemes.saveFailed') };
                    const result = await patchMapSettings({ user: currentUser, backendUrl, token: currentToken, patch: { [values.which]: values.value } });
                    if (!result.ok) return result;
                    commit(result.user);
                    notifyMapStyleChange(result.settings);
                    return { ...result, state: values.which === 'map_style_dark' ? { darkStyle: values.value } : { lightStyle: values.value } };
                }
                default:
                    return { ok: false, message: '' };
            }
        };

        (async () => {
            const { registerPlugin } = await import('@capacitor/core');
            if (cancelled) return;
            const current = latest.current.user;
            session = createNativeSettingsSession(registerPlugin('NativeSettings'), {
                username: current?.username || '', dark: latest.current.dark,
                avatarURL: avatarURLOf(current, false),
                mapPage: buildMapPage(current),
                themes: buildThemes(current),
                labels: buildLabels()
            }, {
                onAction: async action => {
                    if (cancelled) return false;
                    await latest.current.actions[action]?.();
                    // 导航可能被未同步草稿拦住，账号请求也可能失败：原生已收起时始终保留可操作的回退页。
                    if (!cancelled) setFailed(true);
                    return false;
                },
                onEvent: async event => {
                    if (cancelled) return { ok: false, message: '' };
                    try {
                        return await handleEvent(event);
                    } catch (error) {
                        return { ok: false, message: error?.message || t('settings:main.requestFailed', { message: '' }) };
                    }
                },
                onError: () => { if (!cancelled) setFailed(true); }
            });
            await session.start();
        })().catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; session?.stop(); };
    }, [supported, present, user?.id, backendUrl]);
    return supported && !failed;
}
