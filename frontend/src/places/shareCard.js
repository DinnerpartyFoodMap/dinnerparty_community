// 地点分享卡片：以地点为中心的地图截图 + 外围信息框 + 二维码，横竖两版。
// 地图来自后端 /api/amap/staticmap（同源、可缓存），标题与信息由 Canvas 绘制，
// 不依赖 HTML 截图，App 与网页输出一致。版式见 doc/README.md 与 doc/TEST_CASES.md。
import QRCode from 'qrcode';

export const CARD_SIZE = {
    portrait: { width: 1200, height: 1600 },
    landscape: { width: 1600, height: 900 }
};

export const CARD_BRAND = {
    primary: '#E2789F',
    secondary: '#8C6BB1',
    ink: '#4A2438',
    inkSoft: 'rgba(74, 36, 56, 0.72)',
    inkFaint: 'rgba(74, 36, 56, 0.55)',
    paper: '#FFF6F8',
    paperTint: '#F9E4EB',
    line: '#F0C9D6',
    white: '#FFFFFF'
};

export const DEFAULT_MAP_ZOOM = 16;

const NAME_MAX = 26;
const CATEGORY_MAX = 12;
const ADDRESS_MAX = 40;
const LABEL_MAX = 14;
const TITLE_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
const BODY_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const MAP_FALLBACK_TINT = '#F5E3E9';

// 版式：坐标以 1x 画布为准；地图请求尺寸按 rect 的一半取 2x，正好铺满不裁切。
export const CARD_LAYOUTS = {
    portrait: {
        border: { inset: 24, width: 6, hairline: 44 },
        title: { x: 64, y: 150, size: 62 },
        subtitle: { x: 64, y: 192, size: 24 },
        map: { x: 64, y: 236, w: 1072, h: 800 },
        category: { x: 64, y: 1118, size: 28 },
        name: { x: 64, bottom: 1272, size: 58, lineHeight: 72, maxWidth: 780 },
        meta: { x: 64, y: 1330, size: 32 },
        address: { x: 64, y: 1382, size: 28, lineHeight: 38, maxWidth: 780 },
        divider: { x: 64, y: 1452, w: 1072 },
        brand: { x: 64, y: 1496, size: 30 },
        tagline: { x: 64, y: 1528, size: 22 },
        qr: { box: 224, x: 892, y: 1290 },
        scanHint: { x: 1004, y: 1548, size: 22 }
    },
    landscape: {
        border: { inset: 24, width: 6, hairline: 44 },
        title: { x: 64, y: 140, size: 52 },
        subtitle: { x: 64, y: 176, size: 22 },
        map: { x: 628, y: 64, w: 908, h: 772 },
        category: { x: 64, y: 238, size: 26 },
        name: { x: 64, bottom: 356, size: 44, lineHeight: 54, maxWidth: 536 },
        meta: { x: 64, y: 412, size: 30 },
        address: { x: 64, y: 456, size: 26, lineHeight: 34, maxWidth: 536 },
        divider: { x: 64, y: 500, w: 520 },
        brand: { x: 64, y: 544, size: 26 },
        tagline: { x: 64, y: 576, size: 21 },
        qr: { box: 176, x: 64, y: 610 },
        scanHint: { x: 152, y: 818, size: 21 }
    }
};

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function singleLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
    const value = singleLine(text);
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/** 保存到相册/文件时的文件名，去掉各平台不接受的字符。 */
export function sanitizeFileName(value, fallback = 'place-card') {
    const cleaned = String(value || '')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    return cleaned || fallback;
}

/**
 * 卡片数据：把地点与界面文案整理成绘制需要的字段，纯函数便于测试。
 * @param {object} place 地点（name/category/address/longitude/latitude）
 * @param {{title?: string, siteName?: string, tagline?: string, metaText?: string, ratingText?: string,
 *   scanHint?: string, url?: string, mapServiceUrl?: string, fallbackName?: string,
 *   fallbackCategory?: string, zoom?: number}} options 文案与地图服务地址
 */
export function buildShareCardModel(place, options = {}) {
    const longitude = Number(place?.longitude);
    const latitude = Number(place?.latitude);
    const hasCoordinates = Number.isFinite(longitude) && Number.isFinite(latitude)
        && Math.abs(latitude) <= 85 && Math.abs(longitude) <= 180;
    const name = truncate(place?.name || options.fallbackName, NAME_MAX);
    const meta = [singleLine(options.metaText), singleLine(options.ratingText)].filter(Boolean).join('  ·  ');
    const zoom = Number(options.zoom);

    return {
        name,
        category: truncate(place?.category || options.fallbackCategory, CATEGORY_MAX),
        address: truncate(place?.address, ADDRESS_MAX),
        meta,
        title: singleLine(options.title),
        siteName: singleLine(options.siteName),
        tagline: singleLine(options.tagline),
        scanHint: singleLine(options.scanHint),
        url: singleLine(options.url),
        mapServiceUrl: singleLine(options.mapServiceUrl),
        longitude,
        latitude,
        hasCoordinates,
        zoom: Number.isInteger(zoom) && zoom >= 1 && zoom <= 17 ? zoom : DEFAULT_MAP_ZOOM,
        fileNameBase: sanitizeFileName(name)
    };
}

/** 静态地图请求：location 只取一位小数以上的精度，尺寸按版式一半取 2x。 */
export function buildMapUrl(model, orientation = 'portrait') {
    const layout = CARD_LAYOUTS[orientation] || CARD_LAYOUTS.portrait;
    if (!model?.mapServiceUrl || !model.hasCoordinates) return '';
    const params = new URLSearchParams({
        location: `${model.longitude},${model.latitude}`,
        zoom: String(model.zoom),
        size: `${Math.round(layout.map.w / 2)}*${Math.round(layout.map.h / 2)}`,
        scale: '2',
        traffic: '0'
    });
    return `${model.mapServiceUrl}?${params.toString()}`;
}

function roundedPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
    const source = singleLine(text);
    if (!source) return [];
    const lines = [];
    let current = '';
    for (const character of source) {
        const next = current + character;
        if (current && ctx.measureText(next).width > maxWidth) {
            lines.push(current);
            current = character;
        } else {
            current = next;
        }
    }
    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    const visible = lines.slice(0, maxLines);
    let last = visible[visible.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    visible[visible.length - 1] = `${last}…`;
    return visible;
}

function loadImage(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('image load failed'));
        image.src = source;
    });
}

async function loadMapImage(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, { credentials: 'omit' });
        if (!response.ok) return null;
        const contentType = String(response.headers.get('content-type') || '');
        if (!contentType.startsWith('image/')) return null;
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        try {
            return await loadImage(objectUrl);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    } catch (e) {
        return null;
    }
}

const qrCache = new Map();

function qrDataUrl(value) {
    if (!qrCache.has(value)) {
        const task = QRCode.toDataURL(value, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 480,
            color: { dark: '#4A2438', light: '#FFFFFF' }
        }).catch((error) => {
            qrCache.delete(value);
            throw error;
        });
        qrCache.set(value, task);
    }
    return qrCache.get(value);
}

function coverDraw(ctx, image, rect) {
    const ratio = Math.max(rect.w / image.width, rect.h / image.height);
    const width = image.width * ratio;
    const height = image.height * ratio;
    ctx.drawImage(image, rect.x + (rect.w - width) / 2, rect.y + (rect.h - height) / 2, width, height);
}

function paintPaper(ctx, size, layout) {
    ctx.fillStyle = CARD_BRAND.paper;
    ctx.fillRect(0, 0, size.width, size.height);

    ctx.fillStyle = CARD_BRAND.paperTint;
    ctx.fillRect(0, 0, size.width, 12);
    ctx.fillRect(0, size.height - 12, size.width, 12);

    ctx.strokeStyle = CARD_BRAND.primary;
    ctx.lineWidth = layout.border.width;
    const inset = layout.border.inset + layout.border.width / 2;
    ctx.strokeRect(inset, inset, size.width - inset * 2, size.height - inset * 2);

    ctx.strokeStyle = CARD_BRAND.line;
    ctx.lineWidth = 1;
    const hair = layout.border.hairline + 0.5;
    ctx.strokeRect(hair, hair, size.width - hair * 2, size.height - hair * 2);
}

function paintMapFallback(ctx, rect) {
    ctx.fillStyle = MAP_FALLBACK_TINT;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = 'rgba(226, 120, 159, 0.18)';
    ctx.lineWidth = 2;
    for (let offset = -rect.h; offset < rect.w; offset += 48) {
        ctx.beginPath();
        ctx.moveTo(rect.x + offset, rect.y + rect.h);
        ctx.lineTo(rect.x + offset + rect.h, rect.y);
        ctx.stroke();
    }
}

function paintMarker(ctx, centerX, centerY, label, rect) {
    const tipY = centerY + 34;
    const radius = 24;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(centerX, tipY);
    ctx.bezierCurveTo(centerX - radius * 1.5, tipY - radius * 1.5, centerX - radius, tipY - radius * 2.7, centerX, tipY - radius * 2.7);
    ctx.bezierCurveTo(centerX + radius, tipY - radius * 2.7, centerX + radius * 1.5, tipY - radius * 1.5, centerX, tipY);
    ctx.closePath();
    ctx.fillStyle = CARD_BRAND.primary;
    ctx.fill();
    ctx.strokeStyle = CARD_BRAND.white;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, tipY - radius * 1.62, radius * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = CARD_BRAND.white;
    ctx.fill();
    ctx.restore();

    if (!label) return;
    ctx.font = `500 26px ${BODY_FONT}`;
    const text = truncate(label, LABEL_MAX);
    const paddingX = 18;
    const boxWidth = Math.min(ctx.measureText(text).width + paddingX * 2, Math.min(rect.w - 32, 420));
    const boxHeight = 46;
    const boxX = clamp(centerX - boxWidth / 2, rect.x + 16, rect.x + rect.w - boxWidth - 16);
    let boxY = tipY - radius * 2.7 - 18 - boxHeight;
    if (boxY < rect.y + 16) boxY = tipY + 22;

    ctx.save();
    roundedPath(ctx, boxX, boxY, boxWidth, boxHeight, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.fill();
    ctx.strokeStyle = CARD_BRAND.primary;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = CARD_BRAND.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, boxX + boxWidth / 2, boxY + boxHeight / 2 + 1, boxWidth - paddingX * 2);
    ctx.restore();
}

async function paintMap(ctx, layout, model, key) {
    const rect = layout.map;
    const image = await loadMapImage(buildMapUrl(model, key));
    ctx.save();
    roundedPath(ctx, rect.x, rect.y, rect.w, rect.h, 6);
    ctx.clip();
    if (image) coverDraw(ctx, image, rect);
    else paintMapFallback(ctx, rect);
    if (model.hasCoordinates) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.beginPath();
        ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, 74, 0, Math.PI * 2);
        ctx.fill();
        paintMarker(ctx, rect.x + rect.w / 2, rect.y + rect.h / 2, model.name, rect);
    }
    ctx.restore();

    ctx.strokeStyle = CARD_BRAND.line;
    ctx.lineWidth = 2;
    roundedPath(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 6);
    ctx.stroke();
}

function paintTitle(ctx, layout, model) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (model.title) {
        ctx.fillStyle = CARD_BRAND.ink;
        ctx.font = `500 ${layout.title.size}px ${TITLE_FONT}`;
        ctx.fillText(model.title, layout.title.x, layout.title.y);
        ctx.fillStyle = CARD_BRAND.primary;
        ctx.fillRect(layout.title.x, layout.title.y + 14, Math.min(150, ctx.measureText(model.title).width), 4);
    }
    if (model.siteName) {
        ctx.fillStyle = CARD_BRAND.secondary;
        ctx.font = `500 ${layout.subtitle.size}px ${BODY_FONT}`;
        ctx.fillText(model.siteName, layout.subtitle.x, layout.subtitle.y);
    }
}

function paintInfo(ctx, layout, model) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if (model.category) {
        ctx.fillStyle = CARD_BRAND.primary;
        ctx.font = `500 ${layout.category.size}px ${BODY_FONT}`;
        ctx.fillText(model.category, layout.category.x, layout.category.y);
    }

    ctx.fillStyle = CARD_BRAND.ink;
    ctx.font = `600 ${layout.name.size}px ${TITLE_FONT}`;
    const nameLines = wrapText(ctx, model.name, layout.name.maxWidth, 2);
    nameLines.forEach((line, index) => {
        const baseline = layout.name.bottom - (nameLines.length - 1 - index) * layout.name.lineHeight;
        ctx.fillText(line, layout.name.x, baseline);
    });

    if (model.meta) {
        ctx.fillStyle = CARD_BRAND.inkSoft;
        ctx.font = `400 ${layout.meta.size}px ${BODY_FONT}`;
        ctx.fillText(model.meta, layout.meta.x, layout.meta.y, layout.name.maxWidth);
    }

    if (model.address) {
        ctx.fillStyle = CARD_BRAND.inkFaint;
        ctx.font = `400 ${layout.address.size}px ${BODY_FONT}`;
        const addressLines = wrapText(ctx, model.address, layout.address.maxWidth, 2);
        addressLines.forEach((line, index) => {
            ctx.fillText(line, layout.address.x, layout.address.y + index * layout.address.lineHeight);
        });
    }

    ctx.strokeStyle = CARD_BRAND.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.divider.x, layout.divider.y);
    ctx.lineTo(layout.divider.x + layout.divider.w, layout.divider.y);
    ctx.stroke();

    if (model.siteName) {
        ctx.fillStyle = CARD_BRAND.ink;
        ctx.font = `600 ${layout.brand.size}px ${BODY_FONT}`;
        ctx.fillText(model.siteName, layout.brand.x, layout.brand.y);
    }
    if (model.tagline) {
        ctx.fillStyle = CARD_BRAND.inkFaint;
        ctx.font = `400 ${layout.tagline.size}px ${BODY_FONT}`;
        ctx.fillText(model.tagline, layout.tagline.x, layout.tagline.y, layout.divider.w);
    }
}

async function paintQr(ctx, layout, model) {
    if (!model.url) return;
    const box = layout.qr.box;
    const image = await loadImage(await qrDataUrl(model.url));
    ctx.save();
    roundedPath(ctx, layout.qr.x, layout.qr.y, box, box, 16);
    ctx.fillStyle = CARD_BRAND.white;
    ctx.fill();
    ctx.strokeStyle = CARD_BRAND.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    const padding = box * 0.075;
    ctx.drawImage(image, layout.qr.x + padding, layout.qr.y + padding, box - padding * 2, box - padding * 2);
    ctx.restore();

    if (model.scanHint) {
        ctx.fillStyle = CARD_BRAND.secondary;
        ctx.font = `400 ${layout.scanHint.size}px ${BODY_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(model.scanHint, layout.scanHint.x, layout.scanHint.y, box + 160);
        ctx.textAlign = 'left';
    }
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('card export failed'))), 'image/jpeg', 0.92);
    });
}

/**
 * 绘制并导出卡片。
 * @param {ReturnType<typeof buildShareCardModel>} model
 * @param {'portrait'|'landscape'} orientation
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function createPlaceShareCard(model, orientation = 'portrait') {
    const key = orientation === 'landscape' ? 'landscape' : 'portrait';
    const layout = CARD_LAYOUTS[key];
    const size = CARD_SIZE[key];
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unsupported');

    paintPaper(ctx, size, layout);
    await paintMap(ctx, layout, model, key);
    paintTitle(ctx, layout, model);
    paintInfo(ctx, layout, model);
    await paintQr(ctx, layout, model);

    const blob = await canvasToBlob(canvas);
    return { blob, filename: `${model.fileNameBase}-${key}.jpg` };
}
