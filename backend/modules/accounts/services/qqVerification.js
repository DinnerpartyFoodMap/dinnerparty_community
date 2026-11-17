const { VerificationError, createVerificationCodeStore } = require('./verificationCodeStore');

// Short-lived codes the QQ bot sends by private message. They prove the person
// registering (or resetting a password) owns the QQ number. Bookkeeping (hash
// only, newest code wins, attempts, consumption) lives in verificationCodeStore.js.
const PURPOSES = Object.freeze({ register: 'register', resetPassword: 'reset_password' });
const PURPOSE_VALUES = new Set(Object.values(PURPOSES));

// Sends per hour. The per-QQ limit protects the recipient, the per-IP limit stops
// one visitor from spraying many numbers, and the global limit keeps the bot
// account clear of QQ's spam controls.
const LIMITS = Object.freeze({ perKey: 5, perIp: 10, global: 60 });

const store = createVerificationCodeStore({
    table: 'QQVerificationCode',
    keyColumn: 'qq',
    withSubject: false,
    purposes: PURPOSE_VALUES,
    limits: LIMITS,
    messages: {
        cooldown: (wait) => `验证码发送太频繁，请 ${wait} 秒后再试`,
        perKey: '这个QQ号获取验证码的次数过多，请一小时后再试',
        perIp: '获取验证码的次数过多，请稍后再试',
        global: '验证码发送繁忙，请稍后再试'
    }
});

function maskQQ(qq) {
    const text = String(qq || '');
    return text.length > 4 ? `${text.slice(0, 2)}****${text.slice(-2)}` : '****';
}

// The code is the first number in the text: the login panel accepts the whole
// message pasted into the code field and keeps its first six digits.
function verificationMessage(purpose, code, { username } = {}) {
    const minutes = Math.round(store.CODE_TTL_MS / 60000);
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
    CODE_TTL_MS: store.CODE_TTL_MS,
    RESEND_COOLDOWN_MS: store.RESEND_COOLDOWN_MS,
    MAX_ATTEMPTS: store.MAX_ATTEMPTS,
    LIMITS: Object.freeze({ perQQ: LIMITS.perKey, perIp: LIMITS.perIp, global: LIMITS.global }),
    VerificationError,
    reserveCode: ({ purpose, qq, ip, now }) => store.reserveCode({ purpose, key: qq, ip, now }),
    markSent: store.markSent,
    markFailed: store.markFailed,
    checkCode: ({ purpose, qq, code, now }) => store.checkCode({ purpose, key: qq, code, now }),
    consumeCode: store.consumeCode,
    verificationMessage,
    maskQQ
};
