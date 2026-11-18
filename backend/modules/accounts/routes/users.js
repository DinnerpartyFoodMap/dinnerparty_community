const path = require("path");
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const sharp = require("sharp");
const { db } = require("../../../infrastructure/database");
const { requireAuth, attachViewer, sessionStore } = require("../middleware/auth");
const { newSessionId } = require('../services/sessions');
const verification = require('../services/qqVerification');
const phoneVerification = require('../services/phoneVerification');
const { getSmsClient } = require('../../../infrastructure/aliyunSms');
const { getQQBot } = require('../../qqbot/runtime/index');
const botConfig = require('../../qqbot/runtime/config');
const { sendPrivateText } = require('../../qqbot/runtime/directMessage');
const { normalizeQQ } = require('../../qqbot/runtime/qqIdentity');
const { normalizeLocation, saveUserLocation, setUserLocationCity } = require('../services/userLocation');
const { reverseGeocodeCity } = require('../../maps/services/amapRegeo');
const { getUserProfile, saveProfileWidgets, rejectedPlaceCount } = require('../services/userProfile');
const { avatarColumns, withAvatarFields, cleanupAvatarImage } = require('../services/userAvatar');
const { requireWritableUser } = require('../services/userAccess');
const { saveAvatarImage } = require('../../media/services/imageStorage');
const { getFavoriteCollection } = require('../../preferences/services/favoriteCollection');
const { setSelfLevel, userTasteAxes } = require('../../preferences/services/tasteAxes');
const { viewerRelation, setBlocked } = require('../services/userRelations');
const { CREATOR_PLACES_LIMIT, listCreatorPlaces } = require('../../places/services/creatorPlaces');
const logger = require('../../../infrastructure/logger');
const { rateLimit } = require('../../../http/middleware/rateLimit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const JWT_SECRET = process.env.JWT_SECRET || "yuyuko_secret_key";
const JWT_EXPIRES_IN = 60 * 60 * 24 * 7; // 7天（秒）
const USER_FIELDS = `id, username, admin_level, ${avatarColumns()}`;

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

// 注册是否必须验证手机号。旧版客户端的注册表单没有手机号：开关关闭（默认）时，请求里
// 既没有 phone 也没有 phoneCode 的注册仍只凭 QQ 验证码通过（手机号留空，之后可在住民设置绑定）；
// 带了手机号就必须通过短信验证。旧版本淘汰后设 REGISTRATION_PHONE_REQUIRED=true。
function registrationPhoneRequired() {
    return /^(1|true|yes|on)$/i.test(String(process.env.REGISTRATION_PHONE_REQUIRED || '').trim());
}

function clientSummary(body) {
    const client = body && typeof body.client === 'object' && body.client ? body.client : {};
    const text = (value) => (typeof value === 'string' ? value.slice(0, 32) : undefined);
    return { platform: text(client.platform), appVersion: text(client.app_version) };
}
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

// One account per phone. `exceptUserId` lets a resident re-check their own number.
// Only checked after the SMS code for that number was verified: checking before sending
// would let anyone probe which numbers are registered without receiving the SMS.
function assertPhoneAvailable(phone, exceptUserId = null) {
    const owner = phoneVerification.findUserByPhone(phone);
    if (owner && String(owner.id) !== String(exceptUserId)) {
        throw registrationFailure(409, 'phone_already_bound', '该手机号已绑定其他住民');
    }
}

const registerUserTransaction = db._raw.transaction(({ username, passwordHash, qq, verificationCode, phone, phoneCode, userId }) => {
    if (db._raw.prepare('SELECT id FROM User WHERE username = ?').get(username)) {
        throw registrationFailure(400, 'username_exists', '住民名已被使用');
    }
    assertQQCanRegister(qq);
    // phone is null only for an old client's form without a phone number (see registrationPhoneRequired).

    // A wrong code is returned rather than thrown so its attempt count commits.
    // Both codes are checked before either is consumed: a wrong SMS code keeps the QQ code usable.
    const check = verification.checkCode({ purpose: verification.PURPOSES.register, qq, code: verificationCode });
    if (!check.ok) return { failure: check };
    let phoneCheck = null;
    if (phone) {
        phoneCheck = phoneVerification.checkCode({ purpose: phoneVerification.PURPOSES.register, phone, code: phoneCode, subject: qq });
        if (!phoneCheck.ok) return { failure: { ...phoneCheck, field: 'phoneCode' } };
        assertPhoneAvailable(phone);
    }
    verification.consumeCode(check.id);
    if (phoneCheck) phoneVerification.consumeCode(phoneCheck.id);

    db._raw.prepare(
        'INSERT INTO User (id, username, password, qq, phone) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, username, passwordHash, qq, phone);
    return {
        user: db._raw.prepare(
            `SELECT ${USER_FIELDS} FROM User WHERE id = ?`
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
            `SELECT ${USER_FIELDS} FROM User WHERE id = ?`
        ).get(account.id)
    };
});

// 注册发短信前核对 QQ 验证码（不消耗）。返回失败对象而不是抛出，错误次数才会提交。
const checkRegistrationQQCodeTransaction = db._raw.transaction(({ qq, qqCode }) => {
    assertQQCanRegister(qq);
    const check = verification.checkCode({ purpose: verification.PURPOSES.register, qq, code: qqCode });
    return check.ok ? null : check;
});

function checkRegistrationQQCode(qq, qqCode) {
    return checkRegistrationQQCodeTransaction.immediate({ qq, qqCode });
}

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

const INVALID_PHONE_MESSAGE = '请输入正确的手机号（中国大陆为 11 位手机号，境外号码请选择对应的国家或地区区号）';

const SMS_FAILURES = {
    not_configured: [503, '短信服务暂未开通，请稍后再试'],
    intl_not_configured: [400, '暂不支持向境外手机号发送验证码，请使用中国大陆手机号'],
    invalid_phone: [400, '这个手机号收不到短信，请检查号码'],
    rate_limited: [429, '这个手机号今天收到的验证码太多了，请稍后再试'],
    blocked: [400, '这个手机号拒收了短信，请换一个号码'],
    failed: [502, '短信发送失败，请稍后重试']
};

// 预留验证码 → 阿里云短信下发 → 标记已发送。subject 是要验证码的人（注册时为 QQ，换绑时为住民 UUID）。
async function deliverPhoneCode(req, res, { purpose, phone, subject }) {
    const client = getSmsClient();
    if (!client.supports(phone)) {
        const reason = phoneVerification.isMainland(phone) ? 'not_configured' : 'intl_not_configured';
        logger.warn('SMS code not sent: SMS channel not configured', { event: `auth.sms.${reason}`, purpose, phone: phoneVerification.maskPhone(phone) });
        const [status, message] = SMS_FAILURES[reason];
        return res.status(status).json({ error: message });
    }
    let reservation;
    try {
        reservation = phoneVerification.reserveCode({ purpose, phone, subject, ip: req.ip });
    } catch (error) {
        if (error instanceof phoneVerification.VerificationError) {
            logAuthRejected(req, `sms.${purpose}`, error.reason);
            return sendVerificationError(res, error);
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '短信验证码发送失败，请稍后重试' });
    }
    const success = () => res.json({
        success: true,
        phone: phoneVerification.maskPhone(phone),
        expires_in: Math.round(phoneVerification.CODE_TTL_MS / 1000),
        resend_after: Math.round(phoneVerification.RESEND_COOLDOWN_MS / 1000)
    });
    try {
        const delivery = await client.sendVerifyCode({ phone, code: reservation.code, purpose, outId: `sms-${reservation.id}` });
        phoneVerification.markSent(reservation.id);
        logger.info('SMS code sent', {
            event: 'auth.sms.sent', purpose, phone: phoneVerification.maskPhone(phone), channel: delivery.channel,
            bizId: delivery.bizId, providerRequestId: delivery.requestId
        });
        return success();
    } catch (error) {
        const fields = {
            event: 'auth.sms.delivery_failed', purpose, phone: phoneVerification.maskPhone(phone),
            reason: error.code || 'failed', providerCode: error.providerCode, providerMessage: error.providerMessage,
            providerRequestId: error.requestId, outcomeUnknown: !!error.outcomeUnknown
        };
        if (error.outcomeUnknown) {
            // 超时或连接中断时短信可能已经发出：保留这条验证码，住民收不到可以 60 秒后重发
            phoneVerification.markSent(reservation.id);
            logger.warn('SMS code delivery outcome unknown', { ...fields, error });
            return success();
        }
        phoneVerification.markFailed(reservation.id);
        const [status, message] = SMS_FAILURES[error.code] || SMS_FAILURES.failed;
        if (status >= 500) logger.error('SMS code delivery failed', { ...fields, error });
        else logger.warn('SMS code delivery failed', fields);
        return res.status(status).json({ error: message });
    }
}

// 注册用的短信验证码。先要有有效的 QQ 验证码（只核对、不消耗，错误照常计次），
// 证明是饭联群成员在注册，陌生人不能用这个接口刷短信。
router.post('/phone-code', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const qq = normalizeQQ(body.qq);
    const phone = phoneVerification.normalizePhone(body.phone, body.countryCode);
    const qqCode = typeof body.verificationCode === 'string' ? body.verificationCode.trim() : '';
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE });
    if (!qq) return res.status(400).json({ error: '请先填写QQ号' });
    if (!VERIFICATION_CODE_PATTERN.test(qqCode)) return res.status(400).json({ error: '请先获取并填写QQ验证码，再获取短信验证码' });
    try {
        const failure = checkRegistrationQQCode(qq, qqCode);
        if (failure) {
            logAuthRejected(req, 'sms.register', failure.reason);
            return res.status(400).json({ error: `QQ${failure.message}` });
        }
    } catch (error) {
        if (!error || !error.reason) {
            res.locals.unhandledError = error;
            return res.status(500).json({ error: '短信验证码发送失败，请稍后重试' });
        }
        logAuthRejected(req, 'sms.register', error.reason);
        return res.status(error.status || 400).json({ error: error.publicMessage });
    }
    return deliverPhoneCode(req, res, { purpose: phoneVerification.PURPOSES.register, phone, subject: qq });
});

router.post("/register", async (req, res) => {
    const { username, password, qq, verificationCode, phone: rawPhone, phoneCode } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string'
        || typeof verificationCode !== 'string' || !qq) {
        logAuthRejected(req, 'register', 'missing_fields', username);
        return res.status(400).json({ error: "缺少字段" });
    }
    // 旧版客户端的表单没有手机号字段：开关关闭时照旧注册，打开后提示更新而不是只说“缺少字段”
    const withoutPhone = !rawPhone && !(typeof phoneCode === 'string' && phoneCode.trim());
    if (withoutPhone && registrationPhoneRequired()) {
        logAuthRejected(req, 'register', 'phone_required', username);
        return res.status(400).json({ error: '注册需要验证手机号：请填写手机号和短信验证码（App 请先更新到最新版本）' });
    }
    const normalizedPhone = withoutPhone ? null : phoneVerification.normalizePhone(rawPhone, req.body.countryCode);
    const normalizedPhoneCode = typeof phoneCode === 'string' ? phoneCode.trim() : '';
    const normalizedUsername = username.trim();
    const normalizedQq = normalizeQQ(qq);
    const normalizedCode = verificationCode.trim();
    if (!normalizedUsername || !password || !normalizedCode) {
        logAuthRejected(req, 'register', 'missing_fields', username);
        return res.status(400).json({ error: '缺少字段' });
    }
    if (!normalizedQq) return res.status(400).json({ error: '请输入正确的QQ号' });
    if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) return res.status(400).json({ error: '验证码是 6 位数字' });
    if (!withoutPhone) {
        if (!normalizedPhone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE });
        if (!VERIFICATION_CODE_PATTERN.test(normalizedPhoneCode)) return res.status(400).json({ error: '短信验证码是 6 位数字' });
    }

    const userId = crypto.randomUUID();
    let row;
    try {
        const result = registerUserTransaction.immediate({
            username: normalizedUsername,
            passwordHash: hashPassword(password),
            qq: normalizedQq,
            verificationCode: normalizedCode,
            phone: normalizedPhone,
            phoneCode: normalizedPhoneCode,
            userId
        });
        if (result.failure) {
            logAuthRejected(req, 'register', result.failure.reason, normalizedUsername);
            const field = result.failure.field || 'code';
            return res.status(400).json({ error: `${field === 'phoneCode' ? '短信' : 'QQ'}${result.failure.message}`, field });
        }
        row = withAvatarFields(result.user);
    } catch (error) {
        if (error && error.reason) {
            logAuthRejected(req, 'register', error.reason, normalizedUsername);
            return res.status(error.status || 400).json({ error: error.publicMessage });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '注册失败，请稍后重试' });
    }

    row.phone_masked = phoneVerification.maskPhone(normalizedPhone);
    logger.addContext({ userId });
    const { token, sessionStored } = await issueSessionToken({ id: userId, username: normalizedUsername }, req, 'register');
    logger.info('Registration succeeded', {
        event: 'auth.register.succeeded',
        username: row.username,
        phone: phoneVerification.maskPhone(normalizedPhone),
        sessionStored
    });
    if (withoutPhone) {
        // 旧版客户端没有手机号：单独记一条，便于判断何时可以打开 REGISTRATION_PHONE_REQUIRED
        logger.warn('Registration without phone (old client)', {
            event: 'auth.register.without_phone',
            username: row.username,
            client: clientSummary(req.body)
        });
    }
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
    db.get(`SELECT ${USER_FIELDS} FROM User WHERE username = ? AND password = ?`, [username, hashed], async (err, row) => {
        if (err) {
            res.locals.unhandledError = err;
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            logAuthRejected(req, 'login', 'invalid_credentials', username);
            return res.status(401).json({ error: "住民名或通行密码错误" });
        }

        row = withAvatarFields(row);
        row.phone_masked = phoneVerification.maskPhone(phoneVerification.userPhone(row.id));
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
        user = withAvatarFields(result.user);
    } catch (error) {
        if (error && error.reason) {
            logAuthRejected(req, 'password_reset', error.reason);
            return res.status(error.status || 400).json({ error: error.publicMessage });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '重设通行密码失败，请稍后重试' });
    }

    user.phone_masked = phoneVerification.maskPhone(phoneVerification.userPhone(user.id));
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
// rejected_place_count：自己被驳回的地点数（头像与“我创建的地点”上的小红点）
// phone_masked：绑定的手机号（中间四位打码），没绑定为 null；完整号码不下发
router.get('/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    let rejected = 0;
    let phoneMasked = null;
    try { rejected = rejectedPlaceCount(req.user.id); } catch (error) { res.locals.unhandledError = error; }
    try { phoneMasked = phoneVerification.maskPhone(phoneVerification.userPhone(req.user.id)); } catch (error) { res.locals.unhandledError = error; }
    res.json({ user: { ...req.user, rejected_place_count: rejected, phone_masked: phoneMasked } });
});

// 换绑 / 绑定手机号：只验证新号码（不验证旧号码），一个手机号只能绑定一位住民。
// 先发短信验证码，再凭验证码提交；验证码只对要它的这位住民有效。
// 号码是否已被别人绑定只在验证码通过后才告诉住民（见 assertPhoneAvailable）。
function assertPhoneChanged(userId, phone) {
    if (phoneVerification.userPhone(userId) === phone) {
        throw registrationFailure(400, 'phone_unchanged', '这已经是你绑定的手机号');
    }
}

router.post('/me/phone/code', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const phone = phoneVerification.normalizePhone(req.body && req.body.phone, req.body && req.body.countryCode);
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE });
    try {
        assertPhoneChanged(req.user.id, phone);
    } catch (error) {
        if (!error || !error.reason) {
            res.locals.unhandledError = error;
            return res.status(500).json({ error: '短信验证码发送失败，请稍后重试' });
        }
        logAuthRejected(req, 'sms.change_phone', error.reason);
        return res.status(error.status || 400).json({ error: error.publicMessage });
    }
    return deliverPhoneCode(req, res, { purpose: phoneVerification.PURPOSES.changePhone, phone, subject: req.user.id });
});

const changePhoneTransaction = db._raw.transaction(({ userId, phone, code }) => {
    assertPhoneChanged(userId, phone);
    const check = phoneVerification.checkCode({ purpose: phoneVerification.PURPOSES.changePhone, phone, code, subject: userId });
    if (!check.ok) return { failure: check };
    assertPhoneAvailable(phone, userId);
    phoneVerification.consumeCode(check.id);
    const previous = phoneVerification.userPhone(userId);
    db._raw.prepare('UPDATE User SET phone = ? WHERE id = ?').run(phone, userId);
    return { previous };
});

router.put('/me/phone', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const phone = phoneVerification.normalizePhone(req.body && req.body.phone, req.body && req.body.countryCode);
    const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
    if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE });
    if (!VERIFICATION_CODE_PATTERN.test(code)) return res.status(400).json({ error: '短信验证码是 6 位数字' });
    try {
        const result = changePhoneTransaction.immediate({ userId: req.user.id, phone, code });
        if (result.failure) {
            logAuthRejected(req, 'phone_change', result.failure.reason);
            return res.status(400).json({ error: result.failure.message });
        }
        logger.info('Phone number changed', {
            event: 'auth.phone.changed',
            userId: req.user.id,
            previousPhone: phoneVerification.maskPhone(result.previous),
            phone: phoneVerification.maskPhone(phone)
        });
        return res.json({ success: true, phone_masked: phoneVerification.maskPhone(phone) });
    } catch (error) {
        if (error && error.reason) {
            logAuthRejected(req, 'phone_change', error.reason);
            return res.status(error.status || 400).json({ error: error.publicMessage });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '换绑手机号失败，请稍后重试' });
    }
});

// 住民主页地点小组件设置，见 services/userProfile.js。
router.put('/me/profile', requireAuth, (req, res) => {
    const settings = saveProfileWidgets(req.user.id, req.body?.widgets, req.body?.hidden_widgets);
    if (!settings) return res.status(400).json({ error: '小组件设置无效' });
    res.json(settings);
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
                db.get(`SELECT ${USER_FIELDS} FROM User WHERE id = ?`, [req.user.id], (err2, updated) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    return res.json({ user: withAvatarFields(updated), token });
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
                db.get(`SELECT ${USER_FIELDS} FROM User WHERE id = ?`, [req.user.id], (err2, updated) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    return res.json({ user: withAvatarFields(updated), token, other_sessions_revoked: revoked !== null });
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

        db.get(`SELECT ${USER_FIELDS}, map_settings FROM User WHERE id = ?`, [req.user.id], (err2, updated) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (updated && updated.map_settings) {
                try { updated.map_settings = JSON.parse(updated.map_settings); } catch (ex) { /* ignore */ }
            }
            return res.json({ user: withAvatarFields(updated) });
        });
    });
});

// 记录地图“定位”得到的位置（GCJ-02），只保留最近一次，供 QQ Bot 的 !随机 作为推荐中心
router.put('/me/location', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { lat, lng } = req.body || {};
    if (!normalizeLocation(lat, lng)) return res.status(400).json({ error: '定位坐标无效' });
    try {
        const saved = saveUserLocation(req.user.id, { lat, lng, source: 'web' });
        res.json({ success: true });
        // 住民主页的“上次定位在”：后台逆地理编码到城市，失败时留空
        if (saved) {
            reverseGeocodeCity(saved.lat, saved.lng)
                .then((city) => setUserLocationCity(req.user.id, saved.updatedAt, city))
                .catch(() => { });
        }
        return undefined;
    } catch (e) {
        res.locals.unhandledError = e;
        return res.status(500).json({ error: '记录定位失败' });
    }
});

const replaceAvatar = db._raw.transaction((userId, avatarUrl) => {
    const current = requireWritableUser(userId);
    db._raw.prepare('UPDATE User SET avatar_url = ?, avatar_blob = NULL WHERE id = ?').run(avatarUrl, userId);
    return current.avatar_url;
});

// 上传当前用户头像，先写 OSS 再更新数据库中的地址。
router.put('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.file) return res.status(400).json({ error: '未上传文件' });

    let buffer;
    try {
        buffer = await sharp(req.file.buffer)
            .resize(200, 200, { fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();
    } catch (error) {
        return res.status(500).json({ error: '图片处理失败', detail: error.message });
    }

    let avatarUrl;
    try {
        avatarUrl = await saveAvatarImage(buffer);
    } catch (error) {
        res.locals.unhandledError = error;
        if (error.code === 'AVATAR_STORAGE_UNAVAILABLE') {
            return res.status(503).json({ error: '头像上传需要配置 OSS 存储，请联系管理员' });
        }
        return res.status(500).json({ error: '头像上传失败，请稍后重试' });
    }

    let previousUrl;
    try {
        previousUrl = replaceAvatar.immediate(req.user.id, avatarUrl);
    } catch (error) {
        await cleanupAvatarImage(avatarUrl, req.user.id);
        res.locals.unhandledError = error;
        return res.status(error.status || 500).json({ error: error.publicMessage || '头像更新失败，请稍后重试' });
    }
    await cleanupAvatarImage(previousUrl, req.user.id);
    try {
        // 等旧对象清理期间，另一台设备可能已经换了头像。回传当前仍有效的地址。
        const user = db._raw.prepare(`SELECT ${USER_FIELDS} FROM User WHERE id = ?`).get(req.user.id);
        if (!user) return res.status(404).json({ error: '住民不存在' });
        return res.json({ success: true, user: withAvatarFields(user) });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '头像资料读取失败，请稍后重试' });
    }
});

// 已有 SQLite 头像使用独立路径，绕开客户端对旧 URL 的缓存；迁移后两条路径都跳转到 OSS。
// 没有头像时默认 404；?fallback=default 时返回默认头像（与网页 src/img/default.png 相同，iOS 原生列表只能加载 https 图片）
const DEFAULT_AVATAR_FILE = path.join(__dirname, '..', 'assets', 'default-avatar.png');
router.get(['/:id/avatar', '/:id/avatar/legacy'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    db.get('SELECT avatar_url, avatar_blob FROM User WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row?.avatar_url) return res.redirect(302, row.avatar_url);
        if (!row?.avatar_blob) {
            if (req.query.fallback === 'default') {
                return res.sendFile(DEFAULT_AVATAR_FILE, { cacheControl: false });
            }
            return res.status(404).json({ error: '未找到头像' });
        }
        return res.type('webp').send(row.avatar_blob);
    });
});

// 自己填某一类餐饮的喜好（1–4，null 回到自动推断），返回新的六轴
router.put('/me/taste', requireAuth, async (req, res, next) => {
    const { axis, level } = req.body || {};
    if (!setSelfLevel(req.user.id, axis, level === null ? null : level)) return res.status(400).json({ error: '喜好设置无效' });
    try{res.json({ taste: await userTasteAxes(req.user.id) });}catch(e){next(e);}
});

// 住民主页：头像、六类餐饮偏好、上次定位的城市与两个小组件；relation 决定是否显示屏蔽 / 解除屏蔽
router.get('/:id/profile', attachViewer, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const profile = await getUserProfile(req.params.id, req.viewer || null);
        if (!profile) return res.status(404).json({ error: '住民不存在' });
        res.json(profile);
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '住民主页加载失败，请稍后重试' });
    }
});

router.get('/:id/favorites', attachViewer, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const collection = getFavoriteCollection(req.params.id, req.viewer?.id);
    if (!collection) return res.status(404).json({ error: '收藏不可见' });
    res.json(collection);
});

// 某位住民创建的地点（地点卡片点“最近修改”的名字后筛选地图）：最近创建的在前，最多 limit 个，total 是全部可见数量。
// relation 是观看者与这位住民的关系（self / blocked / can_block，见 services/userRelations.js）；
// 屏蔽了 Ta 时列表仍可打开（用来解除屏蔽），但不列出地点
router.get('/:id/places', attachViewer, rateLimit('people', { member: (req) => String(req.params.id || '').slice(0, 64) || null }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        let user = db._raw.prepare('SELECT id, username FROM User WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: '住民不存在' });
        let relation = viewerRelation(req.viewer, user.id);
        let { places, total } = relation.blocked ? { places: [], total: 0 } : await listCreatorPlaces(user.id, req.viewer?.id ?? null);
        user=db._raw.prepare('SELECT id, username FROM User WHERE id=?').get(req.params.id);
        if(!user)return res.status(404).json({error:'住民不存在'});
        relation=viewerRelation(req.viewer,user.id);
        if(relation.blocked){places=[];total=0;}
        res.json({ user, relation, places, total, limit: CREATOR_PLACES_LIMIT });
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '住民的地点加载失败，请稍后重试' });
    }
});

// 屏蔽 / 解除屏蔽某位住民（住民地点列表里的“屏蔽并举报”“解除屏蔽”），返回新的 relation。
// 只影响自己看到的内容；举报由前端另外打开预填的反馈表，住民写下原因后提交
const setBlockedRoute = (blocked) => (req, res) => {
    try {
        const user = db._raw.prepare('SELECT id FROM User WHERE id = ?').get(req.params.id);
        if (!user) return res.status(404).json({ error: '住民不存在' });
        if (String(user.id) === String(req.user.id)) return res.status(400).json({ error: '不能屏蔽自己' });
        setBlocked(req.user.id, user.id, blocked);
        logger.info(blocked ? 'User blocked' : 'User unblocked', {
            event: blocked ? 'accounts.user.blocked' : 'accounts.user.unblocked', userId: req.user.id, targetId: user.id
        });
        res.json({ relation: viewerRelation(req.user, user.id) });
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '操作失败，请稍后重试' });
    }
};
router.post('/:id/block', requireAuth, setBlockedRoute(true));
router.delete('/:id/block', requireAuth, setBlockedRoute(false));

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

        const deleted = db._raw.prepare('DELETE FROM User WHERE id = ? RETURNING avatar_url').get(userId);
        await cleanupAvatarImage(deleted?.avatar_url, userId);
        logger.warn('User account deleted', {
            event: 'auth.account.deleted',
            userId
        });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: '住民档案删除失败', detail: e.message });
    }
});

module.exports = router;
