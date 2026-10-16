const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const sharp = require("sharp");
const { db } = require("../../../infrastructure/database");
const { requireAuth, sessionStore } = require("../middleware/auth");
const { newSessionId } = require('../services/sessions');
const verification = require('../services/qqVerification');
const { getQQBot } = require('../../qqbot/runtime/index');
const botConfig = require('../../qqbot/runtime/config');
const { sendPrivateText } = require('../../qqbot/runtime/directMessage');
const { normalizeQQ } = require('../../qqbot/runtime/qqIdentity');
const { normalizeLocation, saveUserLocation } = require('../services/userLocation');
const logger = require('../../../infrastructure/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const JWT_SECRET = process.env.JWT_SECRET || "yuyuko_secret_key";
const JWT_EXPIRES_IN = 60 * 60 * 24 * 7; // 7天（秒）

// 密码加密
function hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * 签发带会话标识（sid）的 token，并在 Redis 中登记该设备会话。
 * 必须先完成会话写入再把 token 返回客户端，否则登录后的并发请求可能在
 * 会话写入前到达并收到 401。Redis 写入失败时与迁移前一致：记录日志后
 * 仍返回 token（Redis 不可用期间按 JWT 降级校验）。
 */
async function issueSessionToken(user, req, source, { sid, client } = {}) {
    const sessionId = sid || newSessionId();
    const token = jwt.sign({ id: user.id, username: user.username, sid: sessionId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    let sessionStored = true;
    try {
        await sessionStore().createSession(user.id, {
            sid: sessionId,
            client: client || (req.body && req.body.client),
            userAgent: req.get('User-Agent')
        });
    } catch (error) {
        sessionStored = false;
        logger.error('Failed to persist Redis session', {
            event: 'auth.session.persist_failed',
            source,
            userId: user.id,
            error
        });
    }
    return { token, sessionStored, sid: sessionId };
}

/** 读取当前会话的客户端信息，用于轮换 token 时沿用。 */
async function currentClientInfo(req) {
    if (!req.sessionId) return null;
    try {
        const record = await sessionStore().getSession(req.user.id, req.sessionId);
        return record ? { platform: record.platform, app_version: record.app_version } : null;
    } catch (e) {
        return null;
    }
}

function logAuthRejected(req, action, reason, username) {
    logger.warn(`${action} rejected`, {
        event: `auth.${action}.rejected`,
        reason,
        username: typeof username === 'string' ? username.trim().slice(0, 64) : undefined,
        ip: req.ip
    });
}

function registrationFailure(status, reason, message) {
    const error = new Error(message);
    error.status = status;
    error.reason = reason;
    error.publicMessage = message;
    return error;
}

const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const MIN_RESET_PASSWORD_LENGTH = 6;

function findUsersByQQ(qq) {
    return db._raw.prepare('SELECT id, username FROM User WHERE qq = ? LIMIT 2').all(qq);
}

// Registration needs a whitelisted QQ that no resident has bound yet. Checked
// before a code is sent and again inside the registration transaction.
function assertQQCanRegister(qq) {
    if (db._raw.prepare('SELECT id FROM User WHERE qq = ?').get(qq)) {
        throw registrationFailure(400, 'qq_already_bound', '该QQ号已被其他住民绑定');
    }
    if (!db._raw.prepare('SELECT id FROM QQWhitelist WHERE qq = ?').get(qq)) {
        throw registrationFailure(400, 'qq_not_whitelisted', '该QQ号不在注册白名单中：请先加入饭联QQ群，刚入群请稍等几分钟再试');
    }
}

// Password reset goes through the QQ bound to exactly one resident.
function resolveResetAccount(qq) {
    const users = findUsersByQQ(qq);
    if (users.length === 0) throw registrationFailure(404, 'qq_not_bound', '这个QQ号没有绑定住民');
    if (users.length > 1) throw registrationFailure(409, 'qq_bound_to_many', '这个QQ号绑定了多个住民，请联系管理员找回');
    return users[0];
}

const registerUserTransaction = db._raw.transaction(({ username, passwordHash, qq, verificationCode, userId }) => {
    if (db._raw.prepare('SELECT id FROM User WHERE username = ?').get(username)) {
        throw registrationFailure(400, 'username_exists', '住民名已被使用');
    }
    assertQQCanRegister(qq);

    // A wrong code is returned rather than thrown so its attempt count commits.
    const check = verification.checkCode({ purpose: verification.PURPOSES.register, qq, code: verificationCode });
    if (!check.ok) return { failure: check };
    verification.consumeCode(check.id);

    db._raw.prepare(
        'INSERT INTO User (id, username, password, qq) VALUES (?, ?, ?, ?)'
    ).run(userId, username, passwordHash, qq);
    return {
        user: db._raw.prepare(
            'SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?'
        ).get(userId)
    };
});

const resetPasswordTransaction = db._raw.transaction(({ qq, verificationCode, passwordHash }) => {
    const account = resolveResetAccount(qq);
    const check = verification.checkCode({ purpose: verification.PURPOSES.resetPassword, qq, code: verificationCode });
    if (!check.ok) return { failure: check };
    verification.consumeCode(check.id);

    db._raw.prepare('UPDATE User SET password = ? WHERE id = ?').run(passwordHash, account.id);
    return {
        user: db._raw.prepare(
            'SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?'
        ).get(account.id)
    };
});

function sendVerificationError(res, error) {
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status || 400).json({
        error: error.publicMessage,
        ...(error.retryAfterSeconds ? { retry_after: error.retryAfterSeconds } : {})
    });
}

const DELIVERY_FAILURES = {
    offline: [503, 'QQ机器人暂时离线，无法发送验证码，请稍后再试'],
    unreachable: [400, '机器人无法私聊这个QQ号：请确认已加入饭联QQ群，或先添加机器人为好友'],
    failed: [502, '验证码发送失败：请在QQ里允许群临时会话，或先添加机器人为好友后重试']
};

// 由 QQ 机器人向填写的 QQ 号私聊发送验证码（注册 / 找回通行密码）
router.post('/verification-code', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { purpose } = req.body || {};
    const qq = normalizeQQ(req.body && req.body.qq);
    if (!verification.PURPOSE_VALUES.has(purpose)) return res.status(400).json({ error: '无效的验证码用途' });
    if (!qq) return res.status(400).json({ error: '请输入正确的QQ号' });

    let account = null;
    try {
        if (purpose === verification.PURPOSES.register) assertQQCanRegister(qq);
        else account = resolveResetAccount(qq);
    } catch (error) {
        if (!error || !error.reason) {
            res.locals.unhandledError = error;
            return res.status(500).json({ error: '验证码发送失败，请稍后重试' });
        }
        logAuthRejected(req, `verification.${purpose}`, error.reason);
        return res.status(error.status || 400).json({ error: error.publicMessage });
    }

    const bot = getQQBot();
    if (!bot || !bot.client.connected) {
        logger.warn('Verification code not sent: QQ bot offline', { event: 'auth.verification.bot_offline', purpose });
        return res.status(503).json({ error: DELIVERY_FAILURES.offline[1] });
    }

    let reservation;
    try {
        reservation = verification.reserveCode({ purpose, qq, ip: req.ip });
    } catch (error) {
        if (error instanceof verification.VerificationError) {
            logAuthRejected(req, `verification.${purpose}`, error.reason);
            return sendVerificationError(res, error);
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '验证码发送失败，请稍后重试' });
    }

    try {
        const delivery = await sendPrivateText({
            client: bot.client,
            config: botConfig.get(),
            qq,
            text: verification.verificationMessage(purpose, reservation.code, account || {})
        });
        verification.markSent(reservation.id);
        logger.info('Verification code sent', {
            event: 'auth.verification.sent',
            purpose,
            qq: verification.maskQQ(qq),
            via: delivery.via,
            outcomeUnknown: delivery.outcomeUnknown
        });
        return res.json({
            success: true,
            expires_in: Math.round(verification.CODE_TTL_MS / 1000),
            resend_after: Math.round(verification.RESEND_COOLDOWN_MS / 1000)
        });
    } catch (error) {
        verification.markFailed(reservation.id);
        const [status, message] = DELIVERY_FAILURES[error.code] || DELIVERY_FAILURES.failed;
        logger.warn('Verification code delivery failed', {
            event: 'auth.verification.delivery_failed',
            purpose,
            qq: verification.maskQQ(qq),
            reason: error.code || 'failed',
            error
        });
        return res.status(status).json({ error: message });
    }
});

router.post("/register", async (req, res) => {
    const { username, password, qq, verificationCode } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string'
        || typeof verificationCode !== 'string' || !qq) {
        logAuthRejected(req, 'register', 'missing_fields', username);
        return res.status(400).json({ error: "缺少字段" });
    }
    const normalizedUsername = username.trim();
    const normalizedQq = normalizeQQ(qq);
    const normalizedCode = verificationCode.trim();
    if (!normalizedUsername || !password || !normalizedCode) {
        logAuthRejected(req, 'register', 'missing_fields', username);
        return res.status(400).json({ error: '缺少字段' });
    }
    if (!normalizedQq) return res.status(400).json({ error: '请输入正确的QQ号' });
    if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) return res.status(400).json({ error: '验证码是 6 位数字' });

    const userId = crypto.randomUUID();
    let row;
    try {
        const result = registerUserTransaction.immediate({
            username: normalizedUsername,
            passwordHash: hashPassword(password),
            qq: normalizedQq,
            verificationCode: normalizedCode,
            userId
        });
        if (result.failure) {
            logAuthRejected(req, 'register', result.failure.reason, normalizedUsername);
            return res.status(400).json({ error: result.failure.message });
        }
        row = result.user;
    } catch (error) {
        if (error && error.reason) {
            logAuthRejected(req, 'register', error.reason, normalizedUsername);
            return res.status(error.status || 400).json({ error: error.publicMessage });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '注册失败，请稍后重试' });
    }

    row.has_avatar = !!row.has_avatar;
    logger.addContext({ userId });
    const { token, sessionStored } = await issueSessionToken({ id: userId, username: normalizedUsername }, req, 'register');
    logger.info('Registration succeeded', {
        event: 'auth.register.succeeded',
        username: row.username,
        sessionStored
    });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ user: row, token });
});

// 用户登录，返回 token

router.post("/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        logAuthRejected(req, 'login', 'missing_fields', username);
        return res.status(400).json({ error: "缺少字段" });
    }

    const hashed = hashPassword(password);
    db.get("SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE username = ? AND password = ?", [username, hashed], async (err, row) => {
        if (err) {
            res.locals.unhandledError = err;
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            logAuthRejected(req, 'login', 'invalid_credentials', username);
            return res.status(401).json({ error: "住民名或通行密码错误" });
        }

        row.has_avatar = !!row.has_avatar;
        logger.addContext({ userId: row.id });
        // 每次登录建立独立的设备会话，不会顶掉该住民在其他设备上的登录。
        const { token, sessionStored } = await issueSessionToken(row, req, 'login');

        logger.info('Login succeeded', {
            event: 'auth.login.succeeded',
            userId: row.id,
            username: row.username,
            ip: req.ip,
            sessionStored
        });
        res.set('Cache-Control', 'no-store');
        res.json({ user: row, token });
    });
});

// 找回通行密码：凭 QQ 机器人私聊的验证码重设密码，撤销全部设备会话后为当前设备登录
router.post('/password-reset', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { qq: rawQq, verificationCode, newPassword } = req.body || {};
    const qq = normalizeQQ(rawQq);
    if (typeof verificationCode !== 'string' || typeof newPassword !== 'string' || !rawQq) {
        logAuthRejected(req, 'password_reset', 'missing_fields');
        return res.status(400).json({ error: '缺少字段' });
    }
    const normalizedCode = verificationCode.trim();
    if (!qq) return res.status(400).json({ error: '请输入正确的QQ号' });
    if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) return res.status(400).json({ error: '验证码是 6 位数字' });
    if (newPassword.length < MIN_RESET_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `新通行密码长度至少 ${MIN_RESET_PASSWORD_LENGTH} 位` });
    }

    let user;
    try {
        const result = resetPasswordTransaction.immediate({
            qq,
            verificationCode: normalizedCode,
            passwordHash: hashPassword(newPassword)
        });
        if (result.failure) {
            logAuthRejected(req, 'password_reset', result.failure.reason);
            return res.status(400).json({ error: result.failure.message });
        }
        user = result.user;
    } catch (error) {
        if (error && error.reason) {
            logAuthRejected(req, 'password_reset', error.reason);
            return res.status(error.status || 400).json({ error: error.publicMessage });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '重设通行密码失败，请稍后重试' });
    }

    user.has_avatar = !!user.has_avatar;
    logger.addContext({ userId: user.id });
    // 与修改密码一致：旧密码可能已泄露，所有设备上的旧会话一并失效。
    let revoked = null;
    try {
        revoked = await sessionStore().revokeAllSessions(user.id);
    } catch (error) {
        logger.error('Failed to revoke sessions after password reset', {
            event: 'auth.session.revoke_failed',
            userId: user.id,
            error
        });
    }
    const { token, sessionStored } = await issueSessionToken(user, req, 'password_reset');
    logger.info('Password reset', {
        event: 'auth.password.reset',
        userId: user.id,
        username: user.username,
        revokedSessions: revoked,
        sessionStored
    });
    return res.json({ user, token });
});

// 获取当前用户信息（JWT + Redis session 一致性校验）
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// 更新当前用户信息（允许修改 username）
router.patch('/me', requireAuth, (req, res) => {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string') return res.status(400).json({ error: '缺少或无效的 username 字段' });
    const newName = username.trim();
    if (newName.length < 1 || newName.length > 64) return res.status(400).json({ error: '住民名长度应为 1-64 个字符' });

    // 检查是否被占用
    db.get('SELECT id FROM User WHERE username = ?', [newName], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row && row.id !== req.user.id) return res.status(400).json({ error: '住民名已被使用' });

        db.run('UPDATE User SET username = ? WHERE id = ?', [newName, req.user.id], function (e) {
            if (e) return res.status(500).json({ error: e.message });

            // 载荷中的住民名已变化，为当前设备签发新 token：沿用当前会话 sid；
            // 若仍是迁移前的旧 token，则顺带升级为独立设备会话。
            (async () => {
                const client = await currentClientInfo(req);
                const { token } = await issueSessionToken({ id: req.user.id, username: newName }, req, 'rename', { sid: req.sessionId || undefined, client });
                if (!req.sessionId) {
                    try { await sessionStore().revokeSession(req.user.id, null); } catch (e) { /* 旧键清理失败无碍 */ }
                }
                db.get('SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?', [req.user.id], (err2, updated) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    if (updated) updated.has_avatar = !!updated.has_avatar;
                    return res.json({ user: updated, token });
                });
            })().catch((error) => {
                res.locals.unhandledError = error;
                if (!res.headersSent) res.status(500).json({ error: '住民名已更新，但刷新通行凭证失败，请重新登录' });
            });
        });
    });
});

// 修改当前用户密码，需要提供当前密码和新密码
router.patch('/me/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '缺少字段' });
    if (typeof newPassword !== 'string' || newPassword.length < 6) return res.status(400).json({ error: '新通行密码长度至少 6 位' });

    // 读取当前存储的密码（已加密）
    db.get('SELECT password FROM User WHERE id = ?', [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: '住民不存在' });

        const currentHash = hashPassword(currentPassword);
        if (row.password !== currentHash) return res.status(401).json({ error: '当前通行密码错误' });

        const newHash = hashPassword(newPassword);
        db.run('UPDATE User SET password = ? WHERE id = ?', [newHash, req.user.id], function (e) {
            if (e) return res.status(500).json({ error: e.message });

            // 修改密码后撤销该住民的全部会话（其他设备需要重新登录），
            // 再为当前设备签发新的会话，保证旧 token 即使泄露也立即失效。
            (async () => {
                const client = await currentClientInfo(req);
                let revoked = null;
                try {
                    revoked = await sessionStore().revokeAllSessions(req.user.id);
                } catch (error) {
                    logger.error('Failed to revoke sessions after password change', {
                        event: 'auth.session.revoke_failed',
                        userId: req.user.id,
                        error
                    });
                }
                const { token } = await issueSessionToken(req.user, req, 'password_change', { client });
                logger.info('Password changed', { event: 'auth.password.changed', userId: req.user.id, revokedSessions: revoked });
                db.get('SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?', [req.user.id], (err2, updated) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    if (updated) updated.has_avatar = !!updated.has_avatar;
                    return res.json({ user: updated, token, other_sessions_revoked: revoked !== null });
                });
            })().catch((error) => {
                res.locals.unhandledError = error;
                if (!res.headersSent) res.status(500).json({ error: '通行密码已更新，但刷新通行凭证失败，请重新登录' });
            });
        });
    });
});

// 更新当前用户的个性化设置（例如地图设置）
router.patch('/me/settings', requireAuth, (req, res) => {
    const { map_settings } = req.body || {};
    if (typeof map_settings === 'undefined') return res.status(400).json({ error: '缺少 map_settings 字段' });

    let payload = null;
    try {
        payload = typeof map_settings === 'string' ? map_settings : JSON.stringify(map_settings);
    } catch (e) {
        return res.status(400).json({ error: 'map_settings 必须是可序列化的 JSON' });
    }

    db.run('UPDATE User SET map_settings = ? WHERE id = ?', [payload, req.user.id], function (e) {
        if (e) return res.status(500).json({ error: e.message });

        db.get('SELECT id, username, admin_level, map_settings, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?', [req.user.id], (err2, updated) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (updated) updated.has_avatar = !!updated.has_avatar;
            if (updated && updated.map_settings) {
                try { updated.map_settings = JSON.parse(updated.map_settings); } catch (ex) { /* ignore */ }
            }
            return res.json({ user: updated });
        });
    });
});

// 记录地图“定位”得到的位置（GCJ-02），只保留最近一次，供 QQ Bot 的 !随机 作为推荐中心
router.put('/me/location', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { lat, lng } = req.body || {};
    if (!normalizeLocation(lat, lng)) return res.status(400).json({ error: '定位坐标无效' });
    try {
        saveUserLocation(req.user.id, { lat, lng, source: 'web' });
        return res.json({ success: true });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: '记录定位失败' });
    }
});

// 上传当前用户头像
router.put('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });

    try {
        const buffer = await sharp(req.file.buffer)
            .resize(200, 200, { fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();

        db.run('UPDATE User SET avatar_blob = ? WHERE id = ?', [buffer, req.user.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            db.get('SELECT id, username, admin_level, (avatar_blob IS NOT NULL) AS has_avatar FROM User WHERE id = ?', [req.user.id], (err2, updated) => {
                if (err2) return res.status(500).json({ error: err2.message });
                if (updated) updated.has_avatar = !!updated.has_avatar;
                res.json({ success: true, user: updated });
            });
        });
    } catch (e) {
        return res.status(500).json({ error: '图片处理失败', detail: e.message });
    }
});

// 获取指定用户的头像
router.get('/:id/avatar', (req, res) => {
    db.get('SELECT avatar_blob FROM User WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !row.avatar_blob) {
            return res.status(404).json({ error: '未找到头像' });
        }
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400'); // 缓存一天
        res.send(row.avatar_blob);
    });
});

// 退出登录：只清理当前设备的会话，不影响其他设备
router.post('/logout', requireAuth, async (req, res) => {
    try {
        await sessionStore().revokeSession(req.user.id, req.sessionId);
        logger.info('Logout succeeded', {
            event: 'auth.logout.succeeded',
            userId: req.user.id,
            scope: 'current'
        });
        return res.json({ success: true });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: "暂离幻想乡失败", detail: e.message });
    }
});

// 退出全部设备（含当前设备）
router.post('/logout-all', requireAuth, async (req, res) => {
    try {
        const revoked = await sessionStore().revokeAllSessions(req.user.id);
        logger.info('Logout succeeded', {
            event: 'auth.logout.succeeded',
            userId: req.user.id,
            scope: 'all',
            revokedSessions: revoked
        });
        return res.json({ success: true });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: "退出全部设备失败", detail: e.message });
    }
});

// 列出当前住民的设备会话（供后续设备管理界面使用）
router.get('/me/sessions', requireAuth, async (req, res) => {
    try {
        const sessions = await sessionStore().listSessions(req.user.id);
        res.set('Cache-Control', 'no-store');
        return res.json({
            sessions: sessions.map((item) => ({
                sid: item.sid,
                platform: item.platform,
                app_version: item.app_version || null,
                created_at: item.created_at,
                current: item.sid === req.sessionId
            })),
            legacy_session: !req.sessionId
        });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(503).json({ error: '暂时无法读取设备列表' });
    }
});

// 撤销指定设备会话
router.delete('/me/sessions/:sid', requireAuth, async (req, res) => {
    const sid = String(req.params.sid || '');
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return res.status(400).json({ error: '无效的会话标识' });
    try {
        await sessionStore().revokeSession(req.user.id, sid);
        return res.json({ success: true, current: sid === req.sessionId });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: '撤销设备会话失败' });
    }
});

// 将迁移前签发的单会话 token 升级为独立设备会话。已是新 token 时原样返回。
router.post('/me/session', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.sessionId) return res.json({ token: req.token, upgraded: false });
    try {
        const { token, sessionStored } = await issueSessionToken(req.user, req, 'legacy_upgrade');
        if (!sessionStored) return res.status(503).json({ error: '暂时无法升级通行凭证，请稍后重试' });
        try { await sessionStore().revokeSession(req.user.id, null); } catch (e) { /* 旧键会随 TTL 过期 */ }
        logger.info('Legacy session upgraded', { event: 'auth.session.upgraded', userId: req.user.id });
        return res.json({ token, upgraded: true });
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: '升级通行凭证失败' });
    }
});

// 删除当前用户账号（本人操作），同时清理会话
router.delete('/me', requireAuth, async (req, res) => {
    const userId = req.user.id;
    try {
        // 清理该住民在所有设备上的会话
        try {
            await sessionStore().revokeAllSessions(userId);
        } catch (e) {
            // 忽略 redis 删除错误，但记录日志
            console.warn('Failed to delete redis session for user on account delete:', e && e.message);
        }

        // 删除用户记录
        db.run('DELETE FROM User WHERE id = ?', [userId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            logger.warn('User account deleted', {
                event: 'auth.account.deleted',
                userId
            });
            return res.json({ success: true });
        });
    } catch (e) {
        return res.status(500).json({ error: '住民档案删除失败', detail: e.message });
    }
});

module.exports = router;
