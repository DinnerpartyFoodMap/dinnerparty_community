const crypto = require('crypto');

// SMS verification codes through Aliyun. We generate the code ourselves and pass it in
// TemplateParam, so checking (attempts, single use, purpose) stays local in
// modules/accounts/services/phoneVerification.js; Aliyun only delivers the text.
//   - Mainland China (+86): 号码认证服务 Dypnsapi SendSmsVerifyCode with the system-provided
//     signatures/templates. Dypns only reaches mainland numbers.
//   - Other regions (incl. 港澳台): 短信服务 国际/港澳台短信, Dysmsapi 2018-05-01 SendMessageToGlobe.
//     No signature or template: we send the text ourselves (intlMessage), optionally with a
//     SenderID. Billed per submission even when the carrier later fails, so it stays off
//     until SMS_INTL_ENABLED=true.
// Both are RPC APIs signed with signature version 1.0 (HMAC-SHA1). The AccessKey is shared
// with the image OSS (OSS_ACCESS_KEY_*) unless SMS_ACCESS_KEY_* is set; the RAM user needs
// dypns:SendSmsVerifyCode (and dysms:SendMessageToGlobe for other regions).
const DYPNS_VERSION = '2017-05-25';
const GLOBE_VERSION = '2018-05-01';
const DEFAULT_ENDPOINT = 'dypnsapi.aliyuncs.com';
// Dysmsapi 2018-05-01 (SendMessageToGlobe) is only served from the ap-southeast-1 endpoint.
const DEFAULT_INTL_ENDPOINT = 'dysmsapi.ap-southeast-1.aliyuncs.com';
const DEFAULT_TIMEOUT_MS = 10000;
// System-provided templates: 100001 登录/注册, 100004 绑定新手机号.
const DEFAULT_TEMPLATES = Object.freeze({ register: '100001', change_phone: '100004' });

class SmsError extends Error {
    constructor(code, message, { providerCode, providerMessage, requestId, outcomeUnknown = false } = {}) {
        super(message);
        this.name = 'SmsError';
        this.code = code;
        this.providerCode = providerCode;
        this.providerMessage = providerMessage;
        this.requestId = requestId;
        this.outcomeUnknown = outcomeUnknown;
    }
}

function readConfig(env = process.env) {
    const text = (name) => String(env[name] || '').trim();
    const ttl = Number.parseInt(env.SMS_CODE_VALID_SECONDS, 10);
    return {
        accessKeyId: text('SMS_ACCESS_KEY_ID') || text('OSS_ACCESS_KEY_ID'),
        accessKeySecret: text('SMS_ACCESS_KEY_SECRET') || text('OSS_ACCESS_KEY_SECRET'),
        signName: text('SMS_SIGN_NAME'),
        schemeName: text('SMS_SCHEME_NAME'),
        endpoint: text('SMS_ENDPOINT') || DEFAULT_ENDPOINT,
        templates: {
            register: text('SMS_TEMPLATE_REGISTER') || DEFAULT_TEMPLATES.register,
            change_phone: text('SMS_TEMPLATE_CHANGE_PHONE') || DEFAULT_TEMPLATES.change_phone
        },
        intl: {
            enabled: /^(1|true|yes|on)$/i.test(text('SMS_INTL_ENABLED')),
            endpoint: text('SMS_INTL_ENDPOINT') || DEFAULT_INTL_ENDPOINT,
            // SenderID（国际/港澳台短信 → SenderID）：字母数字，含字母最长 11 位；多数国家可不填，美国不支持
            senderId: text('SMS_INTL_SENDER_ID'),
            channelId: text('SMS_INTL_CHANNEL_ID')
        },
        validSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 300
    };
}

function hasKey(config) {
    return !!(config.accessKeyId && config.accessKeySecret);
}

// RFC 3986 encoding as the RPC signature requires (space → %20, * → %2A, ~ kept).
function percentEncode(value) {
    return encodeURIComponent(String(value))
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
    return Object.keys(params).sort()
        .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join('&');
}

/** Signature version 1.0: base64(HMAC-SHA1(secret + '&', METHOD&%2F&encode(canonical query))). */
function signRpcRequest(method, params, accessKeySecret) {
    const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`;
    return crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
}

function rpcTimestamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Provider errors the user can act on; everything else is a generic delivery failure.
function classifyProviderError(providerCode = '') {
    const code = String(providerCode).toUpperCase();
    if (code.includes('MOBILE_NUMBER_ILLEGAL') || code.includes('PHONE_NUMBER_ILLEGAL')) return 'invalid_phone';
    if (code.includes('LIMIT_CONTROL') || code.includes('FREQUENCY')) return 'rate_limited';
    if (code.includes('BLACK')) return 'blocked';
    return 'failed';
}

/**
 * Text of an international verification SMS (no template there). Chinese plus a short English
 * line, kept under 70 characters so it is one UCS-2 segment.
 */
function intlMessage(code, minutes) {
    return `【东方饭联地图】验证码 ${code}，${minutes} 分钟内有效，请勿告诉他人。Your code: ${code}`;
}

/** "+<code> <national>" (phoneVerification.normalizePhone) → parts, or null. */
function splitPhone(phone) {
    const match = /^\+([1-9]\d{0,2}) (\d{4,14})$/.exec(String(phone || ''));
    return match ? { countryCode: match[1], national: match[2] } : null;
}

/**
 * @param {{ config?: object, fetchImpl?: typeof fetch, now?: () => Date, nonce?: () => string, timeoutMs?: number }} [options]
 */
function createAliyunSmsClient({ config = readConfig(), fetchImpl = globalThis.fetch, now = () => new Date(),
    nonce = () => crypto.randomUUID(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const configured = hasKey(config) && !!config.signName;
    const intlConfigured = hasKey(config) && !!config.intl.enabled;

    // isOk: dypns answers { Code: 'OK' }, SendMessageToGlobe { ResponseCode: 'OK' }; gateway errors
    // (signature, RAM permission, missing service) come back as { Code } with a non-2xx status.
    async function callRpc(endpoint, params, isOk = (body) => body.Code === 'OK' && body.Success !== false) {
        const signed = {
            AccessKeyId: config.accessKeyId,
            Format: 'JSON',
            SignatureMethod: 'HMAC-SHA1',
            SignatureNonce: nonce(),
            SignatureVersion: '1.0',
            Timestamp: rpcTimestamp(now()),
            ...params
        };
        signed.Signature = signRpcRequest('POST', signed, config.accessKeySecret);
        let response;
        try {
            response = await fetchImpl(`https://${endpoint}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
                body: canonicalQuery(signed),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
            throw new SmsError(timedOut ? 'timeout' : 'failed', `SMS request failed: ${error && error.message}`, { outcomeUnknown: true });
        }
        const text = await response.text().catch(() => '');
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch (error) { body = {}; }
        const requestId = body.RequestId || (body.Model && body.Model.RequestId);
        if (!response.ok || !isOk(body)) {
            const providerCode = body.ResponseCode || body.Code || `HTTP_${response.status}`;
            throw new SmsError(classifyProviderError(providerCode), `SMS rejected: ${providerCode}`, {
                providerCode, providerMessage: body.ResponseDescription || body.Message, requestId
            });
        }
        return { bizId: body.MessageId || body.BizId || (body.Model && body.Model.BizId), requestId };
    }

    /** Whether a code can be sent to this canonical number with the current configuration. */
    function supports(phone) {
        const parts = splitPhone(phone);
        if (!parts) return false;
        return parts.countryCode === '86' ? configured : intlConfigured;
    }

    /**
     * Sends `code` to a canonical number ("+86 138…", "+852 6…"). Resolves { bizId, requestId, channel };
     * rejects with SmsError (code: not_configured | intl_not_configured | invalid_phone | rate_limited |
     * blocked | failed | timeout). A timeout or network error sets outcomeUnknown: the SMS may still arrive.
     */
    async function sendVerifyCode({ phone, code, purpose, outId }) {
        const parts = splitPhone(phone);
        if (!parts) throw new SmsError('invalid_phone', 'not a canonical phone number');
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, purpose)) throw new Error(`unknown SMS purpose: ${purpose}`);

        const minutes = String(Math.max(1, Math.round(config.validSeconds / 60)));
        if (parts.countryCode !== '86') {
            if (!intlConfigured) throw new SmsError('intl_not_configured', 'international SMS is not configured');
            const params = {
                Action: 'SendMessageToGlobe',
                Version: GLOBE_VERSION,
                To: `${parts.countryCode}${parts.national}`,
                Message: intlMessage(code, minutes),
                Type: 'OTP',
                // 过了验证码有效期就不必再投递
                ValidityPeriod: String(config.validSeconds)
            };
            if (config.intl.senderId) params.From = config.intl.senderId;
            if (config.intl.channelId) params.ChannelId = config.intl.channelId;
            if (outId) params.TaskId = String(outId).slice(0, 255);
            return { ...(await callRpc(config.intl.endpoint, params, (body) => body.ResponseCode === 'OK')), channel: 'intl' };
        }

        if (!configured) throw new SmsError('not_configured', 'SMS is not configured');
        const params = {
            Action: 'SendSmsVerifyCode',
            Version: DYPNS_VERSION,
            PhoneNumber: parts.national,
            CountryCode: '86',
            SignName: config.signName,
            TemplateCode: config.templates[purpose],
            TemplateParam: JSON.stringify({ code, min: minutes }),
            CodeLength: String(code.length),
            CodeType: '1',
            ValidTime: String(config.validSeconds),
            Interval: '60',
            ReturnVerifyCode: 'false'
        };
        if (config.schemeName) params.SchemeName = config.schemeName;
        if (outId) params.OutId = String(outId).slice(0, 64);
        return { ...(await callRpc(config.endpoint, params)), channel: 'dypns' };
    }

    return { configured, intlConfigured, supports, sendVerifyCode };
}

let defaultClient = null;
let overrideClient = null;

function getSmsClient() {
    if (overrideClient) return overrideClient;
    if (!defaultClient) defaultClient = createAliyunSmsClient();
    return defaultClient;
}

function setSmsClientForTesting(client) {
    overrideClient = client || null;
}

module.exports = {
    SmsError,
    DEFAULT_TEMPLATES,
    readConfig,
    percentEncode,
    canonicalQuery,
    signRpcRequest,
    intlMessage,
    createAliyunSmsClient,
    getSmsClient,
    setSmsClientForTesting
};
