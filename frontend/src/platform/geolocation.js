// 定位接口：返回统一的 GCJ-02 坐标与来源信息，交给高德前只按需转换一次。
//   网页：浏览器定位（WGS-84，本地转换为 GCJ-02），拿不到时用高德 IP 定位（已是 GCJ-02）补一个粗略位置
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
    ABORTED: 'ABORTED',
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

// 网页端流程（locateWithBrowser）：
//   1. 同时发起低精度单次定位（可用 1 分钟内的缓存，通常最快）和高精度持续定位，先到的结果立即返回；
//   2. 浏览器几秒内没有结果或报错时，用高德 IP 定位补一个粗略位置；拒绝授权时不拿 IP 位置顶替；
//   3. 之后明显更准的结果交给 onUpdate，精度达到 20 米、授权后 30 秒到期或 signal 取消时全部停止。
const WEB_LOCATE_TIMEOUT_MS = 30000;
const NATIVE_LOCATE_TIMEOUT_MS = 10000;
const COARSE_MAX_AGE_MS = 60000;
const IP_FALLBACK_DELAY_MS = 6000;
const TARGET_ACCURACY_M = 20;
// 精度至少好 20% 才算更新，避免浏览器每秒回报的小幅波动反复移动标记、重复上报
const MIN_IMPROVEMENT_RATIO = 0.8;

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

// 浏览器 GeolocationPositionError 的数字代码；消息文字因浏览器而异，不能靠文字判断
const POSITION_ERROR_CODES = {
    1: LOCATION_ERROR.PERMISSION_DENIED,
    2: LOCATION_ERROR.POSITION_UNAVAILABLE,
    3: LOCATION_ERROR.TIMEOUT
};

function fromPositionError(error) {
    const code = POSITION_ERROR_CODES[error?.code];
    return code ? new LocationError(code, error) : classify(error);
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

// 支付宝和安卓 UC 浏览器的 H5 定位已是 GCJ-02（与高德 JS 定位插件的判断一致），其余浏览器返回 WGS-84
function browserReturnsGcj02() {
    const ua = String(globalThis.navigator?.userAgent || '').toLowerCase();
    return ua.includes('alipay') || (ua.includes('ucbrowser') && ua.includes('android'));
}

function fromBrowserPosition(raw) {
    const { longitude, latitude, accuracy } = raw?.coords || {};
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    const alreadyGcj02 = browserReturnsGcj02();
    const converted = alreadyGcj02 ? { lng: longitude, lat: latitude } : wgs84ToGcj02(longitude, latitude);
    return {
        lng: converted.lng,
        lat: converted.lat,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        coordSystem: 'GCJ-02',
        source: 'browser',
        converted: !alreadyGcj02,
        raw: { lng: longitude, lat: latitude, coordSystem: alreadyGcj02 ? 'GCJ-02' : 'WGS-84' },
        timestamp: raw.timestamp || Date.now()
    };
}

// 没有精度的结果（IP 定位）排在任何浏览器结果之后
function accuracyRank(position) {
    return Number.isFinite(position?.accuracy) ? position.accuracy : Infinity;
}

function isBetterFix(next, best) {
    if (!best) return true;
    const current = accuracyRank(best);
    const candidate = accuracyRank(next);
    if (current === Infinity) return candidate < Infinity;
    return candidate <= current * MIN_IMPROVEMENT_RATIO;
}

// 授权弹窗还没答复时先不计时，也不拿 IP 位置顶替（浏览器自己的 timeout 同样从授权之后算起）。
// 不支持 Permissions API 的浏览器直接开始计时。
function whenGeolocationPermitted(signal) {
    const permissions = globalThis.navigator?.permissions;
    if (!permissions?.query) return Promise.resolve();
    return permissions.query({ name: 'geolocation' }).then((status) => {
        if (status.state !== 'prompt') return undefined;
        return new Promise((resolve) => {
            const done = () => {
                status.removeEventListener('change', onChange);
                resolve();
            };
            const onChange = () => { if (status.state !== 'prompt') done(); };
            status.addEventListener('change', onChange);
            signal?.addEventListener('abort', done, { once: true });
        });
    }).catch(() => undefined);
}

/**
 * 浏览器定位：返回最先拿到的位置；传了 onUpdate 时继续等更准的结果（见文件开头的流程说明）。
 * 导出供测试注入假的定位接口。
 * @param {{ geolocation?: Geolocation|null, ipLocate?: () => Promise<object>, toPosition?: (raw: any) => object|null,
 *           whenPermitted?: (signal?: AbortSignal) => Promise<void>, timeout?: number, ipDelay?: number,
 *           onUpdate?: (position: object) => void, signal?: AbortSignal }} options
 */
export function locateWithBrowser({
    geolocation,
    ipLocate,
    toPosition = fromBrowserPosition,
    whenPermitted = whenGeolocationPermitted,
    timeout = WEB_LOCATE_TIMEOUT_MS,
    ipDelay = IP_FALLBACK_DELAY_MS,
    onUpdate,
    signal
}) {
    return new Promise((resolve, reject) => {
        let best = null;
        let settled = false;
        let stopped = false;
        let watchId = null;
        let budgetTimer = null;
        let ipTimer = null;
        let ipRequested = false;
        let ipFailed = !ipLocate;
        let coarseFailed = !geolocation;
        let watchFailed = !geolocation;
        let browserError = null;

        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(budgetTimer);
            clearTimeout(ipTimer);
            if (watchId != null) geolocation.clearWatch(watchId);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error) => {
            stop();
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        // 浏览器两路都报错、IP 定位也失败时不再等到超时
        const failIfExhausted = () => {
            if (!settled && coarseFailed && watchFailed && ipFailed) {
                fail(browserError || new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE));
            }
        };
        const offer = (position) => {
            if (stopped || !position || !isBetterFix(position, best)) return;
            best = position;
            clearTimeout(ipTimer);
            if (!settled) {
                settled = true;
                resolve(position);
            } else {
                onUpdate?.(position);
            }
            if (!onUpdate || accuracyRank(position) <= TARGET_ACCURACY_M) stop();
        };
        // 已经有浏览器结果时 IP 位置不可能更准，不再请求
        const requestIp = () => {
            if (ipRequested || stopped || best || !ipLocate) return;
            ipRequested = true;
            clearTimeout(ipTimer);
            Promise.resolve().then(ipLocate).then(offer, () => {
                ipFailed = true;
                failIfExhausted();
            });
        };
        const onBrowserError = (error) => {
            if (stopped) return;
            const reason = fromPositionError(error);
            if (reason.code === LOCATION_ERROR.PERMISSION_DENIED) {
                fail(reason);
                return;
            }
            browserError = reason;
            requestIp();
            failIfExhausted();
        };
        const onAbort = () => fail(new LocationError(LOCATION_ERROR.ABORTED));

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        if (geolocation) {
            const onPosition = (raw) => offer(toPosition(raw));
            try {
                geolocation.getCurrentPosition(onPosition, (error) => {
                    coarseFailed = true;
                    onBrowserError(error);
                }, { enableHighAccuracy: false, maximumAge: COARSE_MAX_AGE_MS, timeout });
                const id = geolocation.watchPosition(onPosition, (error) => {
                    watchFailed = true;
                    onBrowserError(error);
                }, { enableHighAccuracy: true, maximumAge: 0, timeout });
                if (stopped) geolocation.clearWatch(id);
                else watchId = id;
            } catch (error) {
                coarseFailed = true;
                watchFailed = true;
                browserError = classify(error);
            }
        }
        if (stopped) return;
        if (coarseFailed && watchFailed) {
            budgetTimer = setTimeout(() => fail(browserError || new LocationError(LOCATION_ERROR.TIMEOUT)), timeout);
            requestIp();
            failIfExhausted();
            return;
        }
        Promise.resolve(whenPermitted(signal)).catch(() => undefined).then(() => {
            if (stopped) return;
            budgetTimer = setTimeout(() => fail(browserError || new LocationError(LOCATION_ERROR.TIMEOUT)), timeout);
            if (!best) ipTimer = setTimeout(requestIp, ipDelay);
        });
    });
}

let amapGeolocation = null;

// 只用高德的 IP 定位（noGeoLocation: 3 关掉它自带的浏览器定位，浏览器定位由 locateWithBrowser 负责）
function ensureAmapIpLocator(map) {
    if (amapGeolocation) return Promise.resolve(amapGeolocation);
    if (!window.AMap) return Promise.reject(new LocationError(LOCATION_ERROR.NOT_READY));
    return new Promise((resolve, reject) => {
        window.AMap.plugin('AMap.Geolocation', () => {
            try {
                const geolocation = new window.AMap.Geolocation({
                    noGeoLocation: 3,
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

async function locateByIp(map) {
    const locator = await ensureAmapIpLocator(map);
    const result = await new Promise((resolve, reject) => {
        locator.getCurrentPosition((status, locateResult) => {
            if (status === 'complete' && locateResult && locateResult.position) resolve(locateResult);
            else reject(locateResult || new Error(t('platform:geolocation.failed')));
        });
    });
    const pos = result.position;
    const lng = typeof pos.getLng === 'function' ? pos.getLng() : pos.lng;
    const lat = typeof pos.getLat === 'function' ? pos.getLat() : pos.lat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE);
    return {
        lng,
        lat,
        accuracy: null,
        coordSystem: 'GCJ-02',
        source: 'ip',
        // 高德 IP 定位直接返回 GCJ-02，这里不再转换
        converted: false,
        timestamp: Date.now()
    };
}

function locateWeb({ map, timeout, onUpdate, signal }) {
    if (!canUseBrowserLocation()) return Promise.reject(new LocationError(LOCATION_ERROR.INSECURE_CONTEXT));
    return locateWithBrowser({
        geolocation: globalThis.navigator?.geolocation || null,
        ipLocate: () => locateByIp(map),
        timeout,
        onUpdate,
        signal
    });
}

/**
 * 获取当前位置（GCJ-02）。
 * 网页端先返回最先拿到的位置（可能只是粗略位置）；传了 onUpdate 时，之后明显更准的位置继续回调，
 * 直到精度达到 20 米、超时（默认 30 秒）或 signal 取消。App 端只返回一次系统定位结果，不会回调 onUpdate。
 * @param {{ map?: any, timeout?: number, onUpdate?: (position: object) => void, signal?: AbortSignal }} options
 */
export async function getCurrentLocation({ map, timeout, onUpdate, signal } = {}) {
    if (isNativePlatform()) return locateNative({ timeout: timeout ?? NATIVE_LOCATE_TIMEOUT_MS });
    return locateWeb({ map, timeout: timeout ?? WEB_LOCATE_TIMEOUT_MS, onUpdate, signal });
}
