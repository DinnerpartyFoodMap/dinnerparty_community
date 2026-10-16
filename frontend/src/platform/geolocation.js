// 定位接口：返回统一的 GCJ-02 坐标与来源信息，交给高德前只按需转换一次。
//   网页：高德 AMap.Geolocation（convert:true，结果已是 GCJ-02）
//   App：系统定位插件（结果为 WGS-84，本地转换为 GCJ-02）

import { isNativePlatform } from './env.js';
import { wgs84ToGcj02 } from './coordTransform.js';
import { t } from '../i18n/index.js';

export const LOCATION_ERROR = {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    SERVICES_DISABLED: 'SERVICES_DISABLED',
    POSITION_UNAVAILABLE: 'POSITION_UNAVAILABLE',
    TIMEOUT: 'TIMEOUT',
    INSECURE_CONTEXT: 'INSECURE_CONTEXT',
    NOT_READY: 'NOT_READY',
    UNKNOWN: 'UNKNOWN'
};

const MESSAGES = {
    PERMISSION_DENIED: t('platform:geolocation.permissionDenied'),
    SERVICES_DISABLED: t('platform:geolocation.servicesDisabled'),
    POSITION_UNAVAILABLE: t('platform:geolocation.positionUnavailable'),
    TIMEOUT: t('platform:geolocation.timeout'),
    INSECURE_CONTEXT: t('common:error.geolocationInsecure'),
    NOT_READY: t('platform:geolocation.notReady'),
    UNKNOWN: t('platform:geolocation.unknown')
};

export class LocationError extends Error {
    constructor(code, cause) {
        super(MESSAGES[code] || MESSAGES.UNKNOWN);
        this.code = code;
        this.cause = cause;
    }
}

function classify(errorLike) {
    if (errorLike instanceof LocationError) return errorLike;
    const text = `${errorLike?.code || ''} ${errorLike?.info || ''} ${errorLike?.message || ''}`.toUpperCase();
    if (/PERMISSION|DENIED|NOT AUTHORIZED|USER DENIED/.test(text)) return new LocationError(LOCATION_ERROR.PERMISSION_DENIED, errorLike);
    // OS-PLUG-GLOC-0017：网络与定位均已关闭（Android）；系统定位总开关关闭时 checkPermissions 也会抛错
    if (/SERVICES ARE NOT ENABLED|LOCATION SERVICES|DISABLED|OS-PLUG-GLOC-0017/.test(text)) return new LocationError(LOCATION_ERROR.SERVICES_DISABLED, errorLike);
    if (/TIME_?OUT/.test(text)) return new LocationError(LOCATION_ERROR.TIMEOUT, errorLike);
    if (/UNAVAILABLE/.test(text)) return new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE, errorLike);
    if (/SECURE|HTTPS|INSECURE/.test(text)) return new LocationError(LOCATION_ERROR.INSECURE_CONTEXT, errorLike);
    return new LocationError(LOCATION_ERROR.UNKNOWN, errorLike);
}

export function describeLocationError(errorLike) {
    return classify(errorLike).message;
}

function canUseBrowserLocation() {
    if (typeof window === 'undefined') return false;
    const { protocol, hostname } = window.location;
    return window.isSecureContext || protocol === 'https:' || /^(localhost|127\.0\.0\.1|::1)$/.test(hostname);
}

export function isLocationAvailable() {
    return isNativePlatform() || canUseBrowserLocation();
}

async function locateNative({ timeout }) {
    const { Geolocation } = await import('@capacitor/geolocation');
    let permission;
    try {
        permission = await Geolocation.checkPermissions();
        if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
            permission = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
        }
    } catch (error) {
        // 系统定位总开关关闭时，检查权限本身就会失败
        throw classify(error);
    }
    if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
        throw new LocationError(LOCATION_ERROR.PERMISSION_DENIED);
    }
    let position;
    try {
        position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout, maximumAge: 0 });
    } catch (error) {
        throw classify(error);
    }
    const { longitude, latitude, accuracy } = position.coords || {};
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE);
    const converted = wgs84ToGcj02(longitude, latitude);
    return {
        lng: converted.lng,
        lat: converted.lat,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        coordSystem: 'GCJ-02',
        source: 'native',
        converted: true,
        raw: { lng: longitude, lat: latitude, coordSystem: 'WGS-84' },
        timestamp: position.timestamp || Date.now()
    };
}

let amapGeolocation = null;

function ensureAmapGeolocation(map, timeout) {
    if (amapGeolocation) return Promise.resolve(amapGeolocation);
    if (!window.AMap) return Promise.reject(new LocationError(LOCATION_ERROR.NOT_READY));
    return new Promise((resolve, reject) => {
        window.AMap.plugin('AMap.Geolocation', () => {
            try {
                const geolocation = new window.AMap.Geolocation({
                    convert: true,
                    enableHighAccuracy: true,
                    timeout,
                    maximumAge: 0,
                    GeoLocationFirst: true,
                    showButton: false,
                    showMarker: false,
                    showCircle: false,
                    panToLocation: false,
                    zoomToAccuracy: false,
                    getCityWhenFail: false
                });
                if (map && typeof map.addControl === 'function') map.addControl(geolocation);
                amapGeolocation = geolocation;
                resolve(geolocation);
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** 地图实例销毁时调用，下次定位重新创建控件。 */
export function releaseLocationControl(map) {
    if (amapGeolocation && map && typeof map.removeControl === 'function') {
        try { map.removeControl(amapGeolocation); } catch (e) { /* ignore */ }
    }
    amapGeolocation = null;
}

async function locateWeb({ map, timeout }) {
    if (!canUseBrowserLocation()) throw new LocationError(LOCATION_ERROR.INSECURE_CONTEXT);
    const geolocation = await ensureAmapGeolocation(map, timeout);
    const result = await new Promise((resolve, reject) => {
        geolocation.getCurrentPosition((status, locateResult) => {
            if (status === 'complete' && locateResult && locateResult.position) resolve(locateResult);
            else reject(locateResult || new Error(t('platform:geolocation.failed')));
        });
    }).catch((error) => { throw classify(error); });
    const pos = result.position;
    const lng = typeof pos.getLng === 'function' ? pos.getLng() : pos.lng;
    const lat = typeof pos.getLat === 'function' ? pos.getLat() : pos.lat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE);
    return {
        lng,
        lat,
        accuracy: Number.isFinite(result.accuracy) ? result.accuracy : null,
        coordSystem: 'GCJ-02',
        source: 'amap',
        // AMap.Geolocation 在 convert:true 时内部已完成 WGS-84→GCJ-02，这里不再转换
        converted: false,
        timestamp: Date.now()
    };
}

/**
 * 获取当前位置（GCJ-02）。
 * @param {{ map?: any, timeout?: number }} options
 */
export async function getCurrentLocation({ map, timeout = 10000 } = {}) {
    return isNativePlatform() ? locateNative({ timeout }) : locateWeb({ map, timeout });
}
