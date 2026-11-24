'use strict';

// 登录失败限流：只数密码错误，登录成功清掉该账号在这个 IP 段上的计数。
// 三个计数（同一时间窗）：
//   - 账号 + IP 段：挡住对一个账号的连续猜测；
//   - IP 段：挡住一个来源轮换账号名猜测；
//   - 账号（任何来源）：挡住换 IP 的分布式猜测。额度放宽，避免别人故意输错把住民锁在门外太容易。
// 与防爬限流不同，这里始终拦截（不看 ANTI_SCRAPE_MODE）。额度用 LOGIN_FAILURE_LIMITS（JSON）覆盖，
// 线上数值只放 .env。计数在 Redis（index.js 用 useRedis 交进来），不可用时退回进程内计数；出错放行。

const { ipPrefix } = require('../../../http/middleware/rateLimit');
const logger = require('../../../infrastructure/logger');

const DEFAULTS = Object.freeze({
    windowSeconds: 900,
    accountIp: 10,
    ip: 50,
    account: 100
});

function limits() {
    const raw = process.env.LOGIN_FAILURE_LIMITS;
    if (!raw) return DEFAULTS;
    try {
        const parsed = JSON.parse(raw);
        const result = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            const value = Number(parsed && parsed[key]);
            if (Number.isInteger(value) && value > 0) result[key] = value;
        }
        return result;
    } catch {
        return DEFAULTS;
    }
}

function accountKey(username) {
    return String(username || '').trim().toLowerCase().slice(0, 64);
}

function keysFor(req, username) {
    const account = accountKey(username);
    const ip = ipPrefix(req.ip || req.socket?.remoteAddress);
    const config = limits();
    return {
        config,
        counters: [
            { key: `login_fail:ai:${account}|${ip}`, limit: config.accountIp },
            { key: `login_fail:ip:${ip}`, limit: config.ip },
            { key: `login_fail:a:${account}`, limit: config.account }
        ]
    };
}

// ---- 计数存储 ----

const memory = new Map();
const MEMORY_MAX_KEYS = 50000;

function memoryLive(key, now) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        memory.delete(key);
        return null;
    }
    return entry;
}

const memoryStore = {
    async get(key, now) {
        const entry = memoryLive(key, now);
        return entry ? { count: entry.count, ttl: Math.ceil((entry.expiresAt - now) / 1000) } : { count: 0, ttl: 0 };
    },
    async incr(key, ttl, now) {
        const entry = memoryLive(key, now);
        if (entry) {
            entry.count += 1;
            return;
        }
        if (memory.size >= MEMORY_MAX_KEYS) memory.delete(memory.keys().next().value);
        memory.set(key, { count: 1, expiresAt: now + ttl * 1000 });
    },
    async del(key) {
        memory.delete(key);
    }
};

function redisStore(redis) {
    return {
        async get(key) {
            const [[e1, value], [e2, ttl]] = await redis.multi().get(key).ttl(key).exec();
            if (e1 || e2) throw e1 || e2;
            return { count: Number(value) || 0, ttl: Math.max(0, Number(ttl) || 0) };
        },
        async incr(key, ttl) {
            const value = await redis.incr(key);
            if (Number(value) === 1) await redis.expire(key, ttl);
        },
        async del(key) {
            await redis.del(key);
        }
    };
}

let redisClient = null;
function useRedis(client) {
    redisClient = client || null;
}

function store() {
    if (redisClient && typeof redisClient.isReady === 'function' && redisClient.isReady() && typeof redisClient.multi === 'function') return redisStore(redisClient);
    return memoryStore;
}

// ---- 对外 ----

/** 登录前检查：超过任一额度返回 { blocked: true, retryAfter }（秒）；出错放行 */
async function checkLogin(req, username, { now = Date.now() } = {}) {
    try {
        const { counters } = keysFor(req, username);
        const s = store();
        let retryAfter = 0;
        for (const counter of counters) {
            const { count, ttl } = await s.get(counter.key, now);
            if (count >= counter.limit) retryAfter = Math.max(retryAfter, ttl || 1);
        }
        return retryAfter > 0 ? { blocked: true, retryAfter } : { blocked: false };
    } catch (error) {
        logger.error('Login throttle check failed', { event: 'auth.login.throttle_error', error });
        return { blocked: false };
    }
}

async function recordFailure(req, username, { now = Date.now() } = {}) {
    try {
        const { counters, config } = keysFor(req, username);
        const s = store();
        for (const counter of counters) await s.incr(counter.key, config.windowSeconds, now);
    } catch (error) {
        logger.error('Login throttle record failed', { event: 'auth.login.throttle_error', error });
    }
}

/** 登录成功：清掉账号 + IP 段的计数（IP 段和账号总计数留着，免得一次成功就给猜测者重置额度） */
async function recordSuccess(req, username) {
    try {
        const { counters } = keysFor(req, username);
        await store().del(counters[0].key);
    } catch (error) {
        logger.error('Login throttle reset failed', { event: 'auth.login.throttle_error', error });
    }
}

function resetForTesting() {
    memory.clear();
    redisClient = null;
}

module.exports = { checkLogin, recordFailure, recordSuccess, useRedis, limits, DEFAULTS, resetForTesting };
