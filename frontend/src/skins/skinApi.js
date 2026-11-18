// 皮肤接口（后端 modules/skins）。失败时抛出带后端报错文字的 Error。
import { t } from '../i18n/index.js';

async function request(backendUrl, token, path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${backendUrl}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const error = new Error((data && data.error) || t('settings:skins.requestFailed', { status: res.status }));
        error.status = res.status;
        error.reason = data && data.reason;
        throw error;
    }
    return data;
}

/** { active, owned: [{ id, name, unlocked_time }] } */
export function fetchSkinState(backendUrl, token, options) {
    return request(backendUrl, token, '/api/skins/me', options);
}

/** 兑换并立即换上；返回同上，另有 unlocked、already_owned */
export function redeemSkinCode(backendUrl, token, code) {
    return request(backendUrl, token, '/api/skins/redeem', { method: 'POST', body: { code } });
}

export function saveActiveSkin(backendUrl, token, skinId) {
    return request(backendUrl, token, '/api/skins/active', { method: 'PUT', body: { skin_id: skinId } });
}

export function redeemResourceCode(backendUrl, token, code) {
    return request(backendUrl, token, '/api/skins/redeem-resource', { method: 'POST', body: { code } });
}

export function fetchCompanionState(backendUrl, token, options) {
    return request(backendUrl, token, '/api/skins/companions/me', options);
}

export function saveActiveCompanion(backendUrl, token, id) {
    return request(backendUrl, token, '/api/skins/companions/active', { method: 'PUT', body: { companion_id: id } });
}

export async function fetchPackGrant(backendUrl, token, type, id, options) {
    const path = `/api/skins/packs/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
    const grant = await request(backendUrl, token, path, options);
    const base = new URL(`${backendUrl}${grant.base}`, window.location.href).href;
    const url = (file) => `${base}${file.split('/').map(encodeURIComponent).join('/')}`;
    return { ...grant, entryUrl: url(grant.entry), url };
}
