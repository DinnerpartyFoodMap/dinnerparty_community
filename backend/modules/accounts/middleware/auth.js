const jwt = require("jsonwebtoken");
const { db } = require("../../../infrastructure/database");
const { getDefaultSessionStore } = require('../services/sessions');
const { refreshBanState } = require('../services/userAccess');
const logger = require('../../../infrastructure/logger');

const JWT_SECRET = process.env.JWT_SECRET || "yuyuko_secret_key";

// 可在测试中替换为内存实现。
let sessionStoreOverride = null;
const sessionStore = () => sessionStoreOverride || getDefaultSessionStore();
function setSessionStoreForTesting(store) { sessionStoreOverride = store; }

function extractBearerToken(req) {
    const auth = req.get("Authorization") || req.get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) return null;
    return auth.slice(7).trim();
}

function loadUserById(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT id, username, admin_level, is_banned, ban_reason, ban_expires, map_settings, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?", [userId], (err, row) => {
            if (err) return reject(err);
            if (row && row.map_settings) {
                try {
                    row.map_settings = JSON.parse(row.map_settings);
                } catch (e) {
                    // ignore parse errors and keep raw string
                }
            }
            if (row) {
                row.has_avatar = !!row.has_avatar;
            }
            resolve(row || null);
        });
    });
}

async function requireAuth(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        logger.warn('Authentication rejected', {
            event: 'security.auth.rejected',
            reason: 'missing_token',
            method: req.method,
            path: req.path
        });
        return res.status(401).json({ error: "未提供授权 token" });
    }

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        logger.warn('Authentication rejected', {
            event: 'security.auth.rejected',
            reason: e && e.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_token',
            method: req.method,
            path: req.path
        });
        return res.status(401).json({ error: "无效或已过期的 token" });
    }

    const userId = payload && payload.id;
    if (!userId) {
        logger.warn('Authentication rejected', {
            event: 'security.auth.rejected',
            reason: 'token_missing_user_id',
            method: req.method,
            path: req.path
        });
        return res.status(401).json({ error: "无效或已过期的 token" });
    }

    try {
        const session = await sessionStore().verifySession(payload, token);
        if (session.degraded) {
            // Redis 不可用时不等待离线队列，也不踢掉所有用户：仅验证 JWT 签名，
            // 期间无法感知会话撤销（与迁移前的降级行为一致）。
            const fields = { event: 'auth.session.redis_unavailable', userId, reason: session.reason };
            if (session.error) logger.error('Redis session lookup failed; falling back to JWT-only authentication', { ...fields, event: 'auth.session.lookup_failed', error: session.error });
            else logger.warn('Redis is not ready; using JWT-only authentication', fields);
        }
        if (!session.ok) {
            logger.warn('Authentication rejected', {
                event: 'security.auth.rejected',
                reason: session.reason || 'session_mismatch',
                userId,
                method: req.method,
                path: req.path
            });
            return res.status(401).json({ error: "通行凭证已失效，请重新核验" });
        }

        const user = await loadUserById(userId);
        if (!user) {
            logger.warn('Authentication rejected', {
                event: 'security.auth.rejected',
                reason: 'user_not_found',
                userId,
                method: req.method,
                path: req.path
            });
            return res.status(404).json({ error: "住民不存在" });
        }

        // handle banned users: auto-unban if expired, otherwise restrict non-read methods
        if (refreshBanState(user)) {
            // allow read-only methods
            const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
            if (!safeMethods.has(req.method)) {
                logger.warn('Banned user write request rejected', {
                    event: 'security.auth.rejected',
                    reason: 'user_banned',
                    userId,
                    method: req.method,
                    path: req.path
                });
                return res.status(403).json({ error: "通行凭证已受限，仅允许查看内容", reason: user.ban_reason || null });
            }
            // else continue but keep user info
        }

        req.user = user;
        req.token = token;
        // sid 为空表示仍在使用迁移前签发的单会话 token。
        req.sessionId = payload.sid || null;
        logger.addContext({ userId: user.id });
        return next();
    } catch (err) {
        logger.error('Authentication middleware failed', {
            event: 'security.auth.error',
            userId,
            method: req.method,
            path: req.path,
            error: err
        });
        return res.status(500).json({ error: "鉴权失败", detail: err.message });
    }
}

/**
 * 公开接口用：带有效 token 时把住民放进 req.viewer（{ id, admin_level }），否则为 null。
 * token 缺失、无效、过期或会话已撤销都按游客处理，不返回 401——看自己未公开的地点
 * 不应让地图因为过期 token 加载失败。只用于读取，写操作仍用 requireAuth。
 */
async function attachViewer(req, res, next) {
    req.viewer = null;
    const token = extractBearerToken(req);
    if (!token) return next();
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (!payload || !payload.id) return next();
        const session = await sessionStore().verifySession(payload, token);
        if (!session.ok) return next();
        const row = db._raw.prepare('SELECT id, admin_level FROM User WHERE id = ?').get(payload.id);
        if (row) req.viewer = row;
    } catch (_) { /* 游客 */ }
    return next();
}

module.exports = { requireAuth, attachViewer, extractBearerToken, setSessionStoreForTesting, sessionStore };
