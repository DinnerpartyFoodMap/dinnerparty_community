const crypto = require('crypto');
const logger = require('../../infrastructure/logger');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SENSITIVE_QUERY_KEY = /password|passwd|pwd|token|authorization|secret|invite.?code|verification.?code|jwt|api.?key|^(q|query|keywords|(?:view)?(?:minLat|maxLat|minLng|maxLng)|lat|lng|latitude|longitude|location|center|bounds|city|address|origin|destination)$/i;
const DEFAULT_NOISY_PREFIXES = ['/_AMapService', '/uploads', '/diagnostics/client-auth'];

function parsePositiveInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

const slowRequestMs = parsePositiveInt(process.env.LOG_SLOW_REQUEST_MS, 1500, 1, 600000);
// 客户端源端口（与 IP 一起才能在 NAT 后定位到人）。经过代理时 TCP 对端是代理，
// 端口由最外层代理写进这个请求头（nginx $remote_port、Caddy {http.request.remote.port}），
// 只在对端是受信任代理时采用；直连时用套接字自己的端口。设为空字符串不读请求头。
const clientPortHeader = String(process.env.LOG_CLIENT_PORT_HEADER ?? 'X-Client-Port').trim();
const noisyPrefixes = String(process.env.LOG_NOISY_PATH_PREFIXES || DEFAULT_NOISY_PREFIXES.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

function getRequestId(req) {
    let queryRequestId = '';
    try {
        queryRequestId = new URL(req.originalUrl || req.url || '/', 'http://logger.local').searchParams.get('request_id') || '';
    } catch (error) { }
    const supplied = String(req.get('X-Request-ID') || queryRequestId).trim();
    return REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}

function parsePort(value) {
    const text = String(value || '').split(',')[0].trim();
    if (!/^\d{1,5}$/.test(text)) return undefined;
    const port = Number(text);
    return port >= 1 && port <= 65535 ? port : undefined;
}

function clientPort(req) {
    const socket = req.socket || {};
    const trust = req.app && typeof req.app.get === 'function' ? req.app.get('trust proxy fn') : null;
    const peerTrusted = typeof trust === 'function' && trust(socket.remoteAddress, 0);
    if (clientPortHeader && peerTrusted) {
        const fromHeader = parsePort(req.get(clientPortHeader));
        if (fromHeader) return fromHeader;
    }
    // 没有转发头说明对端就是客户端；有转发头而没有端口头时端口未知，不记录代理的端口
    if (!req.get('X-Forwarded-For')) return socket.remotePort || undefined;
    return undefined;
}

function sanitizeUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl || '/', 'http://logger.local');
        for (const key of parsed.searchParams.keys()) {
            if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '[REDACTED]');
        }
        return `${parsed.pathname}${parsed.search}`;
    } catch (error) {
        return String(rawUrl || '/').slice(0, 2000);
    }
}

function shortHeader(value, maxLength = 500) {
    const text = String(value || '');
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeErrorResponse(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const summary = {};
    for (const key of ['error', 'detail', 'code', 'reason']) {
        if (body[key] !== undefined) summary[key] = body[key];
    }
    return Object.keys(summary).length ? summary : undefined;
}

function requestLogger(req, res, next) {
    const requestId = getRequestId(req);
    const startedAt = process.hrtime.bigint();
    const requestPath = sanitizeUrl(req.originalUrl || req.url);
    const noisy = noisyPrefixes.some((prefix) => requestPath.startsWith(prefix));
    let connectionClosedLogged = false;

    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.locals.requestId = requestId;

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        let responseBody = body;
        if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
            responseBody = body.requestId ? body : { ...body, requestId };
            res.locals.responseError = summarizeErrorResponse(responseBody);
        }
        return originalJson(responseBody);
    };

    const port = clientPort(req);
    logger.runWithContext({ requestId, ip: req.ip, port }, () => {
        const baseFields = {
            method: req.method,
            path: requestPath,
            ip: req.ip,
            port,
            origin: shortHeader(req.get('Origin')),
            userAgent: shortHeader(req.get('User-Agent')),
            requestContentType: shortHeader(req.get('Content-Type'), 200),
            requestContentLength: req.get('Content-Length') || undefined
        };

        if (!noisy) {
            // Completion records already contain status, duration, IP and UUID.
            // Request-start entries are available at debug level only so normal
            // production logging does not emit two records per successful call.
            logger.debug('HTTP request started', {
                event: 'http.request.started',
                ...baseFields
            });
        }

        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const fields = {
                event: 'http.request.completed',
                ...baseFields,
                status: res.statusCode,
                durationMs: Number(durationMs.toFixed(1)),
                responseContentLength: res.getHeader('Content-Length'),
                userId: req.user && req.user.id,
                responseError: res.locals.responseError,
                error: res.locals.unhandledError
            };
            if (res.statusCode >= 500) logger.error('HTTP request completed with server error', fields);
            else if (res.statusCode >= 400) logger.warn('HTTP request completed with client error', fields);
            else if (durationMs >= slowRequestMs) logger.warn('Slow HTTP request completed', fields);
            else if (!noisy) logger.info('HTTP request completed', fields);
        });

        res.on('close', () => {
            if (res.writableFinished || connectionClosedLogged) return;
            connectionClosedLogged = true;
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            logger.warn('HTTP connection closed before response completed', {
                event: 'http.request.aborted',
                ...baseFields,
                durationMs: Number(durationMs.toFixed(1)),
                userId: req.user && req.user.id
            });
        });

        next();
    });
}

function notFoundHandler(req, res) {
    return res.status(404).json({ error: '接口不存在' });
}

function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    const status = Number(error.status || error.statusCode);
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    // The finish listener emits one complete error record with status, timing,
    // IP, UUID and stack. Logging here as well would duplicate the same failure.
    res.locals.unhandledError = error;
    const publicMessage = safeStatus >= 500 ? '服务器内部错误' : (error.publicMessage || error.message || '请求失败');
    return res.status(safeStatus).json({
        error: publicMessage,
        code: error.code
    });
}

module.exports = { requestLogger, notFoundHandler, errorHandler, sanitizeUrl, clientPort };
