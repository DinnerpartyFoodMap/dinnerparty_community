'use strict';

/**
 * 多设备会话存储。
 *
 * 新 token 的 JWT 载荷带有 sid（会话标识），服务端在 Redis 中按会话保存：
 *   session:<userId>:<sid>  -> 会话元数据 JSON（TTL 与 JWT 一致）
 *   sessions:<userId>       -> 该用户全部 sid 的集合（用户会话索引）
 *
 * 兼容旧 token：旧 token 没有 sid，仍按迁移前的单会话键 session:<userId>
 * 校验“当前 token 与 Redis 中保存的一致”。新登录不会覆盖这个旧键，
 * 因此网页旧会话和手机新会话可以同时存在；旧 token 到期或调用
 * upgradeLegacySession 后自然退出历史舞台。
 *
 * Redis 不可用时的行为（与迁移前保持一致）：校验降级为仅验证 JWT 签名，
 * 期间无法感知撤销；写入失败只记录日志，不阻断登录。
 */

const crypto = require('crypto');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 与 JWT 有效期一致（7 天）
const MAX_CLIENT_FIELD_LENGTH = 64;

const sessionKey = (userId, sid) => `session:${userId}:${sid}`;
const indexKey = (userId) => `sessions:${userId}`;
const legacyKey = (userId) => `session:${userId}`;

function newSessionId() {
    return crypto.randomUUID();
}

function cleanClientField(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().slice(0, MAX_CLIENT_FIELD_LENGTH);
    return trimmed || null;
}

/** 只保留可公开展示的客户端信息，不记录凭证或完整设备指纹。 */
function normalizeClientInfo(client, userAgent) {
    const source = client && typeof client === 'object' ? client : {};
    const platform = cleanClientField(source.platform);
    return {
        platform: platform && /^(web|ios|android)$/i.test(platform) ? platform.toLowerCase() : 'web',
        app_version: cleanClientField(source.app_version || source.appVersion),
        user_agent: typeof userAgent === 'string' ? userAgent.slice(0, 160) : null
    };
}

function withTimeout(promise, ms, code) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`Redis operation timed out after ${ms}ms`);
            error.code = code;
            reject(error);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createSessionStore(redis, { ttlSeconds = SESSION_TTL_SECONDS, writeTimeoutMs = 2000 } = {}) {
    const isReady = () => (typeof redis.isReady === 'function' ? redis.isReady() : true);

    async function createSession(userId, { client, userAgent, sid } = {}) {
        const id = sid || newSessionId();
        const record = {
            sid: id,
            created_at: new Date().toISOString(),
            ...normalizeClientInfo(client, userAgent)
        };
        await withTimeout(Promise.all([
            redis.set(sessionKey(userId, id), JSON.stringify(record), 'EX', ttlSeconds),
            redis.sadd(indexKey(userId), id)
        ]), writeTimeoutMs, 'REDIS_SESSION_WRITE_TIMEOUT');
        // 索引至少与最新会话活得一样久；过期的成员在列出时清理。
        await redis.expire(indexKey(userId), ttlSeconds).catch(() => { });
        return record;
    }

    /**
     * 校验 token 对应的会话。
     * @returns {Promise<{ok: boolean, degraded?: boolean, legacy?: boolean, reason?: string}>}
     */
    async function verifySession(payload, token) {
        const userId = payload && payload.id;
        if (!userId) return { ok: false, reason: 'token_missing_user_id' };
        if (!isReady()) return { ok: true, degraded: true, reason: 'redis_not_ready' };
        try {
            if (payload.sid) {
                const exists = await redis.exists(sessionKey(userId, payload.sid));
                return exists ? { ok: true } : { ok: false, reason: 'session_revoked' };
            }
            const stored = await redis.get(legacyKey(userId));
            return stored && stored === token
                ? { ok: true, legacy: true }
                : { ok: false, legacy: true, reason: 'session_mismatch' };
        } catch (error) {
            // Redis 暂时不可用时不要踢掉所有用户，容忍短暂故障。
            return { ok: true, degraded: true, reason: 'redis_lookup_failed', error };
        }
    }

    async function getSession(userId, sid) {
        if (!sid) return null;
        const raw = await redis.get(sessionKey(userId, sid));
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    async function revokeSession(userId, sid) {
        if (!sid) {
            await redis.del(legacyKey(userId));
            return;
        }
        await Promise.all([
            redis.del(sessionKey(userId, sid)),
            redis.srem(indexKey(userId), sid)
        ]);
    }

    /** 撤销用户全部会话（含旧版单会话键）；exceptSid 用于保留当前设备。 */
    async function revokeAllSessions(userId, { exceptSid = null } = {}) {
        const sids = await redis.smembers(indexKey(userId));
        const targets = sids.filter((sid) => sid !== exceptSid);
        const ops = [redis.del(legacyKey(userId))];
        for (const sid of targets) {
            ops.push(redis.del(sessionKey(userId, sid)));
            ops.push(redis.srem(indexKey(userId), sid));
        }
        await Promise.all(ops);
        return targets.length;
    }

    async function listSessions(userId) {
        const sids = await redis.smembers(indexKey(userId));
        if (!sids.length) return [];
        const values = await redis.mget(...sids.map((sid) => sessionKey(userId, sid)));
        const sessions = [];
        const stale = [];
        sids.forEach((sid, index) => {
            const raw = values[index];
            if (!raw) {
                stale.push(sid);
                return;
            }
            try {
                sessions.push(JSON.parse(raw));
            } catch (e) {
                stale.push(sid);
            }
        });
        if (stale.length) await redis.srem(indexKey(userId), ...stale).catch(() => { });
        sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return sessions;
    }

    return {
        ttlSeconds,
        isReady,
        createSession,
        verifySession,
        getSession,
        revokeSession,
        revokeAllSessions,
        listSessions,
        upgradeLegacySession: async (userId, options) => {
            const record = await createSession(userId, options);
            await redis.del(legacyKey(userId));
            return record;
        }
    };
}

let defaultStore = null;
function getDefaultSessionStore() {
    if (!defaultStore) defaultStore = createSessionStore(require('../../../infrastructure/redis'));
    return defaultStore;
}

module.exports = {
    SESSION_TTL_SECONDS,
    createSessionStore,
    getDefaultSessionStore,
    normalizeClientInfo,
    newSessionId,
    keys: { sessionKey, indexKey, legacyKey }
};
