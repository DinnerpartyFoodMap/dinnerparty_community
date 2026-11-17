// 住民设置的账号请求（住民名、通行密码、头像、主题 / 地图偏好）。网页设置页与 iOS 原生设置页共用：
// 原生只把用户输入交过来，通行凭证与请求始终留在网页层。
// 所有函数返回 { ok, message, ... }，由调用方决定如何提示；网络异常照常抛出。
import { t } from '../i18n/index.js';
import { storedMapSettings } from './mapSettings';
import { normalizeCountryCode, normalizePhoneNumber } from '../components/forms/phoneRegions';

async function readResponse(res) {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { text, data };
}

// 后端错误优先；返回 HTML（开发服务器的 index.html 等）时只给状态码，不显示整页内容
function errorMessage(res, text, data, fallback) {
    if (data && data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    if (!text) return fallback;
    return text.trim().startsWith('<') ? t('settings:common.error.serverHttp', { status: res.status }) : text;
}

/** 修改住民名。成功时返回新的 user 与 token（住民名写在通行凭证里）。 */
export async function saveUsername({ backendUrl, token, username }) {
    const newName = String(username || '').trim();
    if (!newName) return { ok: false, message: t('settings:editUsername.empty') };
    if (!backendUrl || !token) return { ok: false, message: t('settings:editUsername.missingSession') };
    const res = await fetch(`${backendUrl}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: newName })
    });
    const { text, data } = await readResponse(res);
    if (!res.ok) return { ok: false, message: errorMessage(res, text, data, t('settings:editUsername.failed')) };
    return { ok: true, message: t('settings:editUsername.updated'), user: data && data.user, token: data && data.token };
}

/** 修改通行密码（当前密码必填，新密码至少 6 位且两次一致）。 */
export async function savePassword({ backendUrl, token, currentPassword, newPassword, confirmPassword }) {
    if (!backendUrl || !token) return { ok: false, message: t('settings:editPassword.missingSession') };
    if (!String(currentPassword || '').trim()) return { ok: false, message: t('settings:editPassword.currentRequired') };
    if (!newPassword || newPassword.length < 6) return { ok: false, message: t('settings:editPassword.tooShort') };
    if (newPassword !== confirmPassword) return { ok: false, message: t('settings:editPassword.mismatch') };
    const res = await fetch(`${backendUrl}/users/me/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword })
    });
    const { text, data } = await readResponse(res);
    if (!res.ok) return { ok: false, message: errorMessage(res, text, data, t('settings:editPassword.failed')) };
    return {
        ok: true,
        message: data && data.other_sessions_revoked ? t('settings:editPassword.successOtherDevices') : t('settings:editPassword.success'),
        user: data && data.user,
        token: data && data.token
    };
}

/** 读取当前绑定的手机号（打码）。返回 { ok, phoneMasked }，未绑定时 phoneMasked 为 null。 */
export async function loadPhoneBinding({ backendUrl, token }) {
    if (!backendUrl || !token) return { ok: false, message: t('settings:editPhone.missingSession') };
    const res = await fetch(`${backendUrl}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
    const { text, data } = await readResponse(res);
    if (!res.ok) return { ok: false, message: errorMessage(res, text, data, t('settings:editPhone.loadFailed')) };
    return { ok: true, phoneMasked: (data && data.user && data.user.phone_masked) || null };
}

/**
 * 换绑手机号第一步：向新号码发短信验证码（不验证旧号码）。countryCode 是不带 + 的区号（默认 86）。
 * 返回 { ok, message, retryAfter, phone（规范形式 "+区号 号码"）, phoneMasked, resendAfter, expiresIn }。
 */
export async function requestPhoneCode({ backendUrl, token, phone, countryCode }) {
    if (!backendUrl || !token) return { ok: false, message: t('settings:editPhone.missingSession') };
    const normalized = normalizePhoneNumber(phone, countryCode);
    if (!normalized) return { ok: false, message: t('settings:editPhone.invalidPhone') };
    const res = await fetch(`${backendUrl}/users/me/phone/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ countryCode: normalizeCountryCode(countryCode), phone })
    });
    const { text, data } = await readResponse(res);
    if (!res.ok) {
        return { ok: false, message: errorMessage(res, text, data, t('settings:editPhone.sendFailed')), retryAfter: Number(data && data.retry_after) || 0 };
    }
    return {
        ok: true,
        phone: normalized,
        phoneMasked: (data && data.phone) || normalized,
        resendAfter: Number(data && data.resend_after) || 60,
        expiresIn: Number(data && data.expires_in) || 300
    };
}

/** 换绑手机号第二步：凭短信验证码绑定新号码。成功时返回打码后的新号码。 */
export async function savePhone({ backendUrl, token, phone, countryCode, code }) {
    if (!backendUrl || !token) return { ok: false, message: t('settings:editPhone.missingSession') };
    const normalized = normalizePhoneNumber(phone, countryCode);
    if (!normalized) return { ok: false, message: t('settings:editPhone.invalidPhone') };
    const trimmed = String(code || '').trim();
    if (!/^\d{6}$/.test(trimmed)) return { ok: false, message: t('settings:editPhone.invalidCode') };
    const res = await fetch(`${backendUrl}/users/me/phone`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ countryCode: normalizeCountryCode(countryCode), phone, code: trimmed })
    });
    const { text, data } = await readResponse(res);
    if (!res.ok) return { ok: false, message: errorMessage(res, text, data, t('settings:editPhone.failed')) };
    return { ok: true, message: t('settings:editPhone.updated'), phoneMasked: data && data.phone_masked };
}

/** 上传已裁剪好的头像图片（后端统一转成 200×200 WebP）。 */
export async function uploadAvatar({ backendUrl, token, blob }) {
    const formData = new FormData();
    formData.append('avatar', blob, 'avatar.jpg');
    const res = await fetch(`${backendUrl}/users/me/avatar`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
    });
    const { data } = await readResponse(res);
    if (!res.ok) return { ok: false, message: data && data.error ? data.error : t('settings:editAvatar.uploadFailedStatus', { status: res.status }) };
    if (!data || !data.success || !data.user) return { ok: false, message: t('settings:editAvatar.badData') };
    return { ok: true, message: t('settings:editAvatar.updated'), user: data.user };
}

/**
 * 合并保存 map_settings 的部分字段（暗黑模式、主题色、地图样式……）。
 * 先写本机副本（刷新后仍能恢复），已登录时再同步到账号；访客只存本机（local: true）。
 * @returns {Promise<{ ok: boolean, message: string, user?: object, settings: object, local?: boolean }>}
 */
export async function patchMapSettings({ user, backendUrl, token, patch, failedMessage = t('settings:customThemes.saveFailed') }) {
    const settings = { ...(storedMapSettings(user) || {}), ...patch };
    try { window.localStorage.setItem('map_settings', JSON.stringify(settings)); } catch (e) { /* 隐私模式等无法写入时忽略 */ }
    if (!backendUrl || !token) return { ok: true, local: true, settings, message: t('settings:customThemes.savedLocally') };
    const res = await fetch(`${backendUrl}/users/me/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ map_settings: settings })
    });
    const { text, data } = await readResponse(res);
    if (!res.ok) return { ok: false, settings, message: errorMessage(res, text, data, failedMessage) };
    return { ok: true, settings, user: (data && data.user) || undefined, message: t('settings:customThemes.saved') };
}
