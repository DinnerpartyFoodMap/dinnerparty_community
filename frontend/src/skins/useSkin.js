import { useSyncExternalStore } from 'react';
import { getActiveSkinId, getRequestedSkinId, skinRevision, skinSlot, subscribeSkin } from './skinStore.js';

export function useSkinRevision() {
    return useSyncExternalStore(subscribeSkin, skinRevision, skinRevision);
}

/** 某个槽位在当前模式下的值，皮肤切换时组件随之刷新 */
export function useSkinSlot(key) {
    useSkinRevision();
    return skinSlot(key);
}

export function useActiveSkin() {
    useSkinRevision();
    return { active: getActiveSkinId(), requested: getRequestedSkinId() };
}
