// 功能第一次用到时的一句介绍：操作指引只讲找店、店卡与导航 / 收藏（onboarding.js），
// 筛选、列表、顺路吃等不在指引里挨个介绍，第一次打开时用提示条说一句。
// 每个功能只提示一次，记在 localStorage `foodmap.featureIntro`（不可用时只在本次打开内不重复）。
import { t } from '../i18n/index.js';

export const FEATURE_INTRO_KEY = 'foodmap.featureIntro';
// 语言在启动时确定，模块顶层调用 t() 是安全的（见 i18n/index.js）
const INTROS = {
    filter: t('map:featureIntro.filter'),
    listView: t('map:featureIntro.listView'),
    alongRoute: t('map:featureIntro.alongRoute')
};
const seenThisSession = new Set();

function readSeen(storage) {
    try {
        const list = JSON.parse(storage.getItem(FEATURE_INTRO_KEY));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** 这个功能第一次用到时返回介绍文字并记为已看过；看过的、没有介绍的返回 null。 */
export function takeFeatureIntro(id, storage) {
    const text = INTROS[id];
    if (!text || seenThisSession.has(id)) return null;
    seenThisSession.add(id);
    if (storage === undefined) {
        try { storage = globalThis.localStorage; } catch { storage = null; }
    }
    if (!storage) return text;
    const seen = readSeen(storage);
    if (seen.includes(id)) return null;
    try {
        storage.setItem(FEATURE_INTRO_KEY, JSON.stringify([...seen, id]));
    } catch { /* 隐私模式等 */ }
    return text;
}
