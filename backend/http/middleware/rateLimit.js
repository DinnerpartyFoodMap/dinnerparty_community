'use strict';

// 数据访问限流（防爬）：按“主体”计数，登录了按账号（u:<id>），游客按 IP 段（IPv4 /24、IPv6 /64，
// 防止同一段地址轮换）。规则分两种：
//   - distinct：一段时间内碰过多少个不同的对象（地点、瓦片、住民），反复看同一个不扣额度，遍历才会撞线；
//   - count：一段时间内的请求次数。
// 模式 ANTI_SCRAPE_MODE：off 不计数；observe（默认）只记 anti_scrape.would_limit 日志、不拦；
// enforce 超过时回 429。额度用 ANTI_SCRAPE_LIMITS（JSON，按策略和 guest / user 覆盖默认值）调整，
// 线上数值只放在 .env，不写进代码注释和公开文档。说明见 http/doc/README.md#数据访问限流。
//
// 计数放在 Redis（SET / INCR，index.js 用 useRedis 交进来），Redis 不可用时退回进程内计数（单进程部署够用）；任何计数出错都放行（fail open），
// 限流不能变成新的故障点。客户端 IP 取 req.ip，前提是 trust proxy 配对了（index.js 的 TRUST_PROXY）。

const net = require('net');
const logger = require('../../infrastructure/logger');

const DAY = 'day';

// 默认额度（线上用 ANTI_SCRAPE_LIMITS 覆盖）。per 为秒数或 'day'（北京时间自然日）
const DEFAULT_LIMITS = Object.freeze({
    // GET /places/:id、/places/:id/diaries：去重地点数
    detail: {
        guest: [{ distinct: true, limit: 100, per: DAY }, { distinct: true, limit: 40, per: 600 }],
        user: [{ distinct: true, limit: 600, per: DAY }, { distinct: true, limit: 150, per: 600 }]
    },
    // GET /p/:id 分享页：QQ / 微信的卡片抓取也走这里，放宽
    share: {
        guest: [{ distinct: true, limit: 300, per: DAY }],
        user: [{ distinct: true, limit: 600, per: DAY }]
    },
    // GET /places/tiles/.../12/x/y 明细瓦片：去重瓦片数（按瓦片坐标，不按版本）。桌面窗口放大到 z13 一屏就要约 9 块
    tiles: {
        guest: [{ distinct: true, limit: 60, per: DAY }],
        user: [{ distinct: true, limit: 200, per: DAY }]
    },
    // GET /places/list：翻页次数
    list: {
        guest: [{ limit: 30, per: 3600 }],
        user: [{ limit: 200, per: 3600 }]
    },
    // GET /api/places/search*：输入联想按键触发，要宽
    search: {
        guest: [{ limit: 60, per: 600 }],
        user: [{ limit: 200, per: 600 }]
    },
    // GET /users/:id/places：去重住民数
    people: {
        guest: [{ distinct: true, limit: 20, per: 3600 }],
        user: [{ distinct: true, limit: 100, per: 3600 }]
    },
    // GET /places/nearby、/places/markers：只给旧版 App
    legacy: {
        guest: [{ limit: 300, per: 3600 }],
        user: [{ limit: 1000, per: 3600 }]
    }
});

const MODES = new Set(['off', 'observe', 'enforce']);

function currentMode() {
    const mode = String(process.env.ANTI_SCRAPE_MODE || 'observe').trim().toLowerCase();
    return MODES.has(mode) ? mode : 'observe';
}

function validRule(rule) {
    return rule && Number.isSafeInteger(rule.limit) && rule.limit >= 0
        && (rule.per === DAY || (Number.isSafeInteger(rule.per) && rule.per >= 1 && rule.per <= 86400 * 7));
}

let overrideSource = null;
let overrides = {};
function limitOverrides() {
    const raw = process.env.ANTI_SCRAPE_LIMITS || '';
    if (raw === overrideSource) return overrides;
    overrideSource = raw;
    overrides = {};
    if (!raw.trim()) return overrides;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') overrides = parsed;
    } catch (error) {
        logger.warn('ANTI_SCRAPE_LIMITS is not valid JSON, using defaults', { event: 'anti_scrape.config_invalid' });
    }
    return overrides;
}

/** 某策略对游客 / 住民的规则（覆盖值不合法时用默认值） */
function rulesFor(policy, audience) {
    const custom = limitOverrides()?.[policy]?.[audience];
    if (Array.isArray(custom) && custom.length && custom.every(validRule)) return custom.map((rule) => ({ ...rule, distinct: !!rule.distinct }));
    return DEFAULT_LIMITS[policy]?.[audience] || [];
}

// ---- 主体 ----

function expandIpv6(address) {
    const [head, tail] = address.split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const missing = tail !== undefined ? 8 - left.length - right.length : 0;
    return [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((part) => part.padStart(4, '0').toLowerCase());
}

/** IP 段：IPv4 /24，IPv6 /64；IPv4 映射的 IPv6（::ffff:1.2.3.4）按 IPv4 处理 */
function ipPrefix(ip) {
    let address = String(ip || '').trim();
    if (!address) return 'unknown';
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) address = mapped[1];
    if (net.isIPv4(address)) return `${address.split('.').slice(0, 3).join('.')}.0/24`;
    if (net.isIPv6(address)) return `${expandIpv6(address.replace(/%.*$/, '')).slice(0, 4).join(':')}::/64`;
    return address.slice(0, 64);
}

/** 计数主体：req.rateSubject（例如瓦片票据认出的账号）> 登录的观看者 > IP 段。管理员不限 */
function subjectOf(req) {
    const viewer = req.rateSubject || req.viewer || req.user || null;
    if (viewer && viewer.id != null) {
        if (Number(viewer.admin_level) > 0) return { exempt: true };
        return { key: `u:${viewer.id}`, audience: 'user' };
    }
    return { key: `ip:${ipPrefix(req.ip || req.socket?.remoteAddress)}`, audience: 'guest' };
}

// ---- 时间窗 ----

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

function windowFor(rule, now) {
    if (rule.per === DAY) {
        const beijing = now + BEIJING_OFFSET_MS;
        const dayStart = Math.floor(beijing / 86400000) * 86400000;
        return { id: `d${new Date(dayStart).toISOString().slice(0, 10)}`, resetsAt: dayStart + 86400000 - BEIJING_OFFSET_MS, ttl: 2 * 86400 };
    }
    const size = rule.per * 1000;
    const start = Math.floor(now / size) * size;
    return { id: `w${rule.per}:${start / 1000}`, resetsAt: start + size, ttl: rule.per + 60 };
}

// ---- 计数存储 ----

const memory = new Map();
const MEMORY_MAX_KEYS = 50000;

function memoryEntry(key, ttl, now, distinct) {
    let entry = memory.get(key);
    if (entry && entry.expires <= now) entry = null;
    if (!entry) {
        if (memory.size >= MEMORY_MAX_KEYS) {
            for (const [k, v] of memory) if (v.expires <= now) memory.delete(k);
            if (memory.size >= MEMORY_MAX_KEYS) memory.delete(memory.keys().next().value);
        }
        entry = { expires: now + ttl * 1000, members: distinct ? new Set() : null, count: 0 };
        memory.set(key, entry);
    }
    return entry;
}

const memoryStore = {
    async distinct(key, member, limit, ttl, { record, now }) {
        const entry = memoryEntry(key, ttl, now, true);
        if (entry.members.has(member)) return { count: entry.members.size, over: false };
        const over = entry.members.size >= limit;
        if (!over || record) entry.members.add(member);
        return { count: entry.members.size, over };
    },
    async count(key, limit, ttl, { now }) {
        const entry = memoryEntry(key, ttl, now, false);
        entry.count += 1;
        return { count: entry.count, over: entry.count > limit };
    }
};

function redisStore(redis) {
    return {
        async distinct(key, member, limit, ttl, { record }) {
            const [[e1, isMember], [e2, size]] = await redis.multi().sismember(key, member).scard(key).exec();
            if (e1 || e2) throw e1 || e2;
            if (Number(isMember)) return { count: Number(size), over: false };
            const over = Number(size) >= limit;
            if (!over || record) await redis.multi().sadd(key, member).expire(key, ttl).exec();
            return { count: Number(size) + (!over || record ? 1 : 0), over };
        },
        async count(key, limit, ttl) {
            const value = await redis.incr(key);
            if (Number(value) === 1) await redis.expire(key, ttl);
            return { count: Number(value), over: Number(value) > limit };
        }
    };
}

let redisClient = null;
/** index.js 启动时交给限流用的 Redis 客户端；没交（测试、脚本）时只用进程内计数，不为限流单独去连 Redis */
function useRedis(client) {
    redisClient = client || null;
}

function store() {
    if (redisClient && typeof redisClient.isReady === 'function' && redisClient.isReady() && typeof redisClient.multi === 'function') return redisStore(redisClient);
    return memoryStore;
}

// ---- 日志节流：同一主体同一规则十分钟记一次 ----

const logged = new Map();
function logLimit(event, fields, now) {
    const key = `${event}|${fields.policy}|${fields.subject}|${fields.per}`;
    const last = logged.get(key);
    if (last && now - last < 10 * 60 * 1000) return;
    if (logged.size > 10000) logged.clear();
    logged.set(key, now);
    logger.warn(event === 'anti_scrape.limited' ? 'Data access limited' : 'Data access would be limited', { event, ...fields });
}

/**
 * 记一次访问。返回 { limited, retryAfter }：limited 只在 enforce 模式下为 true。
 * member 为 distinct 规则的对象（地点 id、瓦片坐标等），为空时只计 count 规则。
 */
async function consume(policy, req, member = null, { now = Date.now() } = {}) {
    const mode = currentMode();
    if (mode === 'off') return { limited: false };
    const subject = subjectOf(req);
    if (subject.exempt) return { limited: false };
    const rules = rulesFor(policy, subject.audience);
    const backend = store();
    let limited = false;
    let retryAfter = 0;
    for (const rule of rules) {
        if (rule.distinct && (member === null || member === undefined || member === '')) continue;
        const window = windowFor(rule, now);
        const key = `rl:${policy}:${subject.key}:${rule.distinct ? 'x' : 'n'}:${window.id}`;
        let result;
        try {
            result = rule.distinct
                ? await backend.distinct(key, String(member), rule.limit, window.ttl, { record: mode === 'observe', now })
                : await backend.count(key, rule.limit, window.ttl, { now });
        } catch (error) {
            logger.warn('Data access counter failed, request allowed', { event: 'anti_scrape.counter_failed', policy, error: error.message });
            continue;
        }
        if (!result.over) continue;
        const fields = { policy, subject: subject.key, audience: subject.audience, count: result.count, limit: rule.limit, per: rule.per };
        logLimit(mode === 'enforce' ? 'anti_scrape.limited' : 'anti_scrape.would_limit', fields, now);
        if (mode === 'enforce') {
            limited = true;
            retryAfter = Math.max(retryAfter, Math.ceil((window.resetsAt - now) / 1000));
        }
    }
    return { limited, retryAfter, guest: subject.audience === 'guest' };
}

function sendLimited(res, { retryAfter, guest }) {
    res.set('Retry-After', String(Math.max(1, retryAfter)));
    res.set('Cache-Control', 'no-store');
    return res.status(429).json({ error: '访问太频繁，请稍后再试', code: 'rate_limited', retry_after: Math.max(1, retryAfter), guest: !!guest });
}

/** 路由中间件：member(req) 给出 distinct 规则的对象；要放在识别观看者（attachViewer / requireAuth）之后 */
function rateLimit(policy, { member } = {}) {
    return async function rateLimitMiddleware(req, res, next) {
        let result;
        try {
            result = await consume(policy, req, member ? member(req) : null);
        } catch (error) {
            logger.warn('Data access limit check failed, request allowed', { event: 'anti_scrape.check_failed', policy, error: error.message });
            return next();
        }
        if (result.limited) return sendLimited(res, result);
        return next();
    };
}

function resetForTesting() {
    memory.clear();
    logged.clear();
    overrideSource = null;
}

module.exports = { rateLimit, consume, sendLimited, subjectOf, ipPrefix, rulesFor, currentMode, useRedis, DEFAULT_LIMITS, resetForTesting };
