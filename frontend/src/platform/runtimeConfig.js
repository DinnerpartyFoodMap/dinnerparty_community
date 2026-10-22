// 统一运行配置：API、高德代理、公开分享链接与资源地址的唯一来源。
//
// 网页：保持原有部署逻辑——未配置 VITE_BACKEND_URL 时 API 回退到“当前主机:2053”，
//       高德代理回退到当前 origin，公开链接使用当前 origin。
// 移动 App：页面运行在 https://localhost 或 capacitor://localhost，本地 origin 不能代表线上服务，
//       因此必须显式配置 HTTPS 地址；缺失时不猜测，直接报配置错误（构建期也会校验，见 vite.config.js）。

import { isNativePlatform } from './env.js';
import { t } from '../i18n/index.js';

const LEGACY_IMAGE_ORIGIN_PATTERN = /^https?:\/\/dinnerparty\.cc:2053(?=\/|$)/i;
const CANONICAL_IMAGE_ORIGIN = 'https://cn.dinnerparty.cc:2053';

function clean(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    // index.html 中未被替换的 %VITE_X% 占位符视为未配置
    if (!text || /^%VITE_[A-Z0-9_]+%$/.test(text)) return '';
    return text.replace(/\/+$/g, '');
}

// 备案号与查询链接都配置了才显示
function filing(text, url) {
    const label = clean(text);
    const href = String(url || '').trim();
    return label && href ? { text: label, url: href } : null;
}

function originOf(value) {
    try {
        return new URL(value).origin;
    } catch (e) {
        return value;
    }
}

function isLocalHostname(hostname) {
    return /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i.test(hostname || '');
}

function validateRemoteHttps(name, value, errors) {
    if (!value) {
        errors.push(t('platform:runtimeConfig.notConfigured', { name }));
        return;
    }
    let url;
    try {
        url = new URL(value);
    } catch (e) {
        errors.push(t('platform:runtimeConfig.invalidUrl', { name, value }));
        return;
    }
    if (url.protocol !== 'https:') errors.push(t('platform:runtimeConfig.httpsRequired', { name, value }));
    if (isLocalHostname(url.hostname)) errors.push(t('platform:runtimeConfig.localAddress', { name, value }));
}

/**
 * 纯函数，便于测试：根据环境变量、页面地址和平台得到运行配置。
 * @param {{ env: Record<string,string>, location?: {protocol:string, hostname:string, origin:string}, native: boolean }} input
 */
export function resolveRuntimeConfig({ env = {}, location, native }) {
    const errors = [];
    const loc = location || { protocol: 'https:', hostname: 'localhost', origin: 'https://localhost' };

    let apiBaseUrl = clean(env.VITE_BACKEND_URL);
    if (!apiBaseUrl && !native) apiBaseUrl = `${loc.protocol}//${loc.hostname}:2053`;

    let amapServiceHost = clean(env.VITE_AMAP_SERVICE_HOST);
    if (!amapServiceHost) {
        // JSAPI 安全模式要求 _AMapService 是一级路由，后端地址带路径前缀（如 /backend）时只取其 origin
        if (clean(env.VITE_BACKEND_URL)) amapServiceHost = `${originOf(clean(env.VITE_BACKEND_URL))}/_AMapService`;
        else if (!native) amapServiceHost = `${loc.origin}/_AMapService`;
    }

    let publicWebBaseUrl = clean(env.VITE_PUBLIC_WEB_URL);
    if (!publicWebBaseUrl && !native) publicWebBaseUrl = loc.origin;

    const resourceBaseUrl = clean(env.VITE_RESOURCE_BASE_URL) || apiBaseUrl;
    // OSS 上地点图片的目录地址（与后端 OSS_PUBLIC_BASE_URL/OSS_PREFIX 一致），用于生成缩略图；未配置时一律用原图
    const ossImageBaseUrl = clean(env.VITE_OSS_IMAGE_BASE_URL);
    // 海外底图（CARTO）的浏览器 key；未配置时不叠加海外底图（见 map/overseasTileLayer.js）
    const cartoApiKey = clean(env.VITE_CARTO_API_KEY);
    // 备案信息：App 单独备案，备案号与网站不同。App 只读 VITE_APP_ICP_BEIAN_* / VITE_APP_GONGAN_BEIAN_*，
    // 不会显示网站的备案号；未配置时不显示
    const icpBeian = native
        ? filing(env.VITE_APP_ICP_BEIAN_TEXT, env.VITE_APP_ICP_BEIAN_URL)
        : filing(env.VITE_ICP_BEIAN_TEXT, env.VITE_ICP_BEIAN_URL);
    const gonganBeian = native
        ? filing(env.VITE_APP_GONGAN_BEIAN_TEXT, env.VITE_APP_GONGAN_BEIAN_URL)
        : filing(env.VITE_GONGAN_BEIAN_TEXT, env.VITE_GONGAN_BEIAN_URL);

    if (native) {
        validateRemoteHttps('VITE_BACKEND_URL', apiBaseUrl, errors);
        validateRemoteHttps('VITE_PUBLIC_WEB_URL', publicWebBaseUrl, errors);
        validateRemoteHttps(t('platform:runtimeConfig.amapProxyName'), amapServiceHost, errors);
    }

    return {
        native: !!native,
        apiBaseUrl,
        amapServiceHost,
        publicWebBaseUrl,
        resourceBaseUrl,
        ossImageBaseUrl,
        cartoApiKey,
        icpBeian,
        gonganBeian,
        errors
    };
}

function readEnv() {
    try {
        return import.meta.env || {};
    } catch (e) {
        return {};
    }
}

let cached = null;

export function getRuntimeConfig() {
    if (!cached) {
        cached = Object.freeze(resolveRuntimeConfig({
            env: readEnv(),
            location: typeof window !== 'undefined' ? window.location : undefined,
            native: isNativePlatform()
        }));
    }
    return cached;
}

export function getApiBaseUrl() {
    return getRuntimeConfig().apiBaseUrl;
}

/** 面向外部的公开网页地址（分享链接、二维码），永远不是 App 的本地 origin。 */
export function buildPublicUrl(path = '/') {
    const base = getRuntimeConfig().publicWebBaseUrl;
    const suffix = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
    return `${base}${suffix}`;
}

/**
 * 统一资源地址解析：兼容历史绝对 URL（含旧的 dinnerparty.cc:2053）与 /uploads/... 相对路径。
 * data:/blob: 等本地地址原样返回。
 */
export function resolveResourceUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    const text = value.trim();
    if (/^(data|blob):/i.test(text)) return text;
    if (/^https?:\/\//i.test(text)) return text.replace(LEGACY_IMAGE_ORIGIN_PATTERN, CANONICAL_IMAGE_ORIGIN);
    if (text.startsWith('//')) return `https:${text}`;
    const base = getRuntimeConfig().resourceBaseUrl;
    return `${base}${text.startsWith('/') ? '' : '/'}${text}`;
}

/**
 * 纯函数，便于测试：OSS 目录下的静态图片 → 按宽度缩放并转 WebP 的地址（图片处理参数）。
 * 不在该目录下、已带查询参数或是动图（转换会丢帧）时原样返回。
 */
export function buildImageThumbnailUrl(url, width, ossImageBaseUrl) {
    if (typeof url !== 'string' || !url || !ossImageBaseUrl) return url;
    if (!url.startsWith(`${ossImageBaseUrl}/`) || url.includes('?') || /\.gif$/i.test(url)) return url;
    const w = Math.max(16, Math.min(4096, Math.round(Number(width) || 0)));
    return `${url}?x-oss-process=image/auto-orient,1/resize,w_${w}/quality,q_80/format,webp`;
}

/** 列表、缩略图位置用：解析资源地址后，OSS 图片按显示宽度取缩略图（大图预览仍用原图）。 */
export function imageThumbnailUrl(value, width) {
    return buildImageThumbnailUrl(resolveResourceUrl(value), width, getRuntimeConfig().ossImageBaseUrl);
}
