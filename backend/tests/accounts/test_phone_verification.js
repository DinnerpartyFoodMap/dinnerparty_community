'use strict';

// Phone numbers: the Aliyun dypns client (signature, request, error mapping) with a fake
// fetch, and the SMS-code routes for registration and changing the bound phone with
// real users routes, a temp SQLite file, an in-memory session store and a fake SMS
// client. No network access, no Redis needed.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-phone-verification-'));
process.env.DB_FILE = path.join(tempDirectory, 'phone.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';

const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
const sms = require('../../infrastructure/aliyunSms');
const { setSessionStoreForTesting } = require('../../modules/accounts/middleware/auth');
const { createSessionStore } = require('../../modules/accounts/services/sessions');
const { FakeRedis } = require('../helpers/fakeRedis');
const qqVerification = require('../../modules/accounts/services/qqVerification');
const phoneVerification = require('../../modules/accounts/services/phoneVerification');
const usersRouter = require('../../modules/accounts/routes/users');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// --- the dypns client --------------------------------------------------------------
async function testSmsClient() {
    // Aliyun's published signature version 1.0 example.
    assert.equal(sms.signRpcRequest('GET', {
        Timestamp: '2016-02-23T12:46:24Z', Format: 'XML', AccessKeyId: 'testid', Action: 'DescribeRegions',
        SignatureMethod: 'HMAC-SHA1', SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
        Version: '2014-05-26', SignatureVersion: '1.0'
    }, 'testsecret'), 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
    assert.equal(sms.percentEncode("a b*~'()!"), 'a%20b%2A~%27%28%29%21');

    // The AccessKey falls back to the image OSS pair; a sign name is required.
    let config = sms.readConfig({ OSS_ACCESS_KEY_ID: 'oss-id', OSS_ACCESS_KEY_SECRET: 'oss-secret' });
    assert.deepEqual([config.accessKeyId, config.accessKeySecret, config.signName], ['oss-id', 'oss-secret', '']);
    assert.equal(sms.createAliyunSmsClient({ config }).configured, false);
    await assert.rejects(sms.createAliyunSmsClient({ config }).sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'register' }),
        (error) => error.code === 'not_configured');
    config = sms.readConfig({ OSS_ACCESS_KEY_ID: 'oss-id', OSS_ACCESS_KEY_SECRET: 'oss-secret',
        SMS_ACCESS_KEY_ID: 'sms-id', SMS_ACCESS_KEY_SECRET: 'sms-secret', SMS_SIGN_NAME: '测试签名' });
    assert.deepEqual([config.accessKeyId, config.templates.register, config.templates.change_phone], ['sms-id', '100001', '100004']);

    const requests = [];
    let reply = { status: 200, body: { Code: 'OK', Success: true, Message: '成功', RequestId: 'req-1', Model: { BizId: 'biz-1' } } };
    const fetchImpl = async (url, options) => {
        requests.push({ url, options });
        if (reply instanceof Error) throw reply;
        return { ok: reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.body) };
    };
    const client = sms.createAliyunSmsClient({ config, fetchImpl, now: () => new Date('2026-11-17T08:00:00.123Z'), nonce: () => 'nonce-1' });
    assert.equal(client.configured, true);
    assert.deepEqual(await client.sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'change_phone', outId: 'sms-7' }),
        { bizId: 'biz-1', requestId: 'req-1', channel: 'dypns' });
    const sent = requests[0];
    assert.equal(sent.url, 'https://dypnsapi.aliyuncs.com/');
    assert.equal(sent.options.method, 'POST');
    const params = Object.fromEntries(new URLSearchParams(sent.options.body));
    assert.equal(params.Action, 'SendSmsVerifyCode');
    assert.equal(params.Version, '2017-05-25');
    assert.equal(params.Timestamp, '2026-11-17T08:00:00Z');
    assert.equal(params.PhoneNumber, '13800000000');
    assert.equal(params.CountryCode, '86');
    assert.equal(params.SignName, '测试签名');
    assert.equal(params.TemplateCode, '100004');
    assert.deepEqual(JSON.parse(params.TemplateParam), { code: '123456', min: '5' });
    assert.equal(params.ReturnVerifyCode, 'false');
    assert.equal(params.OutId, 'sms-7');
    const { Signature, ...signed } = params;
    assert.equal(Signature, sms.signRpcRequest('POST', signed, 'sms-secret'), 'body carries a valid signature');

    // Other regions go to the SMS service's international channel, only when it is configured.
    assert.equal(client.intlConfigured, false);
    assert.equal(client.supports('+86 13800000000'), true);
    assert.equal(client.supports('+852 61234567'), false);
    await assert.rejects(client.sendVerifyCode({ phone: '+852 61234567', code: '123456', purpose: 'register' }),
        (error) => error.code === 'intl_not_configured');
    const intlConfig = sms.readConfig({ OSS_ACCESS_KEY_ID: 'oss-id', OSS_ACCESS_KEY_SECRET: 'oss-secret',
        SMS_SIGN_NAME: '测试签名', SMS_INTL_ENABLED: 'true', SMS_INTL_SENDER_ID: 'FoodMap' });
    const intlClient = sms.createAliyunSmsClient({ config: intlConfig, fetchImpl, now: () => new Date('2026-11-17T08:00:00Z'), nonce: () => 'nonce-2' });
    assert.equal(intlClient.supports('+852 61234567'), true);
    // SendMessageToGlobe answers with ResponseCode, not Code
    reply = { status: 200, body: { ResponseCode: 'OK', ResponseDescription: 'accepted', RequestId: 'req-intl', MessageId: 'biz-intl', Segments: '1' } };
    assert.deepEqual(await intlClient.sendVerifyCode({ phone: '+852 61234567', code: '654321', purpose: 'change_phone' }),
        { bizId: 'biz-intl', requestId: 'req-intl', channel: 'intl' });
    const intlSent = requests[requests.length - 1];
    assert.equal(intlSent.url, 'https://dysmsapi.ap-southeast-1.aliyuncs.com/');
    const intlParams = Object.fromEntries(new URLSearchParams(intlSent.options.body));
    assert.deepEqual([intlParams.Action, intlParams.Version, intlParams.To, intlParams.From, intlParams.Type, intlParams.ValidityPeriod],
        ['SendMessageToGlobe', '2018-05-01', '85261234567', 'FoodMap', 'OTP', '300']);
    assert.equal(intlParams.Message, sms.intlMessage('654321', '5'));
    assert.ok(intlParams.Message.includes('654321') && intlParams.Message.length <= 70, 'one UCS-2 segment');
    assert.equal(intlParams.Message.match(/\d+/)[0], '654321', 'routes that resend a fixed template take the first number');
    assert.equal(intlParams.SignName, undefined, 'no signature or template on the international channel');
    reply = { status: 200, body: { ResponseCode: 'MOBILE_NUMBER_ILLEGAL', ResponseDescription: 'bad number', RequestId: 'req-intl-2' } };
    await assert.rejects(intlClient.sendVerifyCode({ phone: '+852 61234567', code: '654321', purpose: 'register' }),
        (error) => error.code === 'invalid_phone' && error.providerMessage === 'bad number');
    const { Signature: intlSignature, ...intlSigned } = intlParams;
    assert.equal(intlSignature, sms.signRpcRequest('POST', intlSigned, 'oss-secret'));

    reply = { status: 400, body: { Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: 'limit', RequestId: 'req-2' } };
    await assert.rejects(client.sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'register' }),
        (error) => error.code === 'rate_limited' && error.providerCode === 'isv.BUSINESS_LIMIT_CONTROL' && !error.outcomeUnknown);
    reply = { status: 400, body: { Code: 'MOBILE_NUMBER_ILLEGAL', Message: 'bad' } };
    await assert.rejects(client.sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'register' }), (error) => error.code === 'invalid_phone');
    reply = { status: 200, body: { Code: 'FUNCTION_NOT_OPENED', Success: false } };
    await assert.rejects(client.sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'register' }), (error) => error.code === 'failed');
    reply = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    await assert.rejects(client.sendVerifyCode({ phone: '+86 13800000000', code: '123456', purpose: 'register' }),
        (error) => error.code === 'timeout' && error.outcomeUnknown === true);
}

// --- fake sender used by the routes --------------------------------------------------
const smsSent = [];
const fakeSms = {
    configured: true,
    intlConfigured: false,
    failure: null,
    supports(phone) { return phone.startsWith('+86 ') ? this.configured : this.intlConfigured; },
    async sendVerifyCode(message) {
        if (this.failure) throw this.failure;
        smsSent.push(message);
        return { bizId: `biz-${smsSent.length}`, requestId: `req-${smsSent.length}`, channel: message.phone.startsWith('+86 ') ? 'dypns' : 'intl' };
    }
};
const lastSms = () => smsSent[smsSent.length - 1];

function issueQQCode(qq) {
    const { id, code } = qqVerification.reserveCode({ purpose: qqVerification.PURPOSES.register, qq, ip: '192.0.2.1' });
    qqVerification.markSent(id);
    return code;
}

function phoneRows(phone) {
    return sql.prepare('SELECT purpose, subject, status, attempts FROM PhoneVerificationCode WHERE phone = ? ORDER BY id').all(phone);
}

function skipCooldown(phone) {
    sql.prepare('UPDATE PhoneVerificationCode SET created_at = ? WHERE phone = ?').run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), phone);
}

async function main() {
    await testSmsClient();

    assert.equal(phoneVerification.normalizePhone('+86 138-0013-8000'), '+86 13800138000');
    assert.equal(phoneVerification.normalizePhone('008613800138000'), '+86 13800138000');
    assert.equal(phoneVerification.normalizePhone('13800138000', '+86'), '+86 13800138000');
    assert.equal(phoneVerification.normalizePhone('12800138000'), null, 'mobile numbers start with 13–19');
    assert.equal(phoneVerification.normalizePhone('1380013800'), null);
    assert.equal(phoneVerification.normalizePhone({}), null);
    // other regions keep their calling code; a trunk 0 is dropped; the code must match a full +number
    assert.equal(phoneVerification.normalizePhone('6123 4567', '852'), '+852 61234567');
    assert.equal(phoneVerification.normalizePhone('+852 6123 4567', '852'), '+852 61234567');
    assert.equal(phoneVerification.normalizePhone('07911 123456', '44'), '+44 7911123456');
    assert.equal(phoneVerification.normalizePhone('(202) 555-0123', '1'), '+1 2025550123');
    assert.equal(phoneVerification.normalizePhone('+85261234567', '86'), null);
    assert.equal(phoneVerification.normalizePhone('123', '852'), null);
    assert.equal(phoneVerification.normalizePhone('1234567890123', '852'), null, 'E.164 allows 15 digits');
    assert.equal(phoneVerification.normalizePhone('61234567', '0852'), null);
    assert.equal(phoneVerification.maskPhone('+86 13800138000'), '138****8000');
    assert.equal(phoneVerification.maskPhone('+852 61234567'), '+852 61****67');
    assert.equal(phoneVerification.maskPhone(null), null);

    init();
    setSessionStoreForTesting(createSessionStore(new FakeRedis()));
    sms.setSmsClientForTesting(fakeSms);
    for (const qq of ['400001', '400002', '400003', '400004']) sql.prepare('INSERT INTO QQWhitelist (qq) VALUES (?)').run(qq);

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/users', usersRouter);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    let ipCounter = 0;
    async function call(method, url, { body, token, ip } = {}) {
        const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `198.51.100.${(ipCounter++ % 250) + 1}` };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
    }
    const phoneCode = (qq, verificationCode, phone, options) => call('POST', '/users/phone-code', { body: { qq, verificationCode, phone }, ...options });
    const register = (body) => call('POST', '/users/register', { body: { password: 'secret-1', ...body } });

    try {
        // --- registration SMS needs a valid, unconsumed QQ code first
        let qqCode = issueQQCode('400001');
        assert.equal((await phoneCode('400001', qqCode, '1234')).status, 400, 'bad phone');
        let res = await phoneCode('400001', '', '13800000001');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /QQ验证码/);
        res = await phoneCode('409999', '123456', '13800000001');
        assert.match(res.body.error, /白名单/);
        const wrongQQ = qqCode === '000000' ? '000001' : '000000';
        res = await phoneCode('400001', wrongQQ, '13800000001');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /^QQ验证码错误，还可以再试 4 次/);
        assert.equal(sql.prepare("SELECT attempts FROM QQVerificationCode WHERE qq = '400001'").get().attempts, 1, 'wrong QQ code counts here too');
        assert.equal(smsSent.length, 0);

        fakeSms.configured = false;
        assert.equal((await phoneCode('400001', qqCode, '13800000001')).status, 503, 'SMS not configured');
        fakeSms.configured = true;

        res = await phoneCode('400001', qqCode, '+86 138 0000 0001');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual([res.body.phone, res.body.expires_in, res.body.resend_after], ['138****0001', 300, 60]);
        assert.deepEqual([lastSms().phone, lastSms().purpose], ['+86 13800000001', 'register']);
        assert.match(lastSms().code, /^\d{6}$/);
        assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM PhoneVerificationCode').all()).includes(lastSms().code), 'only a hash is stored');
        assert.equal(sql.prepare("SELECT status FROM QQVerificationCode WHERE qq = '400001'").get().status, 'sent', 'QQ code is only checked');

        res = await phoneCode('400001', qqCode, '13800000001');
        assert.equal(res.status, 429, 'resend cooldown per phone');
        assert.ok(res.body.retry_after > 0 && res.body.retry_after <= 60);

        // --- registration from an old client's form (no phone fields): allowed while the switch is off
        delete process.env.REGISTRATION_PHONE_REQUIRED;
        res = await register({ username: '旧客户端住民', qq: '400004', verificationCode: issueQQCode('400004'), client: { platform: 'android', app_version: '1.0.0' } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.user.phone_masked, null);
        assert.equal(sql.prepare("SELECT phone FROM User WHERE username = '旧客户端住民'").get().phone, null);
        // a half-filled phone is never treated as an old client
        res = await register({ username: '手机住民', qq: '400001', verificationCode: qqCode, phone: '13800000001' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /短信验证码是 6 位数字/);
        // with REGISTRATION_PHONE_REQUIRED=true the old form gets an update hint
        process.env.REGISTRATION_PHONE_REQUIRED = 'true';
        res = await register({ username: '手机住民', qq: '400001', verificationCode: qqCode });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /手机号/);
        assert.match(res.body.error, /更新/);
        assert.equal(sql.prepare("SELECT status FROM QQVerificationCode WHERE qq = '400001'").get().status, 'sent', 'refused before the QQ code is used');

        // a wrong SMS code fails but keeps the QQ code usable
        const smsCode = lastSms().code;
        const wrongSms = smsCode === '000000' ? '000001' : '000000';
        res = await register({ username: '手机住民', qq: '400001', verificationCode: qqCode, phone: '13800000001', phoneCode: wrongSms });
        assert.equal(res.status, 400);
        assert.equal(res.body.field, 'phoneCode');
        assert.match(res.body.error, /^短信验证码错误/);
        assert.equal(sql.prepare("SELECT status FROM QQVerificationCode WHERE qq = '400001'").get().status, 'sent');
        // an SMS code requested along with another QQ does not count
        const otherQQCode = issueQQCode('400002');
        res = await register({ username: '别人', qq: '400002', verificationCode: otherQQCode, phone: '13800000001', phoneCode: smsCode });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /过期或尚未获取/);

        res = await register({ username: '手机住民', qq: '400001', verificationCode: qqCode, phone: '13800000001', phoneCode: smsCode });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.user.phone_masked, '138****0001');
        delete process.env.REGISTRATION_PHONE_REQUIRED;
        const memberToken = res.body.token;
        const memberId = res.body.user.id;
        assert.equal(sql.prepare('SELECT phone FROM User WHERE id = ?').get(memberId).phone, '+86 13800000001');
        assert.deepEqual(phoneRows('+86 13800000001').map((row) => [row.status, row.subject, row.attempts]), [['used', '400001', 1]]);
        assert.equal(sql.prepare("SELECT status FROM QQVerificationCode WHERE qq = '400001'").get().status, 'used');
        res = await call('GET', '/users/me', { token: memberToken });
        assert.equal(res.body.user.phone_masked, '138****0001');
        assert.equal(res.body.user.phone, undefined, 'the full number is never sent');

        // --- one account per phone, revealed only after the SMS code is verified (no probing by sending)
        skipCooldown('+86 13800000001');
        res = await phoneCode('400002', otherQQCode, '13800000001');
        assert.equal(res.status, 200, 'sending does not reveal that the number is taken');
        res = await register({ username: '抢号码', qq: '400002', verificationCode: otherQQCode, phone: '13800000001', phoneCode: lastSms().code });
        assert.equal(res.status, 409);
        assert.match(res.body.error, /已绑定其他住民/);
        assert.equal(sql.prepare("SELECT status FROM QQVerificationCode WHERE qq = '400002' ORDER BY id DESC").get().status, 'sent', 'nothing consumed');

        // --- provider failures: a clear rejection allows an immediate retry, an unknown outcome keeps the code
        fakeSms.failure = new sms.SmsError('invalid_phone', 'rejected', { providerCode: 'MOBILE_NUMBER_ILLEGAL' });
        res = await phoneCode('400002', otherQQCode, '13800000002');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /收不到短信/);
        assert.equal(phoneRows('+86 13800000002')[0].status, 'failed');
        fakeSms.failure = new sms.SmsError('timeout', 'timed out', { outcomeUnknown: true });
        res = await phoneCode('400002', otherQQCode, '13800000002');
        assert.equal(res.status, 200, 'retry right after a failed send; unknown outcome may still arrive');
        assert.equal(phoneRows('+86 13800000002')[1].status, 'sent');
        fakeSms.failure = null;

        // --- changing the bound phone (no check of the old number)
        const legacyId = crypto.randomUUID();
        sql.prepare('INSERT INTO User (id, username, password, qq) VALUES (?, ?, ?, ?)').run(legacyId, '老住民', sha256('legacy-pass'), '400003');
        res = await call('POST', '/users/login', { body: { username: '老住民', password: 'legacy-pass' } });
        assert.equal(res.body.user.phone_masked, null);
        const legacyToken = res.body.token;
        res = await call('GET', '/users/me', { token: legacyToken });
        assert.equal(res.body.user.phone_masked, null, 'residents from before may have no phone');

        assert.equal((await call('POST', '/users/me/phone/code', { body: { phone: '13800000003' } })).status, 401, 'login required');
        // another resident's number: the code is sent, the change is refused only after it is verified
        skipCooldown('+86 13800000001');
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { phone: '13800000001' } });
        assert.equal(res.status, 200);
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { phone: '13800000001', code: lastSms().code } });
        assert.equal(res.status, 409, 'another resident\'s number');
        assert.equal(sql.prepare('SELECT phone FROM User WHERE id = ?').get(legacyId).phone, null);
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { phone: '13800000003' } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual([lastSms().phone, lastSms().purpose], ['+86 13800000003', 'change_phone']);
        const changeCode = lastSms().code;
        const wrongChange = changeCode === '000000' ? '000001' : '000000';

        // the code belongs to the resident who asked for it
        res = await call('PUT', '/users/me/phone', { token: memberToken, body: { phone: '13800000003', code: changeCode } });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /过期或尚未获取/);
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { phone: '13800000003', code: wrongChange } });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /还可以再试 4 次/);
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { phone: '13800000003', code: changeCode } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.phone_masked, '138****0003');
        assert.equal(sql.prepare('SELECT phone FROM User WHERE id = ?').get(legacyId).phone, '+86 13800000003');
        assert.equal((await call('PUT', '/users/me/phone', { token: legacyToken, body: { phone: '13800000003', code: changeCode } })).status, 400, 'single use');
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { phone: '13800000003' } });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /已经是你绑定的手机号/);

        // the member replaces the number bound at registration: only the new one is verified
        res = await call('POST', '/users/me/phone/code', { token: memberToken, body: { phone: '13800000004' } });
        assert.equal(res.status, 200);
        res = await call('PUT', '/users/me/phone', { token: memberToken, body: { phone: '13800000004', code: lastSms().code } });
        assert.equal(res.status, 200);
        assert.equal(sql.prepare('SELECT phone FROM User WHERE id = ?').get(memberId).phone, '+86 13800000004');
        // the old number is free again
        assert.equal(phoneVerification.findUserByPhone('+86 13800000001'), null);

        // a number taken between sending and submitting is refused at submit time
        skipCooldown('+86 13800000004');
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { phone: '13800000005' } });
        const raceCode = lastSms().code;
        sql.prepare('UPDATE User SET phone = ? WHERE id = ?').run('+86 13800000005', memberId);
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { phone: '13800000005', code: raceCode } });
        assert.equal(res.status, 409);

        // --- overseas numbers: refused clearly until the international channel is configured
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { countryCode: '852', phone: '6123 4567' } });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /境外/);
        assert.equal(phoneRows('+852 61234567').length, 0, 'nothing reserved, no quota used');
        fakeSms.intlConfigured = true;
        res = await call('POST', '/users/me/phone/code', { token: legacyToken, body: { countryCode: '+852', phone: '6123 4567' } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.phone, '+852 61****67');
        assert.deepEqual([lastSms().phone, lastSms().purpose], ['+852 61234567', 'change_phone']);
        // the same national digits under another calling code are a different number
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { countryCode: '853', phone: '61234567', code: lastSms().code } });
        assert.equal(res.status, 400);
        res = await call('PUT', '/users/me/phone', { token: legacyToken, body: { countryCode: '852', phone: '61234567', code: lastSms().code } });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.phone_masked, '+852 61****67');
        assert.equal(sql.prepare('SELECT phone FROM User WHERE id = ?').get(legacyId).phone, '+852 61234567');
        fakeSms.intlConfigured = false;

        // --- hourly and daily limits, driven through the service with explicit clock values
        const later = Date.now() + 24 * 60 * 60 * 1000;
        for (let i = 0; i < phoneVerification.LIMITS.perSubject; i += 1) {
            phoneVerification.reserveCode({ purpose: 'change_phone', phone: `1370000000${i}`, subject: 'user-x', ip: `10.0.0.${i}`, now: new Date(later + i) });
        }
        assert.throws(() => phoneVerification.reserveCode({ purpose: 'change_phone', phone: '13700000009', subject: 'user-x', ip: '10.0.1.1', now: new Date(later + 10) }),
            (error) => error.reason === 'subject_hourly_limit' && error.status === 429);
        for (let i = 0; i < phoneVerification.LIMITS.perKey; i += 1) {
            phoneVerification.reserveCode({ purpose: 'register', phone: '13600000000', subject: `q${i}`, ip: `10.2.0.${i}`, now: new Date(later + i * 61 * 1000) });
        }
        assert.throws(() => phoneVerification.reserveCode({ purpose: 'register', phone: '13600000000', subject: 'q9', ip: '10.2.1.1', now: new Date(later + 6 * 61 * 1000) }),
            (error) => error.reason === 'phone_hourly_limit');
        // Daily cap: spread over many hours so the hourly global limit never triggers first;
        // the sends above (same day) count too.
        const dayStart = later + 3 * 60 * 60 * 1000;
        const perHour = phoneVerification.LIMITS.global - 1;
        let dailyError = null;
        let lastNow = dayStart;
        for (let n = 0; !dailyError && n < phoneVerification.LIMITS.globalDaily + 1; n += 1) {
            lastNow = dayStart + Math.floor(n / perHour) * 60 * 60 * 1000 + (n % perHour);
            try {
                phoneVerification.reserveCode({ purpose: 'register', phone: `135${String(n).padStart(8, '0')}`, subject: `d${n}`,
                    ip: `10.3.${Math.floor(n / 200)}.${n % 200}`, now: new Date(lastNow) });
            } catch (error) {
                dailyError = error;
            }
        }
        assert.equal(dailyError && dailyError.reason, 'global_daily_limit');
        const inWindow = sql.prepare('SELECT COUNT(*) AS n FROM PhoneVerificationCode WHERE created_at >= ?')
            .get(new Date(lastNow - 24 * 60 * 60 * 1000).toISOString()).n;
        assert.equal(inWindow, phoneVerification.LIMITS.globalDaily);

        console.log('Phone verification tests passed: dypns signature/request/errors, phone format, QQ-gated registration SMS, dual-code registration, uniqueness, delivery failures, change phone, subject binding, limits.');
    } finally {
        sms.setSmsClientForTesting(null);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

main().then(() => {
    db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}).catch((error) => {
    console.error(error);
    try { db.close(); } catch (closeError) { }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    process.exitCode = 1;
});
