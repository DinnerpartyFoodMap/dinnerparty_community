import { resolveResourceUrl } from "../platform/runtimeConfig";
import { isLocationAvailable } from "../platform/geolocation";
import { t } from '../i18n/index.js';

export const DEFAULT_CENTER = [113.394405, 23.016485];
export const DEFAULT_ZOOM = 24;
export const MAP_VIEW_STORAGE_KEY = "yuyuko.map.lastView.v1";
export const MAP_VIEW_SAVE_DEBOUNCE_MS = 450;
export const MIN_CENTER_SAVE_DISTANCE_METERS = 30;
export const MIN_ZOOM_SAVE_DELTA = 0.2;
export const LOCATE_ME_MIN_ZOOM = 18;

// 资源地址与定位可用性统一由平台层处理，这里保留原导出名以兼容现有调用。
export function normalizeImageUrl(value) {
    return resolveResourceUrl(value);
}

/** 地点图片字段（JSON 数组字符串或数组）→ 原样的地址数组；数据损坏时返回空数组，不抛错 */
export function parseImageList(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

export function isLocalhost(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function canUseLocationInCurrentContext() {
    return isLocationAvailable();
}

export function getLocationErrorMessage(errorLike) {
    const info = String(errorLike?.info || "");
    const message = String(errorLike?.message || "");
    const detail = `${info} ${message}`.trim().toUpperCase();

    if (detail.includes("PERMISSION_DENIED") || detail.includes("PERMISSION") || detail.includes("DENIED")) {
        return t('map:utils.location.permissionDenied');
    }
    if (detail.includes("TIME_OUT") || detail.includes("TIMEOUT")) {
        return t('map:utils.location.timeout');
    }
    if (detail.includes("POSITION_UNAVAILABLE") || detail.includes("UNAVAILABLE")) {
        return t('map:utils.location.unavailable');
    }
    if (detail.includes("SECURE") || detail.includes("HTTPS") || detail.includes("INSECURE")) {
        return t('common:error.geolocationInsecure');
    }
    if (message) {
        return t('map:utils.location.failedWithMessage', { message });
    }
    return t('map:utils.location.failed');
}

// 中类只是“中餐厅 / 外国餐厅”时，小类才是具体菜系（四川菜、日本料理……）；
// 其余中类（快餐厅、咖啡厅、糕饼店……）的小类多为品牌名，不适合当分类
const AMAP_CUISINE_GROUPS = new Set(["中餐厅", "外国餐厅"]);
const CATEGORY_MAX_LENGTH = 16;

function categoryLength(value) {
    return Array.from(value).reduce((length, ch) => length + (ch.codePointAt(0) > 0x7f ? 2 : 1), 0);
}

/**
 * 高德 POI 类型（“大类;中类;小类”，多个类型以 | 分隔）→ 一个简短分类。
 * 例：“餐饮服务;中餐厅;广东菜(粤菜)” → “粤菜”，“餐饮服务;快餐厅;肯德基” → “快餐厅”。
 * 取不到合适的分类（或超过 8 个汉字的分类长度上限）时返回空字符串，由用户自己选择。
 */
export function categoryFromAmapType(type) {
    const levels = String(type || "").split("|")[0].split(";").map((part) => part.trim()).filter(Boolean);
    if (!levels.length) return "";
    const [major, middle, minor] = levels;
    let name = middle || major;
    if (minor && minor !== middle && AMAP_CUISINE_GROUPS.has(middle)) name = minor;
    // “广东菜(粤菜)” 取括号里的常用简称
    const alias = /[(（]([^()（）]+)[)）]\s*$/.exec(name);
    if (alias) name = alias[1].trim();
    if (!name || /相关/.test(name) || /[,，]/.test(name) || categoryLength(name) > CATEGORY_MAX_LENGTH) return "";
    return name;
}

export function normalizeLngLat(center) {
    if (!center) return null;
    const lng = typeof center.getLng === "function"
        ? center.getLng()
        : (center.lng ?? (center.lnglat && center.lnglat.lng));
    const lat = typeof center.getLat === "function"
        ? center.getLat()
        : (center.lat ?? (center.latlng && center.latlng.lat));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lng, lat };
}

export function haversineDistanceMeters(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadius = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
    return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

export function readSavedMapView() {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(MAP_VIEW_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const lng = Number(parsed.lng);
        const lat = Number(parsed.lat);
        const zoom = Number(parsed.zoom);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        return {
            lng,
            lat,
            zoom: Number.isFinite(zoom) ? zoom : DEFAULT_ZOOM
        };
    } catch (e) {
        console.warn("读取上次地图视野失败，使用默认值", e);
        return null;
    }
}

export function shouldPersistMapView(prevView, nextView) {
    if (!prevView) return true;
    const zoomDelta = Math.abs((prevView.zoom || 0) - (nextView.zoom || 0));
    if (zoomDelta >= MIN_ZOOM_SAVE_DELTA) return true;
    return haversineDistanceMeters(prevView, nextView) >= MIN_CENTER_SAVE_DISTANCE_METERS;
}
