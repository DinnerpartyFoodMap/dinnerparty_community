const crypto = require('crypto');
const { db } = require('../../../infrastructure/database');

// Shared bookkeeping for short-lived numeric codes (QQ bot private messages and
// SMS). Only a keyed hash is stored; the newest sent code per key + purpose is
// the only valid one, it allows a few wrong guesses and is consumed inside the
// caller's write transaction. Each code store has its own table with the columns
// created by createCodeTableSql().
const sql = db._raw;
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

/** Columns every code table needs; `keyColumn` is the recipient (qq / phone). */
function createCodeTableSql(table, keyColumn) {
    return `CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        ${keyColumn} TEXT NOT NULL,
        subject TEXT,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sending',
        attempts INTEGER NOT NULL DEFAULT 0,
        ip TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${table.toLowerCase()}_key ON ${table}(${keyColumn}, created_at);
    CREATE INDEX IF NOT EXISTS idx_${table.toLowerCase()}_ip ON ${table}(ip, created_at);
    CREATE INDEX IF NOT EXISTS idx_${table.toLowerCase()}_subject ON ${table}(subject, created_at);
    CREATE INDEX IF NOT EXISTS idx_${table.toLowerCase()}_created ON ${table}(created_at);`;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.table           code table (created by the caller's schema init)
 * @param {string} options.keyColumn       recipient column: 'qq' or 'phone'
 * @param {string} [options.hashScope]     mixed into the HMAC so codes of different stores never collide
 *        (empty for the QQ store, whose hashes predate this module)
 * @param {boolean} [options.withSubject]  the table has a `subject` column (who asked for the code)
 * @param {Set<string>} options.purposes
 * @param {{ perKey: number, perIp: number, perSubject?: number, global: number, globalDaily?: number }} options.limits
 *        sends per hour (globalDaily: per 24 h)
 * @param {object} options.messages        public 429 texts: cooldown(wait), perKey, perIp, perSubject, global, globalDaily
 */
function createVerificationCodeStore({
    table, keyColumn, hashScope = '', withSubject = true, purposes, limits, messages,
    ttlMs = 5 * 60 * 1000, cooldownMs = 60 * 1000, maxAttempts = 5,
    windowMs = 60 * 60 * 1000, retentionMs = 2 * DAY_MS
}) {
    const hashCode = (purpose, key, code) => crypto.createHmac('sha256', SECRET)
        .update(`${hashScope ? `${hashScope}:` : ''}${purpose}:${key}:${code}`).digest('hex');

    function enforceLimits({ key, subject, ip, nowMs }) {
        const since = iso(nowMs - windowMs);
        // Cooldown counts every send that may have reached the recipient; a failed one can be retried at once.
        const last = sql.prepare(`SELECT created_at FROM ${table}
            WHERE ${keyColumn} = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1`).get(key);
        if (last && Date.parse(last.created_at) + cooldownMs > nowMs) {
            const wait = secondsUntil(last.created_at, cooldownMs, nowMs);
            throw new VerificationError(429, 'cooldown', messages.cooldown(wait), wait);
        }
        const windowed = (where, sinceIso, ...params) => sql.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest
            FROM ${table} WHERE ${where} AND created_at >= ?`).get(...params, sinceIso);
        const check = (row, max, reason, message, spanMs) => {
            if (row.n >= max) throw new VerificationError(429, reason, message, secondsUntil(row.oldest, spanMs, nowMs));
        };
        check(windowed(`${keyColumn} = ?`, since, key), limits.perKey, `${keyColumn}_hourly_limit`, messages.perKey, windowMs);
        if (ip) check(windowed('ip = ?', since, ip), limits.perIp, 'ip_hourly_limit', messages.perIp, windowMs);
        if (withSubject && subject && limits.perSubject) {
            check(windowed('subject = ?', since, subject), limits.perSubject, 'subject_hourly_limit', messages.perSubject, windowMs);
        }
        check(windowed('1 = 1', since), limits.global, 'global_hourly_limit', messages.global, windowMs);
        if (limits.globalDaily) {
            check(windowed('1 = 1', iso(nowMs - DAY_MS)), limits.globalDaily, 'global_daily_limit', messages.globalDaily, DAY_MS);
        }
    }

    const reserveTransaction = sql.transaction(({ purpose, key, subject, ip, nowMs }) => {
        sql.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(iso(nowMs - retentionMs));
        enforceLimits({ key, subject, ip, nowMs });
        const code = generateCode();
        const hash = hashCode(purpose, key, code);
        const info = withSubject
            ? sql.prepare(`INSERT INTO ${table} (purpose, ${keyColumn}, subject, code_hash, status, ip, created_at, expires_at)
                VALUES (?, ?, ?, ?, 'sending', ?, ?, ?)`).run(purpose, key, subject || null, hash, ip || null, iso(nowMs), iso(nowMs + ttlMs))
            : sql.prepare(`INSERT INTO ${table} (purpose, ${keyColumn}, code_hash, status, ip, created_at, expires_at)
                VALUES (?, ?, ?, 'sending', ?, ?, ?)`).run(purpose, key, hash, ip || null, iso(nowMs), iso(nowMs + ttlMs));
        return { id: Number(info.lastInsertRowid), code };
    });

    /**
     * Checks the rate limits and records a new code before it is sent, so concurrent
     * requests cannot both pass the cooldown. Throws VerificationError (429) when limited.
     * `subject` ties the code to who asked for it (e.g. the logged-in user).
     */
    function reserveCode({ purpose, key, subject = null, ip, now = new Date() }) {
        if (!purposes.has(purpose)) throw new Error(`unknown verification purpose: ${purpose}`);
        return reserveTransaction.immediate({ purpose, key, subject, ip, nowMs: now.getTime() });
    }

    const markSentTransaction = sql.transaction((id) => {
        const row = sql.prepare(`SELECT purpose, ${keyColumn} AS key FROM ${table} WHERE id = ?`).get(id);
        if (!row) return;
        sql.prepare(`UPDATE ${table} SET status = 'superseded'
            WHERE ${keyColumn} = ? AND purpose = ? AND status = 'sent' AND id != ?`).run(row.key, row.purpose, id);
        sql.prepare(`UPDATE ${table} SET status = 'sent' WHERE id = ? AND status = 'sending'`).run(id);
    });

    /** The code was delivered (or may have been): it becomes the only valid one. */
    function markSent(id) {
        markSentTransaction.immediate(id);
    }

    function markFailed(id) {
        sql.prepare(`UPDATE ${table} SET status = 'failed' WHERE id = ? AND status = 'sending'`).run(id);
    }

    /**
     * Call inside the write transaction the code authorises. A wrong code increments
     * the attempt counter, so the caller must return (not throw) on failure for that
     * write to commit. With `subject` the code must have been requested by the same
     * subject. Returns { ok: true, id } or { ok: false, reason, message }.
     */
    function checkCode({ purpose, key, code, subject, now = new Date() }) {
        const row = sql.prepare(`SELECT id, code_hash, attempts, expires_at${withSubject ? ', subject' : ''} FROM ${table}
            WHERE ${keyColumn} = ? AND purpose = ? AND status = 'sent' ORDER BY id DESC LIMIT 1`).get(key, purpose);
        const otherSubject = withSubject && subject !== undefined && String(row?.subject || '') !== String(subject || '');
        if (!row || Date.parse(row.expires_at) <= now.getTime() || otherSubject) {
            return { ok: false, reason: 'verification_code_expired', message: '验证码已过期或尚未获取，请重新获取' };
        }
        if (row.attempts >= maxAttempts) {
            return { ok: false, reason: 'verification_code_locked', message: '验证码错误次数过多，请重新获取' };
        }
        const expected = Buffer.from(row.code_hash, 'hex');
        const actual = Buffer.from(hashCode(purpose, key, String(code || '')), 'hex');
        if (!crypto.timingSafeEqual(expected, actual)) {
            sql.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
            const remaining = maxAttempts - row.attempts - 1;
            return remaining > 0
                ? { ok: false, reason: 'verification_code_wrong', message: `验证码错误，还可以再试 ${remaining} 次` }
                : { ok: false, reason: 'verification_code_locked', message: '验证码错误次数过多，请重新获取' };
        }
        return { ok: true, id: row.id };
    }

    /** Call in the same transaction as the write the code authorises. */
    function consumeCode(id, now = new Date()) {
        sql.prepare(`UPDATE ${table} SET status = 'used', used_at = ? WHERE id = ?`).run(now.toISOString(), id);
    }

    return {
        CODE_TTL_MS: ttlMs,
        RESEND_COOLDOWN_MS: cooldownMs,
        MAX_ATTEMPTS: maxAttempts,
        LIMITS: limits,
        reserveCode,
        markSent,
        markFailed,
        checkCode,
        consumeCode
    };
}

module.exports = { VerificationError, createVerificationCodeStore, createCodeTableSql };
