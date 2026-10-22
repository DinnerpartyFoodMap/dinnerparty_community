// 地点分享页 /p/:id：给 QQ / 微信等抓取链接卡片用的服务端 HTML，普通浏览器由 JS 跳转到地图。
//
// 卡片字段（与前端系统分享的标题一致，见 frontend/src/map/MapUI.jsx handleSharePlace）：
//   大标题 —— 店名 · 分类
//   小标题 —— 地点详情（没有详情时用地址，再没有用站点介绍）
//   图片   —— 地点的第一张图（OSS 图片取 300×300 方图），没有图时回退到网站图标 favicon.png
// QQ 读取 schema.org 微数据（<html itemscope> + <meta itemprop="name|description|image">），
// 其他平台读取 Open Graph；两套标签内容相同。图片必须是绝对地址，QQ 卡片不认 .ico。
const express = require("express");
const router = express.Router();
const { db } = require("../../../infrastructure/database");
const { markdownToPlainText } = require("../services/markdownText");
const {
    SITE_NAME,
    SITE_TAGLINE,
    FAVICON_PATH,
    buildCardTitle,
    buildCardDescription,
    buildCardImage,
    buildPlaceCard,
    ossImageDirectory,
    firstPlaceImage,
    loadCardImage,
    CARD_IMAGE_FILE
} = require("../services/placeCard");

// QQ / 微信打开链接时会在末尾追加参数（如 ?qq_aio_chat_type=2），地点只认路径里的 id
const PLACE_ID = /^(\d{1,15})(?!\d)/;

function htmlEscape(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildFrontendPlaceUrl(req, id) {
    const placeParam = `/?place=${id}`;
    const configured = process.env.FRONTEND_BASE_URL;
    if (configured) {
        return `${String(configured).replace(/\/+$/, "")}${placeParam}`;
    }

    const protocol = "https";
    const host = (req.get("host") || "").replace(/:\d+$/, "");

    // 本地开发
    if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
        return `${protocol}://${host}:5173${placeParam}`;
    }

    // 生产环境：使用请求的实际域名（已移除端口号，确保与 dinners 一致）
    return `${protocol}://${host}${placeParam}`;
}

function buildAmapNavUrl(place) {
    const lng = Number(place?.longitude);
    const lat = Number(place?.latitude);
    const label = encodeURIComponent((place?.name || "目的地").trim());
    return `https://uri.amap.com/navigation?to=${lng},${lat},${label}&mode=car&src=yUYUko_food_MAP`;
}

/** nav=amap 才是导航分享；客户端把参数直接拼在后面时（nav=amap?qq_aio_chat_type=2）也要认出来 */
function isAmapNav(value) {
    return String(value || "").split(/[?&#]/)[0] === "amap";
}

/**
 * @param {{place: object, canonicalUrl: string, frontendUrl: string, siteBaseUrl: string, isNavShare: boolean, ossImageDir?: string}} input
 */
function renderShareHtml({ place, canonicalUrl, frontendUrl, siteBaseUrl, isNavShare, ossImageDir = "" }) {
    const card = buildPlaceCard(place, siteBaseUrl, ossImageDir);
    const image = card.image;

    const safeTitle = htmlEscape(card.title);
    const safeDescription = htmlEscape(card.description);
    const safeImageUrl = htmlEscape(image.url);
    const safeCanonicalUrl = htmlEscape(canonicalUrl);
    const safeFaviconUrl = htmlEscape(`${siteBaseUrl}${FAVICON_PATH}`);
    const imageSizeMeta = image.width && image.height
        ? `\n  <meta property="og:image:width" content="${image.width}" />\n  <meta property="og:image:height" content="${image.height}" />`
        : "";

    const placeName = place.name || "地点";
    const safeName = htmlEscape(placeName);
    const safeCategory = htmlEscape(place.category || "");
    // 跳转页只放纯文字：去掉 Markdown 标记后再转义
    const safePlaceDescription = htmlEscape(markdownToPlainText(place.description));
    const safeAddress = htmlEscape(place.address || "");

    const actionLabel = isNavShare ? "打开高德地图导航" : "在地图中查看";
    const actionUrl = htmlEscape(isNavShare ? buildAmapNavUrl(place) : frontendUrl);
    // JS 跳转目标（不含 HTML 转义，直接用于 JS 字符串）
    const jsRedirectUrl = (isNavShare ? buildAmapNavUrl(place) : frontendUrl)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/</g, "\\x3c");

    return `<!DOCTYPE html>
<html lang="zh-CN" itemscope itemtype="https://schema.org/WebPage">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}" />
  <link rel="canonical" href="${safeCanonicalUrl}" />
  <link rel="icon" type="image/png" href="${safeFaviconUrl}" />
  <link rel="apple-touch-icon" href="${safeFaviconUrl}" />

  <!-- QQ：schema.org 微数据 -->
  <meta itemprop="name" content="${safeTitle}" />
  <meta itemprop="description" content="${safeDescription}" />
  <meta itemprop="image" content="${safeImageUrl}" />

  <!-- Open Graph（微信 / Telegram / iOS 链接预览等） -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${htmlEscape(SITE_NAME)}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:url" content="${safeCanonicalUrl}" />
  <meta property="og:image" content="${safeImageUrl}" />${imageSizeMeta}
  <meta name="twitter:card" content="summary" />

  <style>
    body { margin:0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background:#f4f7fb; color:#102a43; }
    .wrap { max-width: 760px; margin: 40px auto; padding: 24px; }
    .card { background:white; border-radius:16px; padding:24px; box-shadow:0 8px 40px rgba(16,42,67,0.12); }
    h1 { margin: 0 0 12px; font-size: 32px; }
    p { margin: 8px 0; line-height: 1.6; }
    .meta { color:#486581; }
    .btn { display:inline-block; margin-top:16px; background:#0f609b; color:white; text-decoration:none; padding:10px 16px; border-radius:10px; }
  </style>
  <script>
    // 正常浏览器自动跳转到目标页；爬虫不执行 JS，会看到完整 meta 标签
    location.replace('${jsRedirectUrl}');
  </script>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${safeName}</h1>
      ${safeCategory ? `<p class="meta">🏷 ${safeCategory}</p>` : ""}
      ${safePlaceDescription ? `<p class="meta">${safePlaceDescription}</p>` : ""}
      ${safeAddress ? `<p>📍 ${safeAddress}</p>` : ""}
      <a class="btn" href="${actionUrl}">${actionLabel}</a>
    </div>
    <p style="text-align:center;color:#829ab1;margin-top:24px;font-size:14px;">
      ${htmlEscape(`${SITE_NAME} — ${SITE_TAGLINE}`)}
    </p>
  </div>
</body>
</html>`;
}

// 卡片缩略图 /p/<id>/card-<key>.jpg：300×300 JPG，由本站提供（QQ 图文卡片取不到 OSS 处理地址的图）。
// key 随第一张图变化；取不到图时跳转到网站图标。
router.get("/:id/:file", async (req, res) => {
    const idMatch = /^\d{1,15}$/.exec(String(req.params.id || ""));
    if (!idMatch || !CARD_IMAGE_FILE.test(String(req.params.file || ""))) return res.status(404).send("Not Found");
    const fallback = () => {
        res.set("Cache-Control", "public, max-age=300");
        return res.redirect(302, FAVICON_PATH);
    };
    try {
        const place = db._raw.prepare("SELECT exterior_images, menu_images FROM Place WHERE id = ?").get(idMatch[0]);
        const image = place && firstPlaceImage(place);
        if (!image) return fallback();
        const buffer = await loadCardImage(image);
        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "public, max-age=86400");
        return res.send(buffer);
    } catch (error) {
        return fallback();
    }
});

router.get("/:id", (req, res) => {
    const idMatch = PLACE_ID.exec(String(req.params.id || ""));
    if (!idMatch) return res.status(404).send("地点不存在");
    const placeId = idMatch[1];
    const isNavShare = isAmapNav(req.query.nav);

    const sql = `SELECT p.*, u.username AS creator_name
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 WHERE p.id = ?`;

    db.get(sql, [placeId], (err, place) => {
        if (err) return res.status(500).send("Server Error");
        if (!place) return res.status(404).send("地点不存在");

        const rawHost = req.get("host") || "";
        // 去掉端口号：与 buildFrontendPlaceUrl 保持一致，确保 og:image 等 URL 使用标准端口（443）
        const host = rawHost.replace(/:\d+$/, "");
        const proto = (req.get("x-forwarded-proto") || req.protocol || "https");
        // 规范地址只保留 nav 参数，QQ / 微信追加的参数不进卡片
        const canonicalUrl = `${proto}://${host}${req.baseUrl}/${placeId}${isNavShare ? "?nav=amap" : ""}`;
        const frontendUrl = buildFrontendPlaceUrl(req, placeId);
        // 网站地址从 frontendUrl 派生，FRONTEND_BASE_URL 配置同样生效
        const siteBaseUrl = frontendUrl.replace(/\/\?.*$/, '').replace(/\/$/, '');

        // 始终返回带卡片标签的 HTML，不用 302：客户端分享时会从最终页面（SPA，无地点标签）取元数据。
        // 正常浏览器通过 JS 跳转到目标页面。
        res.set("Content-Type", "text/html; charset=utf-8");
        return res.send(renderShareHtml({
            place,
            canonicalUrl,
            frontendUrl,
            siteBaseUrl,
            isNavShare,
            ossImageDir: ossImageDirectory()
        }));
    });
});

router.buildCardTitle = buildCardTitle;
router.buildCardDescription = buildCardDescription;
router.buildCardImage = buildCardImage;
router.renderShareHtml = renderShareHtml;
router.isAmapNav = isAmapNav;
router.PLACE_ID = PLACE_ID;

module.exports = router;
