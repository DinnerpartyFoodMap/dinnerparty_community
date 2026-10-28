// 界面文案入口：用户可见的文字都放在 locales/<语言>/<命名空间>.json，代码里用 t('命名空间:键') 读取。
// 语言在启动时确定一次；切换语言写入偏好后整页重新加载，所以模块顶层常量里的文案也可以直接调用 t()。
import React from 'react';
import i18next from 'i18next';
import common from './locales/zh-CN/common.json';
import auth from './locales/zh-CN/auth.json';
import map from './locales/zh-CN/map.json';
import journey from './locales/zh-CN/journey.json';
import dinner from './locales/zh-CN/dinner.json';
import poster from './locales/zh-CN/poster.json';
import settings from './locales/zh-CN/settings.json';
import admin from './locales/zh-CN/admin.json';
import platform from './locales/zh-CN/platform.json';
import feedback from './locales/zh-CN/feedback.json';
import places from './locales/zh-CN/places.json';
import profile from './locales/zh-CN/profile.json';
import home from './locales/zh-CN/home.json';

export const DEFAULT_LANGUAGE = 'zh-CN';

const RESOURCES = {
    'zh-CN': { common, auth, map, journey, dinner, poster, settings, admin, platform, feedback, places, profile, home }
};

export const SUPPORTED_LANGUAGES = Object.keys(RESOURCES);

const LANGUAGE_STORAGE_KEY = 'foodmap.language';

// 先精确匹配，再按主语言匹配（例如 zh-TW 落到 zh-CN）；都不支持时用默认语言
export function matchLanguage(candidates) {
    for (const raw of candidates) {
        if (!raw) continue;
        const wanted = String(raw).toLowerCase();
        const exact = SUPPORTED_LANGUAGES.find((lng) => lng.toLowerCase() === wanted);
        if (exact) return exact;
        const base = wanted.split('-')[0];
        const sameBase = SUPPORTED_LANGUAGES.find((lng) => lng.split('-')[0].toLowerCase() === base);
        if (sameBase) return sameBase;
    }
    return DEFAULT_LANGUAGE;
}

function readStoredLanguage() {
    try {
        return globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

function detectLanguage() {
    const nav = typeof navigator === 'undefined' ? null : navigator;
    return matchLanguage([readStoredLanguage(), ...(nav?.languages || [nav?.language])]);
}

const i18n = i18next.createInstance();
// 资源随包内联，init 同步完成：其他模块 import 本文件后即可在顶层调用 t()
i18n.init({
    resources: RESOURCES,
    lng: detectLanguage(),
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    load: 'currentOnly',
    ns: Object.keys(RESOURCES[DEFAULT_LANGUAGE]),
    defaultNS: 'common',
    // React 渲染时会转义；插值结果原先就是直接拼接的字符串
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false
});

if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = i18n.language;
    document.title = i18n.t('common:app.name');
}

export const t = i18n.t;

export function getLanguage() {
    return i18n.language;
}

// 记住所选语言并整页重新加载
export function setLanguage(lng) {
    const next = matchLanguage([lng]);
    try {
        globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
        // 无痕模式等无法写入时，仅本次生效
    }
    if (next !== i18n.language && typeof window !== 'undefined') window.location.reload();
}

// 文案中间夹着 React 元素时使用：参数都是文字或数字时等同于 t()；含元素时返回片段。
// null、undefined 与布尔值和 JSX 一样不显示。
export function tx(key, values = {}) {
    const entries = Object.entries(values);
    if (!entries.some(([, value]) => value !== null && typeof value === 'object')) {
        const plain = {};
        for (const [name, value] of entries) plain[name] = value == null || typeof value === 'boolean' ? '' : value;
        return i18n.t(key, plain);
    }
    const marks = {};
    entries.forEach(([name], index) => { marks[name] = `\u0000${index}\u0000`; });
    const parts = i18n.t(key, marks).split('\u0000');
    return React.createElement(React.Fragment, null, ...parts.map((part, index) => (index % 2 ? entries[Number(part)][1] : part)));
}

export default i18n;
