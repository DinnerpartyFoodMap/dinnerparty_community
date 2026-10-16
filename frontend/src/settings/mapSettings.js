// 个性化地图（样式、默认中心、默认缩放）的读取、校验与保存。网页设置页与 iOS 原生设置页共用，
// 账号请求始终在网页层发出（原生只把表单值交过来）。
import { t } from '../i18n/index.js';

export function storedMapSettings(user) {
    if (user && user.map_settings) return user.map_settings;
    try {
        const raw = localStorage.getItem('map_settings');
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/** 表单初值（均为字符串，未设置时为空）。 */
export function readMapSettingsForm(user) {
    const settings = storedMapSettings(user) || {};
    const center = settings.center && typeof settings.center === 'object' ? settings.center : {};
    return {
        style: settings.style || 'standard',
        lat: typeof center.lat !== 'undefined' ? String(center.lat) : '',
        lng: typeof center.lng !== 'undefined' ? String(center.lng) : '',
        zoom: typeof settings.zoom !== 'undefined' ? String(settings.zoom) : ''
    };
}

/**
 * 校验表单并与已有设置合并（只覆盖表单里的字段）。
 * 经纬度可以都留空；填写时必须成对且为数字。缩放等级可选，取整数。
 * @returns {{ error: string } | { mapSettings: object }}
 */
export function buildMapSettings(user, form) {
    const latStr = String(form.lat || '').trim();
    const lngStr = String(form.lng || '').trim();
    const zoomStr = String(form.zoom || '').trim();

    if ((latStr && !lngStr) || (!latStr && lngStr)) return { error: t('settings:personalizeMap.latLngPair') };

    let center = null;
    if (latStr && lngStr) {
        const centerLat = parseFloat(latStr);
        const centerLng = parseFloat(lngStr);
        if (isNaN(centerLat) || isNaN(centerLng)) return { error: t('settings:personalizeMap.invalidLatLng') };
        center = { lat: centerLat, lng: centerLng };
    }

    let zoom = null;
    if (zoomStr) {
        const parsed = parseInt(zoomStr, 10);
        if (isNaN(parsed)) return { error: t('settings:personalizeMap.invalidZoom') };
        zoom = parsed;
    }

    const mapSettings = { ...(storedMapSettings(user) || {}), style: form.style || 'standard' };
    if (center) mapSettings.center = center;
    else delete mapSettings.center;
    if (zoom !== null) mapSettings.zoom = zoom;
    else delete mapSettings.zoom;
    return { mapSettings };
}

/**
 * 保存：已登录时同步到账号（PATCH /users/me/settings），访客只存本机。
 * @returns {Promise<{ ok: boolean, message: string, user?: object }>}
 */
export async function saveMapSettings({ backendUrl, token, mapSettings }) {
    if (backendUrl && token) {
        const res = await fetch(`${backendUrl}/users/me/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ map_settings: mapSettings })
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const message = (data && data.error)
                ? data.error
                : (text ? (text.trim().startsWith('<') ? t('settings:common.error.serverHttp', { status: res.status }) : text) : t('settings:personalizeMap.saveFailed'));
            return { ok: false, message };
        }
        localStorage.setItem('map_settings', JSON.stringify(mapSettings));
        return { ok: true, message: t('settings:personalizeMap.saved'), user: (data && data.user) || undefined };
    }
    localStorage.setItem('map_settings', JSON.stringify(mapSettings));
    return { ok: true, message: t('settings:personalizeMap.savedLocally') };
}
