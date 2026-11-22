'use strict';

// 服务到服务的推送入口：denpawave 把「新活动需要在地图上标一个场馆」推过来，写进 Venue 的 pending 行。
//
// 鉴权两道，都通过才处理：
//   1. Authorization: Bearer <VENUE_TOKEN>（定长摘要比较，缺配置时 503 而不是放行）
//   2. 来源 IP 白名单（VENUE_ALLOWED_IPS，逗号分隔，支持单个 IPv4）
//
// 这里不做 HMAC：请求走 HTTPS，只有一家合作方，接口最坏只能往待办里塞几行数据，
// 建点仍然需要管理员登录。true 的重放也没有副作用 —— UNIQUE(source, external_key) 保证幂等。

const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const logger = require('../../../infrastructure/logger');
const venues = require('../services/venues');

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 6;

function digest(value) {
    return createHash('sha256').update(String(value)).digest();
}

function configuredToken() {
    return String(process.env.VENUE_TOKEN || '').trim();
}

function allowedIps() {
    return String(process.env.VENUE_ALLOWED_IPS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

/**
 * Bearer 与来源白名单都必须通过。
 * 两者缺一都是「没配好」而不是「放行」：token 或白名单为空一律 503。
 */
function authorize(req) {
    const token = configuredToken();
    if (!token) return { ok: false, status: 503, error: '场馆推送接口未配置' };

    const ips = allowedIps();
    if (!ips.length) return { ok: false, status: 503, error: '场馆推送来源白名单未配置' };

    const match = /^Bearer ([^\s]+)$/i.exec(req.get('Authorization') || '');
    if (!match || !timingSafeEqual(digest(match[1]), digest(token))) {
        return { ok: false, status: 401, error: '鉴权失败' };
    }

    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!ips.includes(ip)) return { ok: false, status: 403, error: '来源不在白名单内' };
    return { ok: true };
}

// 进程内固定窗口限流，按来源 IP 计数（不用请求头，避免客户端换 key 绕过）。
// 丢一个计数不影响业务；多实例部署时各自计数，月级流量撞不到。
const buckets = new Map();
function rateLimited(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
        buckets.set(key, { startedAt: now, count: 1 });
        if (buckets.size > 5000) {
            for (const [k, v] of buckets) if (now - v.startedAt >= RATE_WINDOW_MS) buckets.delete(k);
        }
        return false;
    }
    bucket.count += 1;
    return bucket.count > RATE_LIMIT;
}

const router = express.Router();

// 只接受 POST；其余方法交给上层 404。
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.post('/', (req, res) => {
    const auth = authorize(req);
    if (!auth.ok) {
        logger.warn('Venue request push rejected', {
            event: 'venue.request.rejected',
            reason: auth.status === 401 ? 'token' : auth.status === 403 ? 'ip' : 'unconfigured',
            ip: req.ip
        });
        return res.status(auth.status).json({ error: auth.error });
    }

    if (rateLimited(req.ip || 'unknown')) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: '推送过于频繁，请稍后重试' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: '请求体格式错误' });
    }
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'denpawave';
    if (!/^[a-z0-9_-]{1,32}$/i.test(source)) return res.status(400).json({ error: 'source 格式错误' });
    if (!Array.isArray(body.events)) return res.status(400).json({ error: 'events 必须是数组' });

    // 逐条校验：单条失败不影响同批其他条，失败项在 failed 里返回。
    const accepted = [];
    const failed = [];
    for (const [index, raw] of body.events.entries()) {
        try {
            accepted.push(venues.normalizeEvent(raw));
        } catch (error) {
            failed.push({ index, key: typeof raw?.key === 'string' ? raw.key.slice(0, 64) : null, code: error.code || 'INVALID_EVENT', error: error.publicMessage || error.message });
        }
    }
    if (!accepted.length) {
        return res.status(400).json({ accepted: 0, updated: 0, ignored: 0, failed, requestId: res.locals.requestId });
    }

    let results;
    try {
        results = venues.receivePush({ source, events: accepted });
    } catch (error) {
        // 数据库写入失败：整批让对端重试（幂等，安全）。
        if (!error.status || error.status >= 500) {
            res.locals.unhandledError = error;
            return res.status(503).json({ error: '场馆请求暂时无法保存，请稍后重试', requestId: res.locals.requestId });
        }
        return res.status(error.status).json({ error: error.publicMessage || error.message, code: error.code, requestId: res.locals.requestId });
    }

    const summary = results.reduce((acc, item) => {
        acc[item.result] = (acc[item.result] || 0) + 1;
        return acc;
    }, {});
    const payload = {
        accepted: summary.accepted || 0,
        updated: summary.updated || 0,
        ignored: summary.ignored || 0,
        failed,
        requestId: res.locals.requestId
    };
    logger.info('Venue requests received', {
        event: 'venue.request.received',
        source,
        count: accepted.length,
        ...payload
    });
    return res.json(payload);
});

module.exports = router;
module.exports.authorize = authorize;
// 仅测试用：清空限流计数，避免用例之间互相污染。
module.exports.resetRateLimit = () => buckets.clear();
