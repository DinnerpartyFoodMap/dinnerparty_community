// 登录凭证存储。
// 网页：继续使用 localStorage 的 'token' 键（兼容已登录用户，可同步读取，跨标签页同步）。
// App：使用基于 iOS Keychain / Android Keystore 的安全存储（@aparajita/capacitor-secure-storage），
//      读取是异步的，因此启动时有“恢复中”状态，避免误弹登录框。

import { isNativePlatform } from './env.js';

const TOKEN_KEY = 'token';
// undefined 表示尚未从原生安全存储恢复
let nativeCache = undefined;

function readLocal() {
    try { return window.localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}

function writeLocal(token) {
    try {
        if (token) window.localStorage.setItem(TOKEN_KEY, token);
        else window.localStorage.removeItem(TOKEN_KEY);
        return true;
    } catch (e) {
        return false;
    }
}

// 注意：不能让 async 函数直接 resolve 插件代理对象——await 会调用代理上的 .then()，
// 在原生端被当作插件方法转发并抛出 "SecureStorage.then() is not implemented"。因此包一层普通对象。
async function secureStorage() {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    return {
        getItem: (key) => SecureStorage.getItem(key),
        setItem: (key, value) => SecureStorage.setItem(key, value),
        removeItem: (key) => SecureStorage.removeItem(key)
    };
}

/** 是否需要异步恢复（App 首次启动时为 true）。 */
export function needsRestore() {
    return isNativePlatform() && nativeCache === undefined;
}

/** 同步读取当前已知的 token；App 恢复完成前返回 null。 */
export function peekToken() {
    if (typeof window === 'undefined') return null;
    if (isNativePlatform()) return nativeCache || null;
    return readLocal();
}

/** 恢复登录凭证。网页直接读取；App 从安全存储读取，并迁移 WebView 存储中残留的旧 token。 */
export async function restoreToken() {
    if (!isNativePlatform()) return readLocal();
    if (nativeCache !== undefined) return nativeCache;
    try {
        const storage = await secureStorage();
        let token = await storage.getItem(TOKEN_KEY);
        const legacy = readLocal();
        if (!token && legacy) {
            await storage.setItem(TOKEN_KEY, legacy);
            token = legacy;
        }
        if (legacy) writeLocal(null);
        nativeCache = typeof token === 'string' && token ? token : null;
    } catch (error) {
        console.warn('读取安全存储失败，按未登录处理', error);
        nativeCache = null;
    }
    return nativeCache;
}

/** @returns {Promise<boolean>} 是否已持久保存 */
export async function saveToken(token) {
    if (!token) return clearToken();
    if (!isNativePlatform()) {
        return writeLocal(token);
    }
    nativeCache = token;
    try {
        const storage = await secureStorage();
        await storage.setItem(TOKEN_KEY, token);
        return true;
    } catch (error) {
        console.warn('保存登录凭证到安全存储失败', error);
        return false;
    }
}

export async function clearToken() {
    if (!isNativePlatform()) {
        writeLocal(null);
        return true;
    }
    nativeCache = null;
    try {
        const storage = await secureStorage();
        await storage.removeItem(TOKEN_KEY);
        return true;
    } catch (error) {
        console.warn('清除安全存储中的登录凭证失败', error);
        return false;
    }
}

/**
 * 订阅其他标签页中的登录/退出（仅网页端；App 只有一个 WebView）。
 * @returns {() => void}
 */
export function subscribeExternalTokenChanges(listener) {
    if (isNativePlatform() || typeof window === 'undefined') return () => { };
    const onStorage = (event) => {
        if (event && event.key === TOKEN_KEY) listener(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
}

/** 读取 JWT 载荷（不校验签名，仅用于按账号隔离本地数据、判断是否为旧版 token）。 */
export function decodeTokenPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        return null;
    }
}

export function getTokenUserId(token) {
    const payload = decodeTokenPayload(token);
    return payload && payload.id ? String(payload.id) : null;
}
