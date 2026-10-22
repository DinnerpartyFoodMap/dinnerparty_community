// 用户协议与隐私权政策是独立静态页面（frontend/terms/、frontend/privacy/），各处入口总是成对出现：
// 网页登录页与更多菜单（LegalLinks.jsx）、iOS 原生工具栏上拉面板底部小字、iOS 原生设置首页
import { isNativePlatform } from '../platform/env.js';
import { buildPublicUrl } from '../platform/runtimeConfig.js';
import { t } from '../i18n/index.js';

const LEGAL_PAGES = {
    terms: { path: '/terms/', symbol: 'doc.plaintext', label: () => t('auth:page.terms') },
    privacy: { path: '/privacy/', symbol: 'hand.raised', label: () => t('auth:page.privacyPolicy') }
};

export const LEGAL_PAGE_IDS = Object.freeze(['terms', 'privacy']);

/** 政策页地址：App 里本地 origin 没有这些页面，用公开网站地址 */
export function legalPageUrl(page) {
    const { path } = LEGAL_PAGES[page];
    return isNativePlatform() ? buildPublicUrl(path) : path;
}

export function legalPageTitle(page) {
    return LEGAL_PAGES[page].label();
}

/** iOS 原生行（上拉面板、原生设置）用的 SF Symbol */
export function legalPageSymbol(page) {
    return LEGAL_PAGES[page].symbol;
}
