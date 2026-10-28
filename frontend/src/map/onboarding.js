// 第一次打开地图的操作指引：步骤表、“已看过”记录与卡片位置计算（纯逻辑，纳入 test:map）。
// 界面在 MapOnboarding.jsx；目标按钮用 data-tour 标记，取值即步骤 id；
// iOS 原生工具栏的按钮由原生画高亮圈并回传位置（步骤的 native 字段）。
import { t } from '../i18n/index.js';

// 指引内容有大的变化（例如新增主要按钮）时加一，看过旧版的人会再看到一次。
// 2：iOS 原生工具栏的指引改为指出真实按钮、演示并练习上滑展开更多功能
// 3：新增地图筛选与列表 / 地图切换按钮；iOS 原生工具栏的随机美食与日记互换位置
// （之后精简步骤、恢复 iOS 的更多功能练习：看过旧版的人已经认识这些按钮，不再加一）
export const ONBOARDING_VERSION = 3;
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
 * 指引只讲最常用的一条路：找店（搜索 / 定位）→ 打开店卡 → 导航 / 收藏。
 * iOS 在收藏前补充打开更多功能：原生端练习上滑，网页回退端指出“更多”按钮。
 * 筛选、列表、顺路吃等其他功能不在这里挨个介绍，第一次用到时提示一句（featureIntro.js）。
 * target 是 data-tour 的取值（各布局都有搜索与收藏按钮）；“打开店卡”没有目标，居中显示。
 * iOS 原生玻璃工具栏（variant 'native'）网页指不到原生按钮：步骤带 native（{ target, drawer }，见 nativeMapChrome.js 的 sanitizeTour），
 * 由原生画高亮圈并回传位置；where 是写给用户看的位置，只有原生布局需要（网页的高亮框已经指明了位置）。
 */
const NATIVE_TOUR = {
    search: { target: 'search', drawer: false },
    card: { target: null, drawer: false },
    more: { target: 'drawer', drawer: false },
    favorites: { target: 'favorites', drawer: false }
};

export function buildOnboardingSteps({ variant = 'desktop' } = {}) {
    const native = variant === 'native';
    const ios = native || variant === 'ios';
    const nativeWhere = {
        search: t('map:onboarding.where.native.search'),
        more: t('map:onboarding.where.native.more'),
        favorites: t('map:onboarding.where.native.favorites')
    };
    const step = (id, icon, title, body, target) => {
        const item = { id, icon, title, body, target: native ? null : target };
        if (native) {
            item.native = NATIVE_TOUR[id];
            if (nativeWhere[id]) item.where = { icon: id === 'more' ? 'swipe_up' : 'location_on', text: nativeWhere[id] };
            if (id === 'more') {
                item.practice = 'drawer';
                item.hint = t('map:onboarding.more.practice');
            }
        }
        return item;
    };
    return [
        step('search', 'search', t('map:onboarding.search.title'), t('map:onboarding.search.body'), 'search'),
        step('card', 'storefront', t('map:onboarding.card.title'), t('map:onboarding.card.body'), null),
        // 上滑成功后复用 MapOnboarding 的自动换步，保留收藏作为下一步。
        ...(ios ? [step('more', native ? 'swipe_up' : 'more_horiz', t('map:onboarding.more.title'), native ? t('map:onboarding.more.bodyNative') : t('map:onboarding.more.bodyIos'), 'more')] : []),
        step('favorites', 'directions', t('map:onboarding.favorites.title'), t('map:onboarding.favorites.body'), 'favorites')
    ];
}

/** 原生回传的指引位置是否属于这一步（换步后、原生回传新位置前，旧位置不能用）。 */
export function nativeTourRect(step, nativeTour) {
    if (!step?.native || !nativeTour || nativeTour.step !== step.id) return null;
    return nativeTour.rect || null;
}

/** 两个矩形（left/top/width/height）的外框；任一为空时返回另一个。 */
export function unionBox(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
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
