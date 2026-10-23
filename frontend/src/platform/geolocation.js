// 定位接口：返回统一的 GCJ-02 坐标与来源信息，交给高德前只按需转换一次。
//   网页：浏览器定位（WGS-84，本地转换为 GCJ-02），拿不到时用高德 IP 定位（已是 GCJ-02）补一个粗略位置
//   Android：应用内高德定位 SDK 插件 AMapLocation（国内已是 GCJ-02；境外结果及高德失败时的系统定位兜底为 WGS-84，本地转换）
//   iOS：系统定位插件的持续定位，先返回首个位置再逐步变准（结果为 WGS-84，本地转换为 GCJ-02）

import { getPlatform, isNativePlatform } from './env.js';
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
// iOS 超时是系统定位迟迟给不出位置，与网络无关，提示里不提网络
const IOS_TIMEOUT_MESSAGE = t('platform:geolocation.timeoutIos');

// 网页端流程（locateWithBrowser）：
//   1. 同时发起低精度单次定位（可用 1 分钟内的缓存，通常最快）和高精度持续定位，先到的结果立即返回；
//   2. 浏览器几秒内没有结果或报错时，用高德 IP 定位补一个粗略位置；拒绝授权时不拿 IP 位置顶替；
//   3. 之后明显更准的结果交给 onUpdate，精度达到 20 米、授权后 30 秒到期或 signal 取消时全部停止。
const WEB_LOCATE_TIMEOUT_MS = 30000;
const NATIVE_LOCATE_TIMEOUT_MS = 10000;
// iOS 持续定位（locateWithWatch）：等首个位置、之后继续变准的总时长
const IOS_LOCATE_TIMEOUT_MS = 20000;
const COARSE_MAX_AGE_MS = 60000;
const IP_FALLBACK_DELAY_MS = 6000;
const TARGET_ACCURACY_M = 20;
// 精度至少好 20% 才算更新，避免浏览器每秒回报的小幅波动反复移动标记、重复上报
const MIN_IMPROVEMENT_RATIO = 0.8;

export class LocationError extends Error {
    constructor(code, cause) {
        super(code === LOCATION_ERROR.TIMEOUT && getPlatform() === 'ios' ? IOS_TIMEOUT_MESSAGE : (MESSAGES[code] || MESSAGES.UNKNOWN));
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

// 插件的 timeout 不覆盖所有桥接/设备异常；JS 也设置截止时间，并响应地图卸载时的取消。
// 授权弹窗只响应取消，不设置获取位置的倒计时。
function nativeCall(operation, { timeout, signal }) {
    if (signal?.aborted) return Promise.reject(new LocationError(LOCATION_ERROR.ABORTED));
    let timer;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(new LocationError(LOCATION_ERROR.ABORTED));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeout != null) timer = setTimeout(() => reject(new LocationError(LOCATION_ERROR.TIMEOUT)), timeout);
    });
    const pending = Promise.resolve().then(() => {
        if (signal?.aborted) throw new LocationError(LOCATION_ERROR.ABORTED);
        return operation();
    });
    return Promise.race([pending, interrupted]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    });
}

// 高德定位 SDK 的错误码（AMapLocation.ERROR_CODE_*）；未列出的按暂时无法定位处理。
// 7（Key 鉴权，包名/签名 SHA1 与 Key 不符）、9、10 和 AMAP_INIT 是配置或 SDK 启动问题，归为未知错误并保留原始信息。
const AMAP_ERRORS = {
    4: LOCATION_ERROR.TIMEOUT, // 请求高德服务器异常，多为网络差
    7: LOCATION_ERROR.UNKNOWN,
    9: LOCATION_ERROR.UNKNOWN,
    10: LOCATION_ERROR.UNKNOWN,
    12: LOCATION_ERROR.PERMISSION_DENIED,
    INIT: LOCATION_ERROR.UNKNOWN
};

function classifyAmap(errorLike) {
    if (errorLike instanceof LocationError) return errorLike;
    const code = String(errorLike?.code || '');
    // 插件自己的 PERMISSION_DENIED / SERVICES_DISABLED / TIMEOUT / ABORTED
    if (LOCATION_ERROR[code] === code) return new LocationError(code, errorLike);
    const amap = /^AMAP_(\w+)$/.exec(code)?.[1];
    if (amap) return new LocationError(AMAP_ERRORS[amap] || LOCATION_ERROR.POSITION_UNAVAILABLE, errorLike);
    return classify(errorLike);
}

// iOS 定位插件（@capacitor/geolocation）的错误码；未列出的按文字归类
const IOS_PLUGIN_ERRORS = {
    'OS-PLUG-GLOC-0002': LOCATION_ERROR.POSITION_UNAVAILABLE, // 一时取不到位置，持续定位仍在进行
    'OS-PLUG-GLOC-0003': LOCATION_ERROR.PERMISSION_DENIED,
    'OS-PLUG-GLOC-0007': LOCATION_ERROR.SERVICES_DISABLED,
    'OS-PLUG-GLOC-0008': LOCATION_ERROR.PERMISSION_DENIED, // 定位访问受限（屏幕使用时间等）
    'OS-PLUG-GLOC-0010': LOCATION_ERROR.TIMEOUT // 首个位置超时，插件已停止持续定位
};

function classifyIosPlugin(errorLike) {
    if (errorLike instanceof LocationError) return errorLike;
    const code = IOS_PLUGIN_ERRORS[String(errorLike?.code || '')];
    return code ? new LocationError(code, errorLike) : classify(errorLike);
}

// 插件代理对任意属性（包括 then）都返回方法，不能直接作为 Promise 结果，包一层普通对象。
let amapLocationPromise = null;
function loadAmapLocation() {
    if (!amapLocationPromise) {
        amapLocationPromise = import('@capacitor/core').then(({ registerPlugin }) => ({ plugin: registerPlugin('AMapLocation') }));
        amapLocationPromise.catch(() => { amapLocationPromise = null; });
    }
    return amapLocationPromise;
}

function fromAmapPosition(raw) {
    const { longitude, latitude, accuracy, coordType, timestamp } = raw || {};
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new LocationError(LOCATION_ERROR.POSITION_UNAVAILABLE);
    // 高德在其国内范围返回 GCJ-02，境外返回 WGS-84；高德失败时插件改用的系统定位也是 WGS-84（国内需转换，境外原样返回）
    const wgs84 = coordType === 'WGS84';
    const converted = wgs84 ? wgs84ToGcj02(longitude, latitude) : { lng: longitude, lat: latitude };
    return {
        lng: converted.lng,
        lat: converted.lat,
        accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
        coordSystem: 'GCJ-02',
        source: 'native',
        converted: wgs84,
        raw: { lng: longitude, lat: latitude, coordSystem: wgs84 ? 'WGS-84' : 'GCJ-02' },
        timestamp: timestamp || Date.now()
    };
}

function fromSystemPosition(position) {
    const { longitude, latitude, accuracy } = position?.coords || {};
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

/**
 * iOS 定位：插件的持续定位（watchPosition，即系统 startUpdatingLocation）通常不到一秒就给出系统缓存或 Wi-Fi 的位置，
 * 先返回它；传了 onUpdate 时之后明显更准的位置继续回调，精度达到 20 米、到期或 signal 取消时停止。
 * 不用插件的单次定位：它是 requestLocation + 最高精度，要等 GPS 收敛才回调，常常接近 10 秒。
 * 导出供测试注入假的插件。
 * @param {{ watch: (callback: (raw: any, error?: any) => void) => Promise<string>, clearWatch: (id: string) => Promise<void>,
 *           toPosition?: (raw: any) => object, timeout?: number, maxAge?: number, now?: () => number,
 *           onUpdate?: (position: object) => void, signal?: AbortSignal }} options
 */
export function locateWithWatch({
    watch,
    clearWatch,
    toPosition = fromSystemPosition,
    timeout = IOS_LOCATE_TIMEOUT_MS,
    maxAge = COARSE_MAX_AGE_MS,
    now = Date.now,
    onUpdate,
    signal
}) {
    return new Promise((resolve, reject) => {
        let best = null;
        let settled = false;
        let stopped = false;
        let watchId = null;
        let lastError = null;
        let budgetTimer = null;

        const release = (id) => { Promise.resolve().then(() => clearWatch(id)).catch(() => undefined); };
        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(budgetTimer);
            if (watchId != null) release(watchId);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error) => {
            stop();
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        const onFix = (raw, error) => {
            if (stopped) return;
            if (!raw) {
                const reason = classifyIosPlugin(error);
                // 一时取不到位置时插件仍在持续定位，继续等到期；无权限、定位关闭、插件超时立即失败
                if (reason.code === LOCATION_ERROR.POSITION_UNAVAILABLE) lastError = reason;
                else fail(reason);
                return;
            }
            // 第一个回调常是系统缓存的位置；太旧的不用，否则会停在之前去过的地方（旧位置精度可能比之后的新位置还好，不会被替换）
            if (Number.isFinite(raw.timestamp) && now() - raw.timestamp > maxAge) return;
            let position;
            try {
                position = toPosition(raw);
            } catch (e) {
                lastError = classify(e);
                return;
            }
            if (!isBetterFix(position, best)) return;
            best = position;
            if (!settled) {
                settled = true;
                resolve(position);
            } else {
                onUpdate?.(position);
            }
            if (!onUpdate || accuracyRank(position) <= TARGET_ACCURACY_M) stop();
        };
        const onAbort = () => fail(new LocationError(LOCATION_ERROR.ABORTED));

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        budgetTimer = setTimeout(() => fail(lastError || new LocationError(LOCATION_ERROR.TIMEOUT)), timeout);
        Promise.resolve().then(() => {
            if (stopped) return undefined;
            // 插件可能在返回 id 之前就回调了首个位置并已停止
            return Promise.resolve(watch(onFix)).then((id) => {
                if (stopped) release(id);
                else watchId = id;
            });
        }).catch((error) => fail(classifyIosPlugin(error)));
    });
}

// 两个插件的权限别名相同（location 精确 / coarseLocation 模糊），授权流程共用
async function nativeLocator() {
    if (getPlatform() === 'android') {
        const { plugin } = await loadAmapLocation();
        return {
            plugin,
            classify: classifyAmap,
            timeout: NATIVE_LOCATE_TIMEOUT_MS,
            // 精度由高德 SDK 按已授予的权限决定（仅模糊权限时返回模糊位置），不会再请求升级为精确位置
            locate: (permission, { timeout, signal }) => nativeCall(
                () => plugin.getCurrentPosition({ timeout }).then(fromAmapPosition), { timeout, signal })
        };
    }
    const { Geolocation } = await import('@capacitor/geolocation');
    return {
        plugin: Geolocation,
        classify: classifyIosPlugin,
        timeout: IOS_LOCATE_TIMEOUT_MS,
        // 插件的 timeout 只限制首个位置（不传时只有 5 秒），之后由 locateWithWatch 计时
        locate: (permission, { timeout, onUpdate, signal }) => locateWithWatch({
            watch: (callback) => Geolocation.watchPosition({
                enableHighAccuracy: permission.location === 'granted', timeout, maximumAge: 0
            }, callback),
            clearWatch: (id) => Geolocation.clearWatch({ id }),
            timeout,
            onUpdate,
            signal
        })
    };
}

async function locateNative({ timeout: requested, onUpdate, signal }) {
    const { plugin, classify: toLocationError, timeout: platformTimeout, locate } = await nativeLocator();
    const timeout = requested ?? platformTimeout;
    let permission;
    try {
        permission = await nativeCall(() => plugin.checkPermissions(), { timeout, signal });
        if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
            permission = await nativeCall(() => plugin.requestPermissions({ permissions: ['location', 'coarseLocation'] }), { signal });
        }
    } catch (error) {
        // 系统定位总开关关闭时，iOS 插件检查权限本身就会失败
        throw toLocationError(error);
    }
    if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
        throw new LocationError(LOCATION_ERROR.PERMISSION_DENIED);
    }
    try {
        return await locate(permission, { timeout, onUpdate, signal });
    } catch (error) {
        throw toLocationError(error);
    }
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
 * 网页端和 iOS 先返回最先拿到的位置（可能只是粗略位置）；传了 onUpdate 时，之后明显更准的位置继续回调，
 * 直到精度达到 20 米、超时（网页默认 30 秒，iOS 20 秒）或 signal 取消。
 * Android 只返回一次定位结果（高德定位 SDK，默认 10 秒超时），不会回调 onUpdate。
 * @param {{ map?: any, timeout?: number, onUpdate?: (position: object) => void, signal?: AbortSignal }} options
 */
export async function getCurrentLocation({ map, timeout, onUpdate, signal } = {}) {
    if (isNativePlatform()) return locateNative({ timeout, onUpdate, signal });
    return locateWeb({ map, timeout: timeout ?? WEB_LOCATE_TIMEOUT_MS, onUpdate, signal });
}
