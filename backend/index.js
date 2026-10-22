const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const https = require("https");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '.env') });
const logger = require('./infrastructure/logger');
const { requestLogger, notFoundHandler, errorHandler } = require('./http/middleware/requestLogger');

// Capture legacy console.* calls from every subsequently loaded module and make
// sure process-level crashes are persisted before Node exits.
logger.installConsoleBridge();
logger.installProcessHandlers();

const { init } = require("./infrastructure/database");

const placesRouter = require("./modules/places/routes/places");
const commentsRouter = require("./modules/community/routes/comments");
const usersRouter = require("./modules/accounts/routes/users");
const searchRouter = require('./modules/discovery/routes/search');
const adminUsersRouter = require("./modules/admin/routes/adminUsers");
const adminCommentsRouter = require("./modules/admin/routes/adminComments");
const adminGeneralUsersRouter = require("./modules/admin/routes/adminGeneralUsers");
const adminAuditRouter = require('./modules/admin/routes/adminAudit');
const adminQQWhitelistRouter = require('./modules/admin/routes/adminQQWhitelist');
const adminNoticesRouter = require('./modules/admin/routes/adminNotices');
const placeRequestsRouter = require("./modules/places/routes/placeRequests");
const dinnersRouter = require("./modules/community/routes/dinners");
const favoritesRouter = require("./modules/preferences/routes/favorites");
const preferencesRouter = require('./modules/preferences/routes/preferences');
const noticesRouter = require("./modules/community/routes/notices");
const categoriesRouter = require("./modules/places/routes/categories");
const alongRouteRouter = require("./modules/discovery/routes/alongRoute");
const { requireAuth } = require("./modules/accounts/middleware/auth");
const { startVectorRetryWorker } = require('./modules/preferences/services/placeVectorService');
const { startUserVectorWorker } = require('./modules/preferences/services/userPreferenceService');

const app = express();
// When running behind an HTTPS reverse proxy (e.g. nginx), enable trust proxy
// so Express respects X-Forwarded-* headers and req.secure reflects the original protocol.
app.set('trust proxy', true);
app.disable('x-powered-by');

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 7000;

// Must run before CORS/body parsing so rejected preflights, malformed JSON and
// aborted requests all receive the same request ID and access log coverage.
app.use(requestLogger);

const STATIC_ALLOWED_ORIGINS = [
    "http://localhost:2053",
    "https://localhost:2053",
    "http://localhost:5173",
    "https://localhost:5173",
    "http://127.0.0.1:2053",
    "https://127.0.0.1:2053",
    "http://127.0.0.1:5173",
    "https://127.0.0.1:5173"
];
// Add common production origins to avoid CORS issues when frontend is served from a different host/port
STATIC_ALLOWED_ORIGINS.push(
    "https://dinnerparty.cc",
    "https://cn.dinnerparty.cc",
    "https://cn.dinnerparty.cc:8443",
    "https://dinnerparty.cc:8443"
);
// Capacitor 打包的 Android/iOS 应用默认 Origin：Android 为 https://localhost，
// iOS 为 capacitor://localhost。若改了 capacitor.config 的 hostname/scheme，
// 请通过 CORS_ALLOWED_ORIGINS 追加实际值（以真机请求头为准）。
STATIC_ALLOWED_ORIGINS.push(
    "capacitor://localhost",
    "https://localhost"
);
const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
    if (EXTRA_ALLOWED_ORIGINS.includes(origin)) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
    if (/^https?:\/\/([a-z0-9-]+\.)*dinnerparty\.cc(:\d+)?$/i.test(origin)) return true;
    return false;
}

app.use(cors({
    origin: (origin, callback) => {
        // origin 为空时（例如某些本地请求或 curl），允许通过
        if (!origin) {
            return callback(null, true);
        }
        const allowed = isAllowedOrigin(origin);
        if (allowed) {
            return callback(null, true);
        }
        logger.warn('CORS origin rejected', {
            event: 'security.cors.rejected',
            origin
        });
        const error = new Error('请求来源不被允许');
        error.status = 403;
        error.code = 'CORS_NOT_ALLOWED';
        error.publicMessage = '请求来源不被允许';
        return callback(error);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
    maxAge: 3600
}));

const AMAP_JS_CODE = String(process.env.AMAP_JS_CODE || '').trim();

function appendQueryParam(rawPath, key, value) {
    const [pathname, query = ''] = String(rawPath || '').split('?');
    const params = new URLSearchParams(query);
    if (!params.has(key)) {
        params.set(key, value);
    }
    const nextQuery = params.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

function isAmapRestApiPath(urlPath) {
    const p = String(urlPath || '');
    return p.includes('/v3/') || p.includes('/v4/') || p.includes('/v5/');
}

function rewriteAmapPath(pathValue) {
    const stripped = String(pathValue || '').replace(/^\/_AMapService/, '');
    return appendQueryParam(stripped, 'jscode', AMAP_JS_CODE);
}

// Hop-by-hop headers must not be forwarded by a proxy (RFC 9110 §7.6.1).
const HOP_BY_HOP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
const AMAP_PROXY_TIMEOUT_MS = 15000;
const amapAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function forwardableHeaders(headers) {
    const result = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) result[key] = value;
    }
    return result;
}

function handleAmapProxyError(error, req, res) {
    logger.error('AMap proxy request failed', {
        event: 'proxy.amap.failed',
        method: req && req.method,
        path: req && req.url,
        error
    });
    if (!res || res.writableEnded) return;
    if (res.headersSent) return res.destroy();
    res.status(502).json({ error: '地图服务暂时不可用' });
}

// Streams map tiles and REST calls to AMap, injecting jscode so the security
// code never reaches the browser. PlaceSearch and other REST APIs (/v3/ etc.)
// live on restapi.amap.com; tiles and the core map on api.amap.com.
function amapProxy(req, res) {
    if (!AMAP_JS_CODE) {
        return res.status(503).json({ error: '地图服务未配置（AMAP_JS_CODE）' });
    }
    const host = isAmapRestApiPath(req.url) ? 'restapi.amap.com' : 'api.amap.com';
    const headers = forwardableHeaders(req.headers);
    headers.host = host;

    const upstreamReq = https.request({
        host,
        path: rewriteAmapPath(req.url),
        method: req.method,
        headers,
        agent: amapAgent,
        timeout: AMAP_PROXY_TIMEOUT_MS
    }, (upstreamRes) => {
        res.status(upstreamRes.statusCode || 502);
        res.set(forwardableHeaders(upstreamRes.headers));
        upstreamRes.on('error', (error) => handleAmapProxyError(error, req, res));
        upstreamRes.pipe(res);
    });

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('AMap upstream timed out')));
    upstreamReq.on('error', (error) => handleAmapProxyError(error, req, res));
    // Stop the upstream transfer when the client goes away mid-response.
    res.on('close', () => {
        if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
}

app.use('/_AMapService', require('./modules/maps/services/amapSearchBudget').createLegacySearchGuard(), amapProxy);

app.use('/api/journeys', express.json({ limit: '256kb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLIENT_AUTH_STAGES = new Set([
    'submitted',
    'response_received',
    'success_payload_valid',
    'success_callback_started',
    'success_callback_returned',
    'state_commit_started',
    'state_commit_finished',
    'request_timed_out',
    'request_failed'
]);
const clientAuthDiagnosticRate = new Map();

app.post('/diagnostics/client-auth', (req, res) => {
    const now = Date.now();
    const rateKey = req.ip || 'unknown';
    const current = clientAuthDiagnosticRate.get(rateKey);
    const rate = !current || now - current.startedAt >= 60000
        ? { startedAt: now, count: 1 }
        : { ...current, count: current.count + 1 };
    clientAuthDiagnosticRate.set(rateKey, rate);
    if (rate.count > 60) return res.status(204).end();

    const stage = String((req.body && req.body.stage) || req.query.stage || '').trim();
    if (CLIENT_AUTH_STAGES.has(stage)) {
        const fields = {
            event: 'auth.client.stage',
            stage,
            detail: String((req.body && req.body.detail) || req.query.detail || '').slice(0, 160),
            userAgent: String(req.get('User-Agent') || '').slice(0, 500)
        };
        if (stage === 'request_failed' || stage === 'request_timed_out') {
            logger.warn('Client authentication failed', fields);
        } else {
            // Successful client-side milestones are useful for deep debugging,
            // but too redundant for the default production info level.
            logger.debug('Client authentication stage', fields);
        }
    }
    return res.status(204).end();
});

// Serve static files for uploaded images. Filenames are unique and never rewritten,
// so they can be cached forever. With IMAGE_STORAGE=oss, files that are no longer
// on local disk redirect to the same name on OSS (old App builds, shared links).
const imageStorage = require('./modules/media/services/imageStorage');
const imageStorageErrors = imageStorage.configErrors();
if (imageStorageErrors.length) {
    logger.error('Image storage misconfigured; uploads will fail', { errors: imageStorageErrors });
}
app.use('/uploads', express.static(imageStorage.LOCAL_UPLOAD_DIR, { maxAge: '365d', immutable: true }));
app.get('/uploads/*', (req, res, next) => {
    const target = imageStorage.legacyRedirectUrl(req.params[0]);
    if (!target) return next();
    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(302, target);
});
app.use('/upload', requireAuth, require('./modules/media/routes/upload'));

// mount admin routers under /admin
app.use("/admin/users", requireAuth, adminUsersRouter);
app.use("/admin/comments", requireAuth, adminCommentsRouter);
app.use("/admin/general-users", requireAuth, adminGeneralUsersRouter);
app.use("/admin/audit", requireAuth, adminAuditRouter);
app.use("/admin/qq-whitelist", requireAuth, adminQQWhitelistRouter);
app.use("/admin/qq-bot", requireAuth, require('./modules/admin/routes/adminQQBot'));
app.use("/admin/notices", requireAuth, adminNoticesRouter);
app.use("/api/admin/notices", requireAuth, adminNoticesRouter);
app.use(["/admin/exhibitions", "/api/admin/exhibitions"], requireAuth, require('./modules/admin/routes/adminExhibitions'));
app.use("/admin/skin-codes", requireAuth, require('./modules/admin/routes/adminSkinCodes'));
app.use("/admin/feedback", requireAuth, require('./modules/admin/routes/adminFeedback'));


init();
const stopRatingReputationWorker = require('./modules/ratings/services/ratingReputation').startRatingReputationWorker();
// 启动时即建立 Redis 连接（会话存储惰性加载 redis 客户端，这里提前初始化，避免首批请求走 JWT 降级）
require('./modules/accounts/services/sessions').getDefaultSessionStore();
startVectorRetryWorker();
const stopUserVectorWorker = startUserVectorWorker();
const stopJourneyWorker = require('./modules/journeys/services/journeyAI').startJourneyWorker();
// QQ Bot (NapCat/OneBot). Disabled unless QQ_BOT_ENABLED=true; connection problems never block the website.
const qqBot = require('./modules/qqbot/runtime/index').startQQBot();

app.use('/api', searchRouter);
app.use('/api/along-route', alongRouteRouter);
app.use('/api/amap', require('./modules/maps/routes/amap'));
app.use("/places", placesRouter);
app.use("/p", require("./modules/places/routes/placeShare"));
app.use("/comments", commentsRouter);
app.use("/users", usersRouter);
app.use("/notices", noticesRouter);
app.use("/api/notices", noticesRouter);
app.use(["/exhibitions", "/api/exhibitions"], require('./modules/community/routes/exhibitions'));
app.use("/categories", categoriesRouter);
app.use("/api/categories", categoriesRouter);
app.use("/place-requests", placeRequestsRouter);
app.use("/api/place-requests", placeRequestsRouter); // 兼容前端或旧接口可能带 /api 前缀
app.use("/dinners", dinnersRouter);
app.use("/api/dinners", dinnersRouter);
app.use("/api/favorites", favoritesRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/ratings', require('./modules/ratings/routes/placeRatings'));
app.use('/api/skins', require('./modules/skins/routes/skins'));
app.use('/api/feedback', require('./modules/feedback/routes/feedback'));
app.use('/api/journeys', require('./modules/journeys/routes/journeys'));
app.use('/internal/journey-algorithms/places', require('./modules/journeys/routes/algorithmPlaces'));
app.use('/api/public/journeys', require('./modules/journeys/routes/publicJourneys'));
app.use('/api/community', require('./modules/community/routes/community'));

app.get("/", (req, res) => res.json({ ok: true, msg: "yUYUko Food Map Backend" }));

app.use(notFoundHandler);
app.use(errorHandler);

// HTTP only (reverse proxy handles HTTPS termination)
const server = app.listen(PORT, HOST, () => {
    logger.notice('Backend server started', {
        event: 'server.started',
        host: HOST,
        port: Number(PORT),
        nodeVersion: process.version,
        logLevel: logger.config.level,
        consoleLogLevel: logger.config.consoleLevel,
        logDirectory: logger.config.directory
    });
});

server.on('error', (error) => {
    logger.fatal('Backend server error', { event: 'server.error', error });
    const forceExit = setTimeout(() => process.exit(1), 1000);
    logger.flush().finally(() => {
        clearTimeout(forceExit);
        process.exit(1);
    });
});

let shutdownStarted = false;
function gracefulShutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopRatingReputationWorker();
    stopUserVectorWorker();
    stopJourneyWorker();
    if (qqBot) qqBot.stop();
    logger.notice('Backend shutdown started', { event: 'server.shutdown', signal });
    const forceExit = setTimeout(() => process.exit(1), 5000);
    server.close(async (error) => {
        if (error) logger.error('Backend shutdown failed', { event: 'server.shutdown_failed', error });
        else logger.notice('Backend server stopped', { event: 'server.stopped', signal });
        await logger.flush();
        clearTimeout(forceExit);
        process.exit(error ? 1 : 0);
    });
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
