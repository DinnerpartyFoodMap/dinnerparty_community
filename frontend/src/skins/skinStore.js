// 正在使用的皮肤（不依赖 React：标记层等非组件代码也从这里取图）。
// 账号与服务器同步由 useSkinSession 负责；这里只管“当前是哪一套”以及把它应用到页面。
import { DEFAULT_SKIN_ID, getSkin, resolveSkinSlots, subscribeSkinRegistry } from './registry.js';
import { applySkinToRoot } from './apply.js';
import { getPlatform } from '../platform/env.js';
import { isDarkMode } from '../theme/theme.js';

let requestedId = DEFAULT_SKIN_ID;
let activeId = DEFAULT_SKIN_ID;
let slots = {};
let revision = 0;
const listeners = new Set();

function recompute() {
    const skin = requestedId !== DEFAULT_SKIN_ID ? getSkin(requestedId) : null;
    activeId = skin ? skin.id : DEFAULT_SKIN_ID;
    slots = resolveSkinSlots(skin, { dark: isDarkMode() });
    revision += 1;
    if (typeof document !== 'undefined') {
        applySkinToRoot(document.documentElement, skin ? skin.id : null, slots, { platform: getPlatform() });
    }
    listeners.forEach((listener) => listener());
}

/** 换上一套皮肤；本次构建里没有这套素材时显示默认样式（素材到了再换上） */
export function activateSkin(id) {
    const next = id && id !== DEFAULT_SKIN_ID ? String(id) : DEFAULT_SKIN_ID;
    if (next === requestedId) return;
    requestedId = next;
    recompute();
}

/** 住民选择的皮肤（可能还没有素材） */
export function getRequestedSkinId() {
    return requestedId;
}

/** 实际显示的皮肤 */
export function getActiveSkinId() {
    return activeId;
}

/** 当前模式（浅色 / 深色）下某个槽位的值；没有时为 undefined */
export function skinSlot(key) {
    return slots[key];
}

export function skinRevision() {
    return revision;
}

export function subscribeSkin(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

subscribeSkinRegistry(() => {
    if (requestedId !== DEFAULT_SKIN_ID) recompute();
});

// 深色模式切换：有 dark 覆盖的皮肤需要重新取值
if (typeof window !== 'undefined') {
    let lastDark = isDarkMode();
    window.addEventListener('themechange', () => {
        const dark = isDarkMode();
        if (dark === lastDark) return;
        lastDark = dark;
        const skin = activeId !== DEFAULT_SKIN_ID ? getSkin(activeId) : null;
        if (skin && Object.keys(skin.darkValues).length) recompute();
    });
}
