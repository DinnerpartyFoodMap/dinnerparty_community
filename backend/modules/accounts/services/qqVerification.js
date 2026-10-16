const crypto = require('crypto');
const { db } = require('../../../infrastructure/database');

// Short-lived codes the QQ bot sends by private message. They prove the person
// registering (or resetting a password) owns the QQ number. Only a keyed hash is
// stored; the newest sent code per qq+purpose is the only valid one, it allows a
// few wrong guesses and is consumed inside the caller's registration/reset transaction.
const sql = db._raw;

const PURPOSES = Object.freeze({ register: 'register', resetPassword: 'reset_password' });
const PURPOSE_VALUES = new Set(Object.values(PURPOSES));

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000;
// Sends per hour. The per-QQ limit protects the recipient, the per-IP limit stops
// one visitor from spraying many numbers, and the global limit keeps the bot
// account clear of QQ's spam controls.
const LIMITS = Object.freeze({ perQQ: 5, perIp: 10, global: 60 });
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

const SECRET = process.env.JWT_SECRET || 'yuyuko_secret_key';

class VerificationError extends Error {
    constructor(status, reason, message, retryAfterSeconds) {
        super(message);
        this.name = 'VerificationError';
        this.status = status;
        this.reason = reason;
        this.publicMessage = message;
        this.retryAfterSeconds = retryAfterSeconds || null;
    }
}

function hashCode(purpose, qq, code) {
    return crypto.createHmac('sha256', SECRET).update(`${purpose}:${qq}:${code}`).digest('hex');
}

function generateCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function secondsUntil(isoTime, offsetMs, nowMs) {
    return Math.max(1, Math.ceil((Date.parse(isoTime) + offsetMs - nowMs) / 1000));
}

function maskQQ(qq) {
    const text = String(qq || '');
    return text.length > 4 ? `${text.slice(0, 2)}****${text.slice(-2)}` : '****';
}

function enforceLimits({ qq, ip, nowMs }) {
    const since = iso(nowMs - WINDOW_MS);
    // Cooldown counts every send that may have reached the user; a failed one can be retried at once.
    const last = sql.prepare(`SELECT created_at FROM QQVerificationCode
        WHERE qq = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1`).get(qq);
    if (last && Date.parse(last.created_at) + RESEND_COOLDOWN_MS > nowMs) {
        const wait = secondsUntil(last.created_at, RESEND_COOLDOWN_MS, nowMs);
        throw new VerificationError(429, 'cooldown', `验证码发送太频繁，请 ${wait} 秒后再试`, wait);
    }
    const windowed = (where, ...params) => sql.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest
        FROM QQVerificationCode WHERE ${where} AND created_at >= ?`).get(...params, since);
    const perQQ = windowed('qq = ?', qq);
    if (perQQ.n >= LIMITS.perQQ) {
        throw new VerificationError(429, 'qq_hourly_limit', '这个QQ号获取验证码的次数过多，请一小时后再试',
            secondsUntil(perQQ.oldest, WINDOW_MS, nowMs));
    }
    if (ip) {
        const perIp = windowed('ip = ?', ip);
        if (perIp.n >= LIMITS.perIp) {
            throw new VerificationError(429, 'ip_hourly_limit', '获取验证码的次数过多，请稍后再试',
                secondsUntil(perIp.oldest, WINDOW_MS, nowMs));
        }
    }
    const global = windowed('1 = 1');
    if (global.n >= LIMITS.global) {
        throw new VerificationError(429, 'global_hourly_limit', '验证码发送繁忙，请稍后再试',
            secondsUntil(global.oldest, WINDOW_MS, nowMs));
    }
}

const reserveTransaction = sql.transaction(({ purpose, qq, ip, nowMs }) => {
    sql.prepare('DELETE FROM QQVerificationCode WHERE created_at < ?').run(iso(nowMs - RETENTION_MS));
    enforceLimits({ qq, ip, nowMs });
    const code = generateCode();
    const info = sql.prepare(`INSERT INTO QQVerificationCode (purpose, qq, code_hash, status, ip, created_at, expires_at)
        VALUES (?, ?, ?, 'sending', ?, ?, ?)`).run(purpose, qq, hashCode(purpose, qq, code), ip || null, iso(nowMs), iso(nowMs + CODE_TTL_MS));
    return { id: Number(info.lastInsertRowid), code };
});

/**
 * Checks the rate limits and records a new code before it is sent, so concurrent
 * requests cannot both pass the cooldown. Throws VerificationError (429) when limited.
 */
function reserveCode({ purpose, qq, ip, now = new Date() }) {
    if (!PURPOSE_VALUES.has(purpose)) throw new Error(`unknown verification purpose: ${purpose}`);
    return reserveTransaction.immediate({ purpose, qq, ip, nowMs: now.getTime() });
}

const markSentTransaction = sql.transaction((id) => {
    const row = sql.prepare('SELECT purpose, qq FROM QQVerificationCode WHERE id = ?').get(id);
    if (!row) return;
    sql.prepare(`UPDATE QQVerificationCode SET status = 'superseded'
        WHERE qq = ? AND purpose = ? AND status = 'sent' AND id != ?`).run(row.qq, row.purpose, id);
    sql.prepare(`UPDATE QQVerificationCode SET status = 'sent' WHERE id = ? AND status = 'sending'`).run(id);
});

/** The bot delivered the code (or may have): it becomes the only valid one. */
function markSent(id) {
    markSentTransaction.immediate(id);
}

function markFailed(id) {
    sql.prepare(`UPDATE QQVerificationCode SET status = 'failed' WHERE id = ? AND status = 'sending'`).run(id);
}

/**
 * Call inside the registration/reset write transaction. A wrong code increments
 * the attempt counter, so the caller must return (not throw) on failure for that
 * write to commit. Returns { ok: true, id } or { ok: false, reason, message }.
 */
function checkCode({ purpose, qq, code, now = new Date() }) {
    const row = sql.prepare(`SELECT id, code_hash, attempts, expires_at FROM QQVerificationCode
        WHERE qq = ? AND purpose = ? AND status = 'sent' ORDER BY id DESC LIMIT 1`).get(qq, purpose);
    if (!row || Date.parse(row.expires_at) <= now.getTime()) {
        return { ok: false, reason: 'verification_code_expired', message: '验证码已过期或尚未获取，请重新获取' };
    }
    if (row.attempts >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'verification_code_locked', message: '验证码错误次数过多，请重新获取' };
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(purpose, qq, String(code || '')), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
        sql.prepare('UPDATE QQVerificationCode SET attempts = attempts + 1 WHERE id = ?').run(row.id);
        const remaining = MAX_ATTEMPTS - row.attempts - 1;
        return remaining > 0
            ? { ok: false, reason: 'verification_code_wrong', message: `验证码错误，还可以再试 ${remaining} 次` }
            : { ok: false, reason: 'verification_code_locked', message: '验证码错误次数过多，请重新获取' };
    }
    return { ok: true, id: row.id };
}

/** Call in the same transaction as the write the code authorises. */
function consumeCode(id, now = new Date()) {
    sql.prepare(`UPDATE QQVerificationCode SET status = 'used', used_at = ? WHERE id = ?`).run(now.toISOString(), id);
}

// The code is the first number in the text: the login panel accepts the whole
// message pasted into the code field and keeps its first six digits.
function verificationMessage(purpose, code, { username } = {}) {
    const minutes = Math.round(CODE_TTL_MS / 60000);
    if (purpose === PURPOSES.resetPassword) {
        return `【东方饭联地图】找回通行密码的验证码：${code}\n住民名：${username}\n`
            + `${minutes} 分钟内有效，请勿告诉他人。如果不是你本人在操作，请忽略这条消息，密码不会被修改。`;
    }
    return `【东方饭联地图】注册验证码：${code}\n`
        + `${minutes} 分钟内有效，请勿告诉他人。如果不是你本人在注册，请忽略这条消息。`;
}

module.exports = {
    PURPOSES,
    PURPOSE_VALUES,
    CODE_TTL_MS,
    RESEND_COOLDOWN_MS,
    MAX_ATTEMPTS,
    LIMITS,
    VerificationError,
    reserveCode,
    markSent,
    markFailed,
    checkCode,
    consumeCode,
    verificationMessage,
    maskQQ
};
