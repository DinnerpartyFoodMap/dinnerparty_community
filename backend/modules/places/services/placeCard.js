// 地点链接卡片的内容，分享页 /p/:id（routes/placeShare.js）和 QQ Bot 的卡片消息共用：
//   大标题 —— 店名 · 分类
//   小标题 —— 地点详情（没有详情时用地址，再没有用站点介绍）
//   图片   —— 地点的第一张图（OSS 图片取 300×300 方图），没有图时回退到网站图标 favicon.png
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const imageStorage = require("../../media/services/imageStorage");
const { markdownToPlainText } = require("./markdownText");

const SITE_NAME = "东方饭联地图";
const SITE_TAGLINE = "与饭搭子一起发现身边的美食好店";
// QQ / 微信的链接卡片都是方形小图，原图常有几百 KB：用 OSS 图片处理裁成 300×300 JPG
const OSS_CARD_IMAGE_PROCESS = "x-oss-process=image/auto-orient,1/resize,m_fill,w_300,h_300/quality,q_85/format,jpg";
const OSS_CARD_IMAGE_SIZE = 300;
const FAVICON_PATH = "/favicon.png";
const FAVICON_SIZE = 256;
const CARD_TITLE_MAX = 60;
const CARD_DESCRIPTION_MAX = 120;
// /p/<id>/card-<key>.jpg: the card thumbnail served from the site itself (see loadCardImage).
const CARD_IMAGE_FILE = /^card-([0-9a-f]{8})\.jpg$/;
const CARD_IMAGE_FETCH_TIMEOUT_MS = 8000;
const CARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CARD_IMAGE_CACHE_SIZE = 200;
const CARD_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cardImageCache = new Map();

function truncate(str, max) {
    const s = String(str || '');
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function singleLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function parseImageList(json) {
    try {
        const list = JSON.parse(json || "[]");
        return Array.isArray(list) ? list.filter((item) => typeof item === "string" && item.trim()) : [];
    } catch (e) {
        return [];
    }
}

function absoluteUrl(value, baseUrl) {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith("//")) return `https:${text}`;
    return `${baseUrl}${text.startsWith("/") ? "" : "/"}${text}`;
}

/** 大标题：店名 · 分类 */
function buildCardTitle(place) {
    const name = singleLine(place?.name) || "地点";
    const category = singleLine(place?.category);
    return category ? `${name} · ${category}` : name;
}

/** 小标题：地点详情（链接卡片不能显示 Markdown，去掉标记），没有详情时依次用地址、站点介绍 */
function buildCardDescription(place) {
    return singleLine(markdownToPlainText(place?.description)) || singleLine(place?.address) || `${SITE_NAME} · ${SITE_TAGLINE}`;
}

/**
 * 卡片图片：地点的第一张图（外观图在前、菜单图在后），没有图时回退到网站图标。
 * @param {string} siteBaseUrl 网站地址（协议+主机），用于相对路径和 favicon
 * @param {string} ossImageDir OSS 图片目录（`${OSS_PUBLIC_BASE_URL}/${OSS_PREFIX}/`），未配置时为空
 * @returns {{url: string, width?: number, height?: number}}
 */
function buildCardImage(place, siteBaseUrl, ossImageDir) {
    const [first] = [...parseImageList(place?.exterior_images), ...parseImageList(place?.menu_images)];
    if (!first) return { url: `${siteBaseUrl}${FAVICON_PATH}`, width: FAVICON_SIZE, height: FAVICON_SIZE };
    const url = absoluteUrl(first, siteBaseUrl);
    if (ossImageDir && url.startsWith(ossImageDir) && !url.includes("?")) {
        return { url: `${url}?${OSS_CARD_IMAGE_PROCESS}`, width: OSS_CARD_IMAGE_SIZE, height: OSS_CARD_IMAGE_SIZE };
    }
    return { url };
}

function ossImageDirectory() {
    const { publicBaseUrl, prefix } = imageStorage.readConfig();
    return publicBaseUrl && prefix ? `${publicBaseUrl}/${prefix}/` : "";
}

/** 地点的第一张图（外观图在前、菜单图在后），没有时为 null */
function firstPlaceImage(place) {
    return [...parseImageList(place?.exterior_images), ...parseImageList(place?.menu_images)][0] || null;
}

/**
 * 站内缩略图地址的文件名部分：随第一张图变化，换图后 QQ 不会沿用旧缓存。
 * 没有图时返回 null（卡片用网站图标）。
 */
function cardImageFile(place) {
    const first = firstPlaceImage(place);
    if (!first) return null;
    return `card-${crypto.createHash("sha1").update(first.trim()).digest("hex").slice(0, 8)}.jpg`;
}

async function fetchImageBytes(url, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CARD_IMAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error(`image fetch returned ${response.status}`);
        if (!/^image\//i.test(response.headers.get("content-type") || "")) throw new Error("not an image");
        const declared = Number(response.headers.get("content-length"));
        if (declared > CARD_IMAGE_MAX_BYTES) throw new Error("image too large");
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > CARD_IMAGE_MAX_BYTES) throw new Error("image too large");
        return buffer;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 卡片缩略图：300×300 JPG 的字节。QQ 图文卡片取不到 OSS 处理地址（带 ?x-oss-process 参数、
 * 在 CDN 域名下）的图，网站自己的无参数地址可以，所以由站内 /p/<id>/card-<key>.jpg 提供。
 * 只读两种来源，不按数据库里的任意地址发请求：本地 uploads 下的文件，或本站 OSS 目录
 * （OSS_PUBLIC_BASE_URL/OSS_PREFIX）里的图片；其他地址抛错，由路由回退到网站图标。
 */
async function loadCardImage(imageUrl, { fetchImpl = fetch, ossImageDir = ossImageDirectory() } = {}) {
    const key = String(imageUrl || "").trim();
    const cached = cardImageCache.get(key);
    if (cached && Date.now() - cached.at < CARD_IMAGE_CACHE_TTL_MS) return cached.buffer;

    let source = null;
    const localName = imageStorage.localUploadName(key);
    if (localName && imageStorage.isSafeName(localName)) {
        const file = path.join(imageStorage.LOCAL_UPLOAD_DIR, localName);
        if (fs.existsSync(file)) source = await fs.promises.readFile(file);
    }
    if (!source) {
        let ossUrl = null;
        if (ossImageDir && key.startsWith(ossImageDir) && !key.includes("?")) ossUrl = key;
        else if (localName) ossUrl = imageStorage.legacyRedirectUrl(localName);
        if (!ossUrl) throw new Error("card image is not stored by this site");
        // OSS 先裁成 300×300（几十 KB），失败时再取原图本地缩放
        source = await fetchImageBytes(`${ossUrl}?${OSS_CARD_IMAGE_PROCESS}`, fetchImpl)
            .catch(() => fetchImageBytes(ossUrl, fetchImpl));
    }
    const buffer = await sharp(source, { limitInputPixels: 40000000 })
        .rotate()
        .resize(OSS_CARD_IMAGE_SIZE, OSS_CARD_IMAGE_SIZE, { fit: "cover" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    if (cardImageCache.size >= CARD_IMAGE_CACHE_SIZE) cardImageCache.delete(cardImageCache.keys().next().value);
    cardImageCache.set(key, { buffer, at: Date.now() });
    return buffer;
}

/** 卡片三要素，标题和小标题已按卡片长度截断 */
function buildPlaceCard(place, siteBaseUrl, ossImageDir = ossImageDirectory()) {
    return {
        title: truncate(buildCardTitle(place), CARD_TITLE_MAX),
        description: truncate(buildCardDescription(place), CARD_DESCRIPTION_MAX),
        image: buildCardImage(place, siteBaseUrl, ossImageDir)
    };
}

module.exports = {
    SITE_NAME,
    SITE_TAGLINE,
    FAVICON_PATH,
    CARD_TITLE_MAX,
    CARD_DESCRIPTION_MAX,
    truncate,
    singleLine,
    buildCardTitle,
    buildCardDescription,
    buildCardImage,
    buildPlaceCard,
    ossImageDirectory,
    firstPlaceImage,
    cardImageFile,
    loadCardImage,
    CARD_IMAGE_FILE,
    _clearCardImageCacheForTesting: () => cardImageCache.clear()
};
