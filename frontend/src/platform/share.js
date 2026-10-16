// 分享与文件导出。区分三件事：
//   shareContent   —— 打开系统分享面板（文字 / 链接 / 图片）
//   copyText       —— 复制到剪贴板
//   saveImageBlob  —— 保存图片：网页下载为文件；App 写入临时文件后打开系统面板，
//                     由用户选择“存储图像（相册）”或“存储到文件”
// 用户取消分享属于正常操作，返回 'cancelled'，调用方不应提示为故障。

import { isNativePlatform } from './env.js';
import { t } from '../i18n/index.js';

/** @typedef {'shared'|'cancelled'|'unsupported'|'failed'} ShareResult */

const isCancel = (error) => {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    return /cancel|canceled|cancelled|abort|取消/i.test(String(error.message || error.errorMessage || error));
};

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error(t('platform:share.readFailed')));
        reader.readAsDataURL(blob);
    });
}

function safeFileName(name, fallback) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
    return cleaned || fallback;
}

async function writeTempFile(blob, filename) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const path = `share/${Date.now()}-${safeFileName(filename, 'image.png')}`;
    const result = await Filesystem.writeFile({
        path,
        data: await blobToBase64(blob),
        directory: Directory.Cache,
        recursive: true
    });
    return result.uri;
}

/**
 * 打开系统分享面板。
 * @param {{title?: string, text?: string, url?: string, files?: File[], dialogTitle?: string}} data
 * @returns {Promise<ShareResult>}
 */
export async function shareContent({ title, text, url, files, dialogTitle } = {}) {
    if (isNativePlatform()) {
        try {
            const { Share } = await import('@capacitor/share');
            const payload = { title, text, url, dialogTitle: dialogTitle || t('platform:share.dialogTitle') };
            if (files && files.length) payload.files = await Promise.all(files.map((file) => writeTempFile(file, file.name)));
            await Share.share(payload);
            return 'shared';
        } catch (error) {
            return isCancel(error) ? 'cancelled' : 'failed';
        }
    }
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return 'unsupported';
    const data = { title, text, url };
    if (files && files.length) {
        if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files })) return 'unsupported';
        data.files = files;
    }
    try {
        await navigator.share(data);
        return 'shared';
    } catch (error) {
        return isCancel(error) ? 'cancelled' : 'failed';
    }
}

/** 是否能打开系统分享面板（网页端取决于浏览器）。 */
export function canShare({ files } = {}) {
    if (isNativePlatform()) return true;
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
    if (files && files.length) return typeof navigator.canShare === 'function' && navigator.canShare({ files });
    return true;
}

/** @returns {Promise<boolean>} */
export async function copyText(text) {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        // WebView 中剪贴板 API 可能被权限策略拒绝，走降级方案
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        return document.execCommand('copy');
    } catch (e) {
        return false;
    } finally {
        document.body.removeChild(textarea);
    }
}

/**
 * 先尝试系统分享，不支持时复制链接。
 * @returns {Promise<'shared'|'cancelled'|'copied'|'failed'>}
 */
export async function shareOrCopy({ title, text, url, copyValue }) {
    const result = await shareContent({ title, text, url });
    if (result === 'shared' || result === 'cancelled') return result;
    return (await copyText(copyValue || url || text || '')) ? 'copied' : 'failed';
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 保存文件（图片、文本等）。
 * @returns {Promise<'downloaded'|'shared'|'cancelled'|'failed'>}
 *   网页：'downloaded'（交给浏览器下载）
 *   App：系统面板中完成保存/分享为 'shared'，关闭面板为 'cancelled'
 */
export async function saveBlob(blob, filename, { title, dialogTitle = t('platform:share.saveFileDialog') } = {}) {
    const name = safeFileName(filename, 'file');
    if (!isNativePlatform()) {
        try {
            downloadBlob(blob, name);
            return 'downloaded';
        } catch (e) {
            return 'failed';
        }
    }
    try {
        const { Share } = await import('@capacitor/share');
        const uri = await writeTempFile(blob, name);
        await Share.share({ title: title || name, files: [uri], dialogTitle });
        return 'shared';
    } catch (error) {
        return isCancel(error) ? 'cancelled' : 'failed';
    }
}

/** 保存图片：App 内系统面板提供“存储图像”（相册）与“存储到文件”。 */
export function saveImageBlob(blob, filename, { title } = {}) {
    return saveBlob(blob, filename || 'image.png', { title, dialogTitle: t('platform:share.saveImageDialog') });
}

/** 分享图片文件；网页端浏览器不支持文件分享时返回 'unsupported'，由调用方决定是否改为下载。 */
export async function shareImageBlob(blob, filename, { title, text } = {}) {
    const name = safeFileName(filename, 'image.png');
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    return shareContent({ title, text, files: [file], dialogTitle: t('platform:share.shareImageDialog') });
}

export function describeShareResult(result, { copiedText = t('platform:share.copied'), savedText = t('platform:share.imageSaved') } = {}) {
    switch (result) {
        case 'copied': return copiedText;
        case 'downloaded': return savedText;
        case 'failed': return t('platform:share.failed');
        case 'unsupported': return t('platform:share.unsupported');
        default: return '';
    }
}
