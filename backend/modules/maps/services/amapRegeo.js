'use strict';

// 服务端逆地理编码到城市（住民主页的“上次定位在”）。用 AMAP_WEB_SERVICE_KEY；没配置、境外坐标或失败时返回 null。
// 不在高德境内格子里的坐标不发请求（高德在境外查不到城市，只会消耗“海外服务”日配额）。
const { isInAmapChinaRegion } = require('./chinaRegion');

const AMAP_REST_BASE = 'https://restapi.amap.com';
const REQUEST_TIMEOUT_MS = 8000;

function webServiceKey() {
    return String(process.env.AMAP_WEB_SERVICE_KEY || '').trim();
}

/** 高德 addressComponent → 城市名：直辖市的 city 是空数组，用省名 */
function cityFromComponent(component) {
    if (!component || typeof component !== 'object') return null;
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return pick(component.city) || pick(component.province);
}

async function reverseGeocodeCity(lat, lng, { fetchImpl = fetch } = {}) {
    const key = webServiceKey();
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lng) || !isInAmapChinaRegion(lng, lat)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const query = new URLSearchParams({ location: `${lng.toFixed(6)},${lat.toFixed(6)}`, extensions: 'base', key });
        const response = await fetchImpl(`${AMAP_REST_BASE}/v3/geocode/regeo?${query}`, { signal: controller.signal, redirect: 'error' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || String(data.status) !== '1') return null;
        return cityFromComponent(data.regeocode && data.regeocode.addressComponent);
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { cityFromComponent, reverseGeocodeCity };
