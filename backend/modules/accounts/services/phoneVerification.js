const { db } = require('../../../infrastructure/database');
const { VerificationError, createVerificationCodeStore, createCodeTableSql } = require('./verificationCodeStore');

// SMS codes for the resident's phone number (infrastructure/aliyunSms.js: mainland numbers via
// Aliyun dypns, other regions via the SMS service's international channel when configured).
// register: a new resident proves the phone at registration (the QQ code is still
// required). change_phone: a logged-in resident binds or replaces the phone; the old
// number is not verified. Password reset stays QQ-only. One account per phone.
const sql = db._raw;

const PURPOSES = Object.freeze({ register: 'register', changePhone: 'change_phone' });
const PURPOSE_VALUES = new Set(Object.values(PURPOSES));

// Sends per hour (globalDaily per 24 h). Every SMS costs money and can be abused to
// flood someone else's phone: the per-phone limit protects the recipient, per-IP and
// per-subject (the QQ for registration, the user for a change) stop one visitor from
// spraying numbers, the global limits cap the bill.
const LIMITS = Object.freeze({ perKey: 5, perIp: 10, perSubject: 5, global: 60, globalDaily: 300 });

function initPhoneVerificationSchema(database) {
    database.exec(createCodeTableSql('PhoneVerificationCode', 'phone'));
}

const store = createVerificationCodeStore({
    table: 'PhoneVerificationCode',
    keyColumn: 'phone',
    hashScope: 'sms',
    purposes: PURPOSE_VALUES,
    limits: LIMITS,
    messages: {
        cooldown: (wait) => `短信验证码发送太频繁，请 ${wait} 秒后再试`,
        perKey: '这个手机号获取验证码的次数过多，请一小时后再试',
        perIp: '获取短信验证码的次数过多，请稍后再试',
        perSubject: '获取短信验证码的次数过多，请一小时后再试',
        global: '短信验证码发送繁忙，请稍后再试',
        globalDaily: '今天的短信验证码已发完，请明天再试'
    }
});

const MAINLAND = '86';

/** Calling code without + / 00: 1–3 digits, no leading zero. Empty means mainland China. */
function normalizeCountryCode(value) {
    if (value === undefined || value === null || String(value).trim() === '') return MAINLAND;
    const text = String(value).trim().replace(/^(?:\+|00)/, '');
    return /^[1-9]\d{0,2}$/.test(text) ? text : null;
}

/**
 * Canonical form stored in User.phone and PhoneVerificationCode.phone: "+<calling code> <national number>"
 * (E.123 international notation; e.g. "+86 13800138000", "+852 61234567"). Mainland numbers must be
 * 11-digit mobiles; other regions accept 4–14 national digits (E.164 allows 15 digits in total),
 * with a leading trunk 0 dropped. Accepts spaces, dashes, brackets, and a full "+<code>…" / "00<code>…"
 * number when it starts with the given code. Returns null when invalid.
 */
function normalizePhone(value, countryCode) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const code = normalizeCountryCode(countryCode);
    if (!code) return null;
    let digits = String(value).trim().replace(/[\s\-()]/g, '');
    const international = digits.match(/^(?:\+|00)(\d+)$/);
    if (international) {
        if (!international[1].startsWith(code)) return null;
        digits = international[1].slice(code.length);
    } else if (code === MAINLAND && /^861\d{10}$/.test(digits)) {
        digits = digits.slice(2);
    }
    if (!/^\d+$/.test(digits)) return null;
    if (code === MAINLAND) return /^1[3-9]\d{9}$/.test(digits) ? `+86 ${digits}` : null;
    digits = digits.replace(/^0+/, '');
    if (digits.length < 4 || code.length + digits.length > 15) return null;
    return `+${code} ${digits}`;
}

/** { countryCode, national } of a canonical number, or null. */
function splitPhone(phone) {
    const match = /^\+([1-9]\d{0,2}) (\d{4,14})$/.exec(String(phone || ''));
    return match ? { countryCode: match[1], national: match[2] } : null;
}

function isMainland(phone) {
    const parts = splitPhone(phone);
    return !!parts && parts.countryCode === MAINLAND;
}

/** Mainland "138****8000"; elsewhere the calling code stays visible: "+852 61****78". */
function maskPhone(phone) {
    const parts = splitPhone(phone);
    if (!parts) return null;
    const { countryCode, national } = parts;
    if (countryCode === MAINLAND) return `${national.slice(0, 3)}****${national.slice(-4)}`;
    return `+${countryCode} ${national.length >= 7 ? national.slice(0, 2) : ''}****${national.slice(-2)}`;
}

function findUserByPhone(phone) {
    return sql.prepare('SELECT id FROM User WHERE phone = ?').get(phone) || null;
}

function userPhone(userId) {
    const row = sql.prepare('SELECT phone FROM User WHERE id = ?').get(userId);
    return row ? row.phone || null : null;
}

module.exports = {
    PURPOSES,
    PURPOSE_VALUES,
    LIMITS,
    CODE_TTL_MS: store.CODE_TTL_MS,
    RESEND_COOLDOWN_MS: store.RESEND_COOLDOWN_MS,
    MAX_ATTEMPTS: store.MAX_ATTEMPTS,
    VerificationError,
    initPhoneVerificationSchema,
    reserveCode: ({ purpose, phone, subject, ip, now }) => store.reserveCode({ purpose, key: phone, subject, ip, now }),
    markSent: store.markSent,
    markFailed: store.markFailed,
    checkCode: ({ purpose, phone, code, subject, now }) => store.checkCode({ purpose, key: phone, code, subject, now }),
    consumeCode: store.consumeCode,
    normalizeCountryCode,
    normalizePhone,
    splitPhone,
    isMainland,
    maskPhone,
    findUserByPhone,
    userPhone
};
