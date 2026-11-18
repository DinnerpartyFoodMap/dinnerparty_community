// 公共可缓存接口：内容与观看者无关的 GET 响应，交给 CDN（阿里云 ESA）和浏览器缓存，
// 公告、展会每个打开的页面每 30 秒轮询一次，地图标记快照每次打开地图都要读，不缓存时全部回源。
//
// 这些路径必须挂在 cors() 之前并跳过它：cors 按请求的 Origin 回 Access-Control-Allow-Origin 并加 Vary: Origin，
// 边缘缓存了网页（https://www.dinnerparty.cc）的那份再发给 App（https://localhost、capacitor://localhost），
// App 会因为 Origin 对不上而拿不到数据。这里固定回 *，前端请求这些路径时不带 Authorization 和自定义请求头，
// 浏览器不发预检，也不带凭据，* 就够用。
//
// Cache-Control 只在 200 / 304 时写成公共缓存，出错的响应一律 no-store，避免 CDN 把 500 缓存下来。
// 路由里不要再设 Cache-Control。CDN 规则见 backend/doc/CDN_CACHE.md。

const POLICIES = Object.freeze({
    // 公告、展会：管理员改了以后最多约 1 分钟大家都看到
    short: 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
    // 高德 JS API key：浏览器每次用 ETag 校验，换 key 后 CDN 最多 5 分钟跟上
    amapKey: 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
    // 地区树：随地点慢慢变化
    regions: 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    // 地图标记快照（GET /places/markers）：后端自己还有 15 秒的内存缓存
    markers: 'public, max-age=30, s-maxage=60, stale-while-revalidate=600',
    // 地图瓦片清单（GET /places/tiles/manifest）：每块瓦片的内容哈希，改了地点最多约一分钟跟上
    tileManifest: 'public, max-age=30, s-maxage=60, stale-while-revalidate=600',
    // 聚合瓦片与字典：URL 里带内容哈希，内容一变 URL 就变，永不过期
    immutable: 'public, max-age=31536000, s-maxage=31536000, immutable'
});

// 带变量的公共路径：聚合瓦片（z 为 2 / 5 / 8）和字典。z 为 12 的明细瓦片不在这里：它要按 IP / 账号限流，不能进 CDN
const PUBLIC_PATTERNS = Object.freeze([
    [/^\/places\/tiles\/manifest$/, POLICIES.tileManifest],
    [/^\/places\/tiles\/[0-9a-f]{12}\/(?:dict|(?:2|5|8)\/\d+\/\d+)$/, POLICIES.immutable]
]);

const PUBLIC_ROUTES = new Map([
    ['/notices/current', POLICIES.short],
    ['/api/notices/current', POLICIES.short],
    ['/exhibitions', POLICIES.short],
    ['/api/exhibitions', POLICIES.short],
    ['/exhibitions/current', POLICIES.short],
    ['/api/exhibitions/current', POLICIES.short],
    ['/api/amap/js-config', POLICIES.amapKey],
    ['/places/regions', POLICIES.regions],
    ['/places/markers', POLICIES.markers]
]);

function publicPolicy(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    const exact = PUBLIC_ROUTES.get(path);
    if (exact) return exact;
    for (const [pattern, policy] of PUBLIC_PATTERNS) if (pattern.test(path)) return policy;
    return null;
}

/**
 * 公共路径：设好 CORS 与缓存头，并标记 res.locals.publicCache，index.js 据此跳过 cors()。
 * Cache-Control 在写响应头的那一刻按状态码决定（路由里设的值会被覆盖）。
 */
function publicCache() {
    return function publicCacheMiddleware(req, res, next) {
        const policy = publicPolicy(req);
        if (!policy) return next();
        res.locals.publicCache = true;
        res.setHeader('Access-Control-Allow-Origin', '*');
        const writeHead = res.writeHead;
        res.writeHead = function writeHeadWithCachePolicy(statusCode, ...rest) {
            const status = typeof statusCode === 'number' ? statusCode : res.statusCode;
            if (!res.headersSent) res.setHeader('Cache-Control', status === 200 || status === 304 ? policy : 'no-store');
            return writeHead.call(this, statusCode, ...rest);
        };
        return next();
    };
}

/** 包一层 cors：公共路径直接放行（见文件开头） */
function skipForPublic(corsMiddleware) {
    return (req, res, next) => (res.locals.publicCache ? next() : corsMiddleware(req, res, next));
}

module.exports = { publicCache, skipForPublic, publicPolicy, POLICIES, PUBLIC_ROUTES, PUBLIC_PATTERNS };
