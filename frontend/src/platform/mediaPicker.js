// 选图 / 拍照与上传前处理。
// 网页：隐藏的 <input type="file">；App：系统照片选择与相机（@capacitor/camera），取消选择视为正常结果。
// prepareImageForUpload 负责格式检查（HEIC）、EXIF 方向、大图压缩，并按各接口的大小上限输出。

import { isNativePlatform } from './env.js';
import { t } from '../i18n/index.js';

/**
 * 各上传接口的实际限制（maxBytes 与后端保持一致）；quality 为需要重新编码时的 JPEG 质量。
 * 地点图片公开展示且列表走 OSS 缩略图，原图尽量保留画质；头像、日记图片后端还会再缩放转码。
 */
export const UPLOAD_LIMITS = {
    placeImage: { maxBytes: 20 * 1024 * 1024, targetBytes: 10 * 1024 * 1024, maxDimension: 4096, quality: 0.92 }, // POST /upload
    avatar: { maxBytes: 5 * 1024 * 1024, targetBytes: 2 * 1024 * 1024, maxDimension: 2048, quality: 0.86 },        // PUT /users/me/avatar（裁剪后上传）
    journeyMedia: { maxBytes: 5 * 1024 * 1024, targetBytes: 4 * 1024 * 1024, maxDimension: 2560, quality: 0.86 }, // POST /api/journeys/media
    feedbackImage: { maxBytes: 10 * 1024 * 1024, targetBytes: 3 * 1024 * 1024, maxDimension: 2048, quality: 0.86 } // POST /api/feedback（后端再缩到 2048 内转 WebP）
};

// App 内选图 / 拍照：插件按质量 100 把照片（含 HEIC）转成 JPEG，几乎无损，只作为中间结果；
// 真正的压缩只在 prepareImageForUpload 里按各接口的 quality 做一次，避免插件、网页各压一遍。
// 不让插件缩放：它会把小于目标尺寸的图片放大。
const NATIVE_INTERMEDIATE_QUALITY = 100;
const nativeIntermediates = new WeakSet();

export class MediaError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// Camera 插件以错误码报告取消：OS-PLUG-CAMR-0006（拍照取消）、OS-PLUG-CAMR-0020（选图取消）
const CANCEL_CODES = new Set(['OS-PLUG-CAMR-0006', 'OS-PLUG-CAMR-0020']);
const isCancel = (error) => CANCEL_CODES.has(error && error.code)
    || /cancel|canceled|cancelled|取消/i.test(String(error && (error.message || error.errorMessage || error)));

/**
 * App 内“拍照 / 从相册选择”：优先交给统一浮层（底部操作面板，返回键/动效/原生控件收起一致）；
 * 浮层宿主未挂载时使用下面不依赖 React 的轻量面板。
 */
async function chooseSource() {
    try {
        const { hasActionSheetHost, requestActionSheet } = await import('../components/overlay/ActionSheet.jsx');
        if (hasActionSheetHost()) {
            return requestActionSheet({
                title: t('common:action.addImage'),
                actions: [{ value: 'camera', label: t('common:action.takePhoto') }, { value: 'library', label: t('common:action.chooseFromAlbum') }]
            });
        }
    } catch (e) { /* 回退到轻量面板 */ }
    return chooseSourceFallback();
}

function chooseSourceFallback() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', t('common:action.addImage'));
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '20000', background: 'var(--color-backdrop, rgba(0,0,0,.35))',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center'
        });
        const sheet = document.createElement('div');
        Object.assign(sheet.style, {
            width: 'min(480px, 100%)', boxSizing: 'border-box', background: 'var(--color-bg-surface, #fff)',
            color: 'var(--color-text-primary, #222)', borderRadius: '16px 16px 0 0',
            padding: '12px 12px calc(12px + var(--safe-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: '8px'
        });
        let done = false;
        let removeBack = null;
        const finish = (value) => {
            if (done) return;
            done = true;
            if (removeBack) removeBack();
            overlay.remove();
            resolve(value);
        };
        [['camera', t('common:action.takePhoto')], ['library', t('common:action.chooseFromAlbum')], [null, t('common:action.cancel')]].forEach(([value, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            Object.assign(button.style, {
                padding: '14px', fontSize: '16px', borderRadius: '10px', border: '1px solid var(--color-border, #ddd)',
                background: value ? 'var(--color-bg-overlay, #f4f4f4)' : 'transparent', color: 'inherit'
            });
            button.addEventListener('click', () => finish(value));
            sheet.appendChild(button);
        });
        overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
        import('./backButton.js').then(({ pushBackHandler, BACK_PRIORITY }) => {
            if (!done) removeBack = pushBackHandler(() => { finish(null); return true; }, BACK_PRIORITY.DIALOG);
        });
    });
}

function pickWithInput({ multiple, capture }) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = !!multiple;
        if (capture) input.setAttribute('capture', 'environment');
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        let done = false;
        const finish = (files) => {
            if (done) return;
            done = true;
            window.removeEventListener('focus', onFocus);
            input.remove();
            resolve(files);
        };
        // 'cancel' 事件较新；旧浏览器用窗口重新获得焦点作为兜底
        const onFocus = () => window.setTimeout(() => { if (!input.files || !input.files.length) finish([]); }, 800);
        input.addEventListener('change', () => finish(Array.from(input.files || [])));
        input.addEventListener('cancel', () => finish([]));
        window.addEventListener('focus', onFocus);
        document.body.appendChild(input);
        input.click();
    });
}

async function mediaToFile(media, index) {
    const response = await fetch(media.webPath);
    const blob = await response.blob();
    const rawFormat = String((media.metadata && media.metadata.format) || blob.type.split('/')[1] || 'jpeg').toLowerCase();
    const format = rawFormat === 'jpg' ? 'jpeg' : rawFormat;
    const type = blob.type || `image/${format}`;
    const file = new File([blob], `photo-${Date.now()}-${index}.${format === 'jpeg' ? 'jpg' : format}`, { type });
    nativeIntermediates.add(file);
    return file;
}

async function pickNative({ multiple, source, limit }) {
    const { Camera, MediaTypeSelection, EncodingType } = await import('@capacitor/camera');
    let target = source;
    if (target === 'prompt') {
        target = await chooseSource();
        if (!target) return [];
    }
    try {
        if (target === 'camera') {
            const media = await Camera.takePhoto({ quality: NATIVE_INTERMEDIATE_QUALITY, correctOrientation: true, encodingType: EncodingType.JPEG });
            return media && media.webPath ? [await mediaToFile(media, 0)] : [];
        }
        const result = await Camera.chooseFromGallery({
            mediaType: MediaTypeSelection.Photo,
            allowMultipleSelection: !!multiple,
            limit: multiple ? (limit || 0) : 1,
            quality: NATIVE_INTERMEDIATE_QUALITY,
            correctOrientation: true
        });
        const items = ((result && result.results) || []).filter((item) => item && item.webPath);
        return Promise.all(items.map(mediaToFile));
    } catch (error) {
        if (isCancel(error)) return [];
        if (/denied|permission/i.test(String(error && error.message))) {
            throw new MediaError('PERMISSION_DENIED', t('platform:mediaPicker.permissionDenied'));
        }
        throw new MediaError('PICK_FAILED', t('platform:mediaPicker.pickFailed'));
    }
}

/**
 * 选择图片。
 * @param {{ multiple?: boolean, source?: 'prompt'|'camera'|'library', limit?: number }} options
 * @returns {Promise<File[]>} 用户取消时返回空数组
 */
export async function pickImages({ multiple = false, source = 'prompt', limit } = {}) {
    if (isNativePlatform()) {
        try {
            return await pickNative({ multiple, source, limit });
        } catch (error) {
            if (error instanceof MediaError) throw error;
            // 插件不可用时退回 WebView 自带的文件选择
        }
    }
    const files = await pickWithInput({ multiple, capture: source === 'camera' });
    return limit ? files.slice(0, limit) : files;
}

function isHeic(file) {
    return /image\/hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');
}

async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            // from-image：按 EXIF 方向摆正像素
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (e) {
            // 部分 WebView 不支持该选项或格式，回退到 <img>
        }
    }
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.decoding = 'async';
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('decode failed'));
            image.src = url;
        });
        return image;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), type, quality);
    });
}

function formatMB(bytes) {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/**
 * 上传前处理图片：
 *  - 非图片 → 拒绝；HEIC 在当前环境无法解码 → 给出可操作的提示
 *  - 尺寸或体积超出目标、HEIC、App 插件给出的中间结果 → 按 EXIF 方向摆正后缩放，按 limits.quality 重新编码为 JPEG
 *  - 已符合要求的 JPEG/PNG/WebP/GIF 原图 → 原样返回，避免二次压缩
 *    （拍摄位置等元数据由后端 /upload 去掉；头像、日记图片后端会重新转码）
 * @param {File} file
 * @param {{maxBytes:number, targetBytes:number, maxDimension:number, quality?:number}} limits
 * @returns {Promise<File>}
 */
export async function prepareImageForUpload(file, limits = UPLOAD_LIMITS.placeImage) {
    if (!file) throw new MediaError('NO_FILE', t('platform:mediaPicker.noFile'));
    const typeOk = /^image\//i.test(file.type || '') || isHeic(file);
    if (!typeOk) throw new MediaError('NOT_IMAGE', t('platform:mediaPicker.notImage'));

    const heic = isHeic(file);
    const passthroughType = /^image\/(jpeg|png|webp|gif)$/i.test(file.type || '');
    if (/^image\/gif$/i.test(file.type || '')) {
        if (file.size > limits.maxBytes) throw new MediaError('TOO_LARGE', t('platform:mediaPicker.gifTooLarge', { formatMB: formatMB(limits.maxBytes) }));
        return file;
    }

    let decoded;
    try {
        decoded = await decodeImage(file);
    } catch (error) {
        if (heic) throw new MediaError('HEIC_UNSUPPORTED', t('platform:mediaPicker.heicUnsupported'));
        throw new MediaError('DECODE_FAILED', t('platform:mediaPicker.decodeFailed'));
    }

    const width = decoded.width || decoded.naturalWidth;
    const height = decoded.height || decoded.naturalHeight;
    const longest = Math.max(width, height);
    const needsResize = longest > limits.maxDimension;
    const needsShrink = file.size > limits.targetBytes;
    if (passthroughType && !heic && !needsResize && !needsShrink && !nativeIntermediates.has(file)) {
        if (typeof decoded.close === 'function') decoded.close();
        return file;
    }

    const scale = needsResize ? limits.maxDimension / longest : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PNG 透明区域转 JPEG 时避免变黑
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    if (typeof decoded.close === 'function') decoded.close();

    let quality = limits.quality || 0.86;
    let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    while (blob.size > limits.targetBytes && quality > 0.5) {
        quality -= 0.12;
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }
    if (blob.size > limits.maxBytes) throw new MediaError('TOO_LARGE', t('platform:mediaPicker.imageTooLarge', { formatMB: formatMB(limits.maxBytes) }));
    const name = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

/** 便捷组合：选择并处理图片。单张处理失败会抛出 MediaError。 */
export async function pickPreparedImages(options = {}, limits = UPLOAD_LIMITS.placeImage) {
    const files = await pickImages(options);
    const prepared = [];
    for (const file of files) prepared.push(await prepareImageForUpload(file, limits));
    return prepared;
}
