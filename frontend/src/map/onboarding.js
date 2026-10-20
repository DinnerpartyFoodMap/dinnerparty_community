// 第一次打开地图的操作指引：步骤表、“已看过”记录与卡片位置计算（纯逻辑，纳入 test:map）。
// 界面在 MapOnboarding.jsx；目标按钮用 data-tour 标记，取值即步骤 id。
import { t } from '../i18n/index.js';

// 指引内容有大的变化（例如新增主要按钮）时加一，看过旧版的人会再看到一次
export const ONBOARDING_VERSION = 1;
export const ONBOARDING_KEY = 'foodmap.onboarding';
let seenThisSession = false;

export function parseOnboardingSeen(raw) {
    try {
        const record = JSON.parse(raw);
        return !!record && record.version === ONBOARDING_VERSION;
    } catch {
        return false;
    }
}

export function readOnboardingSeen() {
    if (seenThisSession) return true;
    try {
        return parseOnboardingSeen(window.localStorage.getItem(ONBOARDING_KEY));
    } catch {
        return false;
    }
}

/** 看完或跳过都算看过；存储不可用时只在本次打开内不再弹出。 */
export function rememberOnboardingSeen() {
    seenThisSession = true;
    try {
        window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ version: ONBOARDING_VERSION, at: new Date().toISOString() }));
    } catch { /* 隐私模式等 */ }
}

/**
 * 各布局下的按钮不同：
 * - desktop：顶栏（入乡/住民、更多）、居中搜索框、右侧圆钮列、左下角日记入口；
 * - mobile：网页与安卓 App 的底部工具栏（更多、收藏、添加、顺路吃、入乡）与搜索框；
 * - ios：iOS App 的网页工具栏（顺路吃在“更多”里，搜索是工具栏按钮，头像在右上角）；
 * - native：iOS 原生玻璃控件，网页指不到原生按钮，只显示说明卡片（指引打开时原生控件按浮层规则收起）。
 * 各布局步骤顺序相同；返回的 target 是 data-tour 的取值，欢迎页和没有网页按钮可指的步骤（收在“更多”里或原生控件）为 null，居中显示。
 */
const NO_WEB_BUTTON = {
    desktop: [],
    mobile: ['journey'],
    ios: ['alongRoute', 'journey']
};

export function buildOnboardingSteps({ variant = 'desktop', isAuthenticated = false } = {}) {
    const hidden = NO_WEB_BUTTON[variant];
    const step = (id, icon, title, body) => ({ id, icon, title, body, target: !hidden || id === 'welcome' || hidden.includes(id) ? null : id });
    const moreBody = {
        desktop: t('map:onboarding.more.bodyDesktop'),
        mobile: t('map:onboarding.more.bodyMobile'),
        ios: t('map:onboarding.more.bodyIos'),
        native: t('map:onboarding.more.bodyNative')
    }[variant] || t('map:onboarding.more.bodyDesktop');
    return [
        step('welcome', 'waving_hand', t('map:onboarding.welcome.title'), t('map:onboarding.welcome.body')),
        isAuthenticated
            ? step('account', 'person', t('map:onboarding.account.title'), t('map:onboarding.account.body'))
            : step('account', 'login', t('map:onboarding.account.loginTitle'), t('map:onboarding.account.loginBody')),
        step('search', 'search', t('map:onboarding.search.title'), t('map:onboarding.search.body')),
        step('locate', 'my_location', t('map:onboarding.locate.title'), t('map:onboarding.locate.body')),
        step('favorites', 'favorite', t('map:onboarding.favorites.title'), t('map:onboarding.favorites.body')),
        step('add', 'add_location_alt', t('map:onboarding.add.title'), t('map:onboarding.add.body')),
        step('alongRoute', 'route', t('map:onboarding.alongRoute.title'), t('map:onboarding.alongRoute.body')),
        step('more', 'more_horiz', t('map:onboarding.more.title'), moreBody),
        step('journey', 'auto_stories', t('map:onboarding.journey.title'), t('map:onboarding.journey.body'))
    ];
}

/** 页面里第一个看得见的 data-tour 目标（同一按钮可能有桌面与窄屏两份，只有一份显示）。 */
export function findOnboardingTarget(id, root = typeof document !== 'undefined' ? document : null) {
    if (!id || !root) return null;
    for (const el of root.querySelectorAll(`[data-tour="${id}"]`)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
    }
    return null;
}

/**
 * 高亮框：目标矩形（视口坐标）换算到指引层坐标，四周留 pad，限制在层内。
 * 近似正方形的按钮画成圆，其余画圆角矩形。
 */
export function spotlightFor(rect, bounds, pad = 6) {
    const left = Math.max(2, rect.left - bounds.left - pad);
    const top = Math.max(2, rect.top - bounds.top - pad);
    const right = Math.min(bounds.width - 2, rect.right - bounds.left + pad);
    const bottom = Math.min(bounds.height - 2, rect.bottom - bounds.top + pad);
    const width = Math.max(0, Math.round(right - left));
    const height = Math.max(0, Math.round(bottom - top));
    const round = Math.abs(width - height) <= 8;
    return { left: Math.round(left), top: Math.round(top), width, height, radius: round ? Math.round(Math.max(width, height) / 2) : 16 };
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * 说明卡片的位置（指引层坐标）。没有目标时居中；有目标时优先放在目标下方或上方（选空间够的一侧），
 * 宽屏上贴边的小按钮（右侧圆钮列、左下角入口）优先放在旁边，不挡住同一列的其他按钮。
 * 哪里都放不下时放在空间较大的一侧，允许与目标重叠。
 */
export function placeOnboardingCard({ hole, bounds, card, margin = 12, gap = 12 }) {
    const { width: W, height: H } = bounds;
    const { width: cw, height: ch } = card;
    if (!hole) {
        return { side: 'center', left: Math.round(clamp((W - cw) / 2, margin, W - cw - margin)), top: Math.round(clamp((H - ch) / 2, margin, H - ch - margin)) };
    }
    const holeRight = hole.left + hole.width;
    const holeBottom = hole.top + hole.height;
    const centerX = hole.left + hole.width / 2;
    const centerY = hole.top + hole.height / 2;
    const spaceBelow = H - holeBottom - gap - margin;
    const spaceAbove = hole.top - gap - margin;
    const spaceLeft = hole.left - gap - margin;
    const spaceRight = W - holeRight - gap - margin;
    const horizontal = () => Math.round(clamp(centerX - cw / 2, margin, W - cw - margin));
    const vertical = () => Math.round(clamp(centerY - ch / 2, margin, H - ch - margin));

    const below = ch <= spaceBelow && { side: 'below', left: horizontal(), top: Math.round(holeBottom + gap) };
    const above = ch <= spaceAbove && { side: 'above', left: horizontal(), top: Math.round(hole.top - gap - ch) };
    const besideLeft = cw <= spaceLeft && { side: 'left', left: Math.round(hole.left - gap - cw), top: vertical() };
    const besideRight = cw <= spaceRight && { side: 'right', left: Math.round(holeRight + gap), top: vertical() };
    const nearEdge = hole.left < 120 || W - holeRight < 120;
    const smallTarget = hole.width <= 120 && hole.height <= 120;
    const side = spaceLeft >= spaceRight ? besideLeft : besideRight;
    const order = W >= 640 && nearEdge && smallTarget
        ? [side, below, above]
        : (spaceBelow >= spaceAbove ? [below, above, side] : [above, below, side]);
    const chosen = order.find(Boolean);
    if (chosen) return chosen;
    return spaceBelow >= spaceAbove
        ? { side: 'below', left: horizontal(), top: Math.round(clamp(holeBottom + gap, margin, H - ch - margin)) }
        : { side: 'above', left: horizontal(), top: Math.round(clamp(hole.top - gap - ch, margin, H - ch - margin)) };
}
