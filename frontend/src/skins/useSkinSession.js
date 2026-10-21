import { useEffect } from 'react';
import { DEFAULT_SKIN_ID } from './registry.js';
import { activateSkin } from './skinStore.js';
import { fetchSkinState } from './skinApi.js';

// 本机记住“哪位住民用哪套皮肤”：冷启动时先按通行凭证里的住民换上，不等接口返回；换账号不会沿用上一位的皮肤
const CACHE_KEY = 'foodmap.skin';

function readCache() {
    try {
        const value = JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null');
        return value && typeof value.userId === 'string' && typeof value.skinId === 'string' ? value : null;
    } catch (e) {
        return null;
    }
}

export function rememberSkin(userId, skinId) {
    try {
        if (userId && skinId && skinId !== DEFAULT_SKIN_ID) window.localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, skinId }));
        else window.localStorage.removeItem(CACHE_KEY);
    } catch (e) { /* 隐私模式等无法写入时忽略 */ }
}

/**
 * 同步当前住民的皮肤：userId 变化时先用本机缓存，再以服务器为准；退出登录回到默认样式。
 * @param {{ backendUrl: string, token: string|null, userId: string|null, pendingUserId?: string|null }} options
 *   pendingUserId：已有通行凭证、住民信息还在加载时凭证里的住民（用于冷启动先显示缓存的皮肤）
 */
export default function useSkinSession({ backendUrl, token, userId, pendingUserId = null }) {
    useEffect(() => {
        const id = userId || pendingUserId;
        const cached = readCache();
        if (!id) {
            activateSkin(DEFAULT_SKIN_ID);
            return undefined;
        }
        activateSkin(cached && cached.userId === id ? cached.skinId : DEFAULT_SKIN_ID);
        if (!userId || !token || !backendUrl) return undefined;
        const controller = new AbortController();
        fetchSkinState(backendUrl, token, { signal: controller.signal }).then((state) => {
            if (controller.signal.aborted || !state) return;
            activateSkin(state.active);
            rememberSkin(userId, state.active);
        }).catch(() => { /* 离线时保持缓存的皮肤 */ });
        return () => controller.abort();
    }, [backendUrl, token, userId, pendingUserId]);
}
