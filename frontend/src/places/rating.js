// 地点评价：四档（与后端 services/placeRatings.js 一致）。分数只用于平均，界面上始终用评价词表达。
import { t } from '../i18n/index.js';

// 从高到低。tone 对应颜色变量；hint 让大家对同一档的理解一致（参考鸭觅“值得专程去 / 顺路去”的写法）
// 语言在启动时确定，模块顶层调用 t() 是安全的（见 i18n/index.js）
export const RATING_TIERS = Object.freeze([
    { score: 4, key: 'strongYes', label: t('map:rating.tier.strongYes'), hint: t('map:rating.hint.strongYes'), tone: 'var(--color-success)', icon: 'sentiment_very_satisfied', symbol: 'hand.thumbsup.fill' },
    { score: 3, key: 'aboveAverage', label: t('map:rating.tier.aboveAverage'), hint: t('map:rating.hint.aboveAverage'), tone: 'var(--theme-primary)', icon: 'sentiment_satisfied', symbol: 'hand.thumbsup' },
    { score: 2, key: 'belowAverage', label: t('map:rating.tier.belowAverage'), hint: t('map:rating.hint.belowAverage'), tone: 'var(--color-warning)', icon: 'sentiment_dissatisfied', symbol: 'hand.thumbsdown' },
    { score: 1, key: 'strongNo', label: t('map:rating.tier.strongNo'), hint: t('map:rating.hint.strongNo'), tone: 'var(--color-danger)', icon: 'sentiment_very_dissatisfied', symbol: 'hand.thumbsdown.fill' }
].map(Object.freeze));

// 评价人数少于这个数时注明“评价较少”（大众点评要攒够 10 条精选评价才显示星级；这里社区小，用 3）
export const FEW_RATINGS = 3;
// 综合评价落在“均线之下 / 强烈拒绝”时按避雷显示；没人评价时沿用“避雷”标签
export const AVOID_BELOW_AVERAGE = 2.5;
export const AVOID_TAG = '避雷';

export function ratingTierFor(score) {
    return RATING_TIERS.find((tier) => tier.score === score) || null;
}

/** 平均分 → 最接近的一档（正好一半时取较好的一档）；没有评价时为 null */
export function tierForAverage(average) {
    if (average === null || average === undefined || average === '') return null;
    const value = Number(average);
    if (!Number.isFinite(value)) return null;
    return ratingTierFor(Math.max(1, Math.min(4, Math.floor(value + 0.5))));
}

export function tierLabel(tier) {
    return tier ? tier.label : '';
}

export function tierHint(tier) {
    return tier ? tier.hint : '';
}

export function formatAverage(average) {
    const value = Number(average);
    return Number.isFinite(value) ? value.toFixed(1) : '';
}

export function hasAvoidTag(category) {
    return String(category || '').includes(AVOID_TAG);
}

/** 地图上的避雷图标、红色店名：有评价看综合评价，没人评价看“避雷”标签 */
export function isAvoidedPlace(place) {
    if (!place) return false;
    const count = Number(place.rating_count) || 0;
    if (count > 0) return Number(place.rating_average) < AVOID_BELOW_AVERAGE;
    return hasAvoidTag(place.category);
}

/** 添加地点时预选的评价：带“避雷”标签预选强烈拒绝，否则强烈推荐 */
export function defaultCreationScore(category) {
    return hasAvoidTag(category) ? 1 : 4;
}

/** 卡片上的一行摘要：“均线之上 3.2 · 12 人评价”，没人评价时“暂无评价” */
export function summaryText(summary) {
    const count = Number(summary && summary.count) || 0;
    if (!count) return t('map:rating.summary.none');
    const tier = tierForAverage(summary.average);
    return t('map:rating.summary.text', { tier: tierLabel(tier), average: formatAverage(summary.average), count });
}

/** 由地点上的聚合字段（附近/搜索接口返回的 rating_count、rating_average）组成摘要 */
export function summaryFromPlace(place) {
    const count = Number(place && place.rating_count) || 0;
    return { count, average: count ? Number(place.rating_average) : null };
}
