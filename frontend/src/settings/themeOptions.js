// 个性化主题的选项与读取（网页主题页与 iOS 原生设置页共用）
import { t } from '../i18n/index.js';
import { getSystemPrefersDark, resolveThemePrimary, resolveThemeSecondary } from "../theme/theme";
import { storedMapSettings } from './mapSettings';

export const STYLE_OPTIONS = [
    { id: 'amap://styles/dark', name: t('settings:customThemes.mapStyle.dark') },
    { id: 'amap://styles/darkblue', name: t('settings:customThemes.mapStyle.darkblue') },
    { id: 'amap://styles/grey', name: t('settings:customThemes.mapStyle.grey') },
    { id: 'amap://styles/default', name: t('settings:customThemes.mapStyle.default') },
    { id: 'amap://styles/light', name: t('settings:customThemes.mapStyle.light') },
    { id: 'amap://styles/normal', name: t('settings:customThemes.mapStyle.normal') },
    { id: 'amap://styles/default', name: t('settings:customThemes.mapStyle.default') }
];

export const DARK_STYLE_IDS = ['amap://styles/dark', 'amap://styles/darkblue', 'amap://styles/grey', 'amap://styles/night'];
// 允许在浅色偏好中也选择“夜间（随昼夜变化）”样式
export const LIGHT_STYLE_IDS = ['amap://styles/light', 'amap://styles/normal', 'amap://styles/default', 'amap://styles/night'];

/** 某个模式下可选的地图样式（去重，保持顺序） */
export function styleOptionsFor(dark) {
    const ids = dark ? DARK_STYLE_IDS : LIGHT_STYLE_IDS;
    const seen = new Set();
    return STYLE_OPTIONS.filter((option) => ids.includes(option.id) && !seen.has(option.id) && seen.add(option.id));
}

/** 当前主题设置（与主题页初值规则一致） */
export function readThemeForm(user) {
    const settings = storedMapSettings(user) || {};
    return {
        dark: typeof settings.dark_mode !== 'undefined' ? !!settings.dark_mode : getSystemPrefersDark(),
        primary: settings.theme_color || resolveThemePrimary(null),
        secondary: settings.theme_color_secondary || resolveThemeSecondary(null),
        darkStyle: settings.map_style_dark || 'amap://styles/dark',
        lightStyle: settings.map_style_light || 'amap://styles/normal'
    };
}

/** 地图样式保存后通知地图立即切换 */
export function notifyMapStyleChange(settings) {
    try {
        const detail = { map_style_dark: (settings && settings.map_style_dark) || '', map_style_light: (settings && settings.map_style_light) || '' };
        document.dispatchEvent(new CustomEvent('mapstylechange', { detail }));
    } catch (e) { /* ignore */ }
}
