// 地点图片存储：本地 backend/uploads/（默认）或阿里云 OSS（IMAGE_STORAGE=oss）。
// OSS 模式下对象键为 `${OSS_PREFIX}/<文件名>`（默认前缀 food，Bucket 可与其他用途共用），
// 对外地址为 `${OSS_PUBLIC_BASE_URL}/${OSS_PREFIX}/<文件名>`；数据库只存这个自有域名地址，
// 不存 OSS 默认域名（默认域名访问图片会被强制下载，且会把厂商域名写死进数据）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { backendPath } = require('../../../infrastructure/paths');

// UPLOADS_DIR 仅供测试指向临时目录
const LOCAL_UPLOAD_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : backendPath('uploads');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// 早期图片放在 uploads/<目录>/<文件名> 下，允许最多两层
// 只接受浏览器能直接显示的格式；扩展名与 Content-Type 由实际内容决定，不信任客户端文件名
const FORMATS = {
    jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
    png: { ext: 'png', contentType: 'image/png' },
    webp: { ext: 'webp', contentType: 'image/webp' },
    gif: { ext: 'gif', contentType: 'image/gif' }
};
const CONTENT_TYPE_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif'
};
// 本站历史上出现过的本地图片地址：cn.dinnerparty.cc:2053、dinnerparty.cc:2053、dinnerparty.cc/backend、
// 本地开发地址，以及 /uploads/... 相对路径
const LOCAL_UPLOAD_ORIGIN = /(?:https?:\/\/(?:[a-z0-9-]+\.)*(?:dinnerparty\.cc|localhost|127\.0\.0\.1)(?::\d+)?(?:\/backend)?)/.source;
const LOCAL_UPLOAD_URL = new RegExp(`^${LOCAL_UPLOAD_ORIGIN}?/?uploads/([^?#]+)$`, 'i');
// 文件名唯一且内容不变，可永久缓存
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function trimSlashes(value) {
    return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function readConfig(env = process.env) {
    return {
        enabled: String(env.IMAGE_STORAGE || 'local').trim().toLowerCase() === 'oss',
        region: String(env.OSS_REGION || '').trim(),
        bucket: String(env.OSS_BUCKET || '').trim(),
        endpoint: String(env.OSS_ENDPOINT || '').trim(),
        accessKeyId: String(env.OSS_ACCESS_KEY_ID || '').trim(),
        accessKeySecret: String(env.OSS_ACCESS_KEY_SECRET || '').trim(),
        prefix: trimSlashes(env.OSS_PREFIX || 'food'),
        publicBaseUrl: String(env.OSS_PUBLIC_BASE_URL || '').trim().replace(/\/+$/g, '')
    };
}

const config = readConfig();

function configErrors(cfg = config) {
    if (!cfg.enabled) return [];
    const errors = [];
    for (const [key, name] of [['region', 'OSS_REGION'], ['bucket', 'OSS_BUCKET'], ['accessKeyId', 'OSS_ACCESS_KEY_ID'],
        ['accessKeySecret', 'OSS_ACCESS_KEY_SECRET'], ['publicBaseUrl', 'OSS_PUBLIC_BASE_URL']]) {
        if (!cfg[key]) errors.push(`${name} 未配置`);
    }
    if (!cfg.prefix) errors.push('OSS_PREFIX 不能为空（Bucket 与其他用途共用，图片必须放在独立目录下）');
    if (cfg.publicBaseUrl && !/^https:\/\//i.test(cfg.publicBaseUrl)) errors.push('OSS_PUBLIC_BASE_URL 必须是 https:// 地址');
    return errors;
}

function isOssEnabled() {
    return config.enabled;
}

let client = null;
function getClient() {
    const errors = configErrors();
    if (errors.length) throw new Error(`OSS 配置错误：${errors.join('；')}`);
    if (!client) {
        const OSS = require('ali-oss');
        client = new OSS({
            region: config.region,
            bucket: config.bucket,
            accessKeyId: config.accessKeyId,
            accessKeySecret: config.accessKeySecret,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
            secure: true,
            authorizationV4: true,
            timeout: 60000
        });
    }
    return client;
}

function objectKey(filename) {
    return `${config.prefix}/${filename}`;
}

function publicUrlFor(filename) {
    return `${config.publicBaseUrl}/${objectKey(filename)}`;
}

/** uploads 下的相对路径（`文件名` 或 `目录/文件名`），每段只含安全字符 */
function isSafeName(name) {
    if (typeof name !== 'string' || name.includes('..')) return false;
    const parts = name.split('/');
    return parts.length <= 2 && parts.every((part) => SAFE_NAME.test(part));
}

/** 指向本站 uploads 的地址 → uploads 下的相对路径（已解码）；不是本站本地图片时返回 null */
function localUploadName(url) {
    const match = typeof url === 'string' ? url.trim().match(LOCAL_UPLOAD_URL) : null;
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function contentTypeForName(name) {
    const ext = path.extname(name).slice(1).toLowerCase();
    return CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

// 只在必须重新编码时使用（方向需要摆正，或 PNG/WebP 带元数据），与前端 UPLOAD_LIMITS.placeImage.quality 一致
const REENCODE_QUALITY = 92;

function payloadStartsWith(payload, text) {
    const prefix = Buffer.from(text, 'latin1');
    return payload.length >= prefix.length && payload.subarray(0, prefix.length).equals(prefix);
}

/**
 * 删除 JPEG 里会带隐私信息的段：APP1 的 Exif（含 GPS、设备型号、拍摄时间）与 XMP、APP13 的 IPTC。
 * 只删段、不动压缩数据，画质不变；ICC 色彩配置（APP2）等其他段保留。结构异常时返回 null。
 */
function stripJpegMetadata(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
    const parts = [buffer.subarray(0, 2)];
    let removed = false;
    let i = 2;
    while (i + 1 < buffer.length) {
        if (buffer[i] !== 0xFF) return null;
        const marker = buffer[i + 1];
        if (marker === 0xFF) { i += 1; continue; } // 段之间的填充字节
        if (marker === 0xDA || marker === 0xD9) { // 扫描数据开始（之后是压缩数据）或文件结束：其余原样保留
            parts.push(buffer.subarray(i));
            return removed ? Buffer.concat(parts) : buffer;
        }
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { // 无长度的独立标记
            parts.push(buffer.subarray(i, i + 2));
            i += 2;
            continue;
        }
        if (i + 4 > buffer.length) return null;
        const end = i + 2 + buffer.readUInt16BE(i + 2);
        if (end < i + 4 || end > buffer.length) return null;
        const payload = buffer.subarray(i + 4, end);
        const privacy = (marker === 0xE1 && (payloadStartsWith(payload, 'Exif\0') || payloadStartsWith(payload, 'http://ns.adobe.com/')))
            || marker === 0xED;
        if (privacy) removed = true;
        else parts.push(buffer.subarray(i, end));
        i = end;
    }
    return null;
}

/**
 * 校验真实格式并去掉隐私元数据，返回 { buffer, format }；不支持的格式返回 null。
 * - JPEG 方向正常：只删元数据段，不重新编码（前端已按需压缩过，不再二次压缩）
 * - JPEG 带旋转方向（未经前端处理的原图）：按方向摆正后重新编码，保留色彩配置
 * - PNG / WebP 带元数据或旋转方向：重新编码（PNG 无损）；GIF、动图原样保留
 */
async function prepareImage(buffer) {
    let meta;
    try {
        meta = await sharp(buffer, { animated: true }).metadata();
    } catch {
        return null;
    }
    const format = FORMATS[meta.format];
    if (!format) return null;
    const rotated = (meta.orientation || 1) > 1;
    if (meta.format === 'jpeg') {
        const stripped = rotated ? null : stripJpegMetadata(buffer);
        if (stripped) return { buffer: stripped, format };
        const output = await sharp(buffer).rotate().keepIccProfile().jpeg({ quality: REENCODE_QUALITY }).toBuffer();
        return { buffer: output, format };
    }
    const animated = (meta.pages || 1) > 1;
    if (meta.format === 'gif' || animated || !(rotated || meta.exif || meta.xmp || meta.iptc)) return { buffer, format };
    const image = sharp(buffer).rotate().keepIccProfile();
    const output = await (meta.format === 'png' ? image.png() : image.webp({ quality: REENCODE_QUALITY })).toBuffer();
    return { buffer: output, format };
}

function newFilename(ext) {
    return `${Date.now()}-${crypto.randomInt(1e9)}.${ext}`;
}

async function putObject(filename, body, contentType) {
    await getClient().put(objectKey(filename), body, {
        mime: contentType,
        headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL }
    });
}

/** 对象存在时返回字节数，不存在返回 null。 */
async function headObject(filename) {
    try {
        const result = await getClient().head(objectKey(filename));
        return Number(result.res.headers['content-length']);
    } catch (error) {
        if (error && (error.status === 404 || error.code === 'NoSuchKey')) return null;
        throw error;
    }
}

/**
 * 保存一张已校验格式的图片，返回写入数据库的地址。
 * 本地模式返回 /uploads/<文件名>（前端拼接 API 地址）；OSS 模式返回自有域名的完整地址。
 */
async function saveImage(buffer, format) {
    const filename = newFilename(format.ext);
    if (config.enabled) {
        await putObject(filename, buffer, format.contentType);
        return publicUrlFor(filename);
    }
    await fs.promises.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(LOCAL_UPLOAD_DIR, filename), buffer, { flag: 'wx' });
    return `/uploads/${filename}`;
}

/** 本地已没有的历史 /uploads/<相对路径>：OSS 模式下跳转到 OSS 上的同名文件。 */
function legacyRedirectUrl(name) {
    if (!config.enabled || !config.publicBaseUrl || !isSafeName(name)) return null;
    return publicUrlFor(name);
}

module.exports = {
    LOCAL_UPLOAD_DIR,
    LOCAL_UPLOAD_ORIGIN,
    CACHE_CONTROL,
    localUploadName,
    readConfig,
    configErrors,
    isOssEnabled,
    isSafeName,
    contentTypeForName,
    prepareImage,
    stripJpegMetadata,
    saveImage,
    putObject,
    headObject,
    publicUrlFor,
    objectKey,
    legacyRedirectUrl
};
