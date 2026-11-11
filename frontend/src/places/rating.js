// 地点评价：四档（与后端 services/placeRatings.js 一致）。分数只用于平均，界面上始终用评价词表达。
import { t } from '../i18n/index.js';
import { sfSymbol, materialIcon } from '../platform/iconRegistry.js';

// 从高到低。tone 对应颜色变量；hint 让大家对同一档的理解一致（参考鸭觅“值得专程去 / 顺路去”的写法）
// 图标两端同一含义：赞 / 踩，强烈的一档用实心（网页 icon + fill 对应 Material Symbols 的 FILL，原生 symbol 是 SF Symbols）
// 语言在启动时确定，模块顶层调用 t() 是安全的（见 i18n/index.js）
export const RATING_TIERS = Object.freeze([
    { score: 4, key: 'strongYes', label: t('map:rating.tier.strongYes'), hint: t('map:rating.hint.strongYes'), tone: 'var(--color-success)', icon: materialIcon('thumbUpFill'), fill: true, symbol: sfSymbol('thumbUpFill') },
    { score: 3, key: 'aboveAverage', label: t('map:rating.tier.aboveAverage'), hint: t('map:rating.hint.aboveAverage'), tone: 'var(--theme-primary)', icon: materialIcon('thumbUp'), fill: false, symbol: sfSymbol('thumbUp') },
    { score: 2, key: 'belowAverage', label: t('map:rating.tier.belowAverage'), hint: t('map:rating.hint.belowAverage'), tone: 'var(--color-warning)', icon: materialIcon('thumbDown'), fill: false, symbol: sfSymbol('thumbDown') },
    { score: 1, key: 'strongNo', label: t('map:rating.tier.strongNo'), hint: t('map:rating.hint.strongNo'), tone: 'var(--color-danger)', icon: materialIcon('thumbDownFill'), fill: true, symbol: sfSymbol('thumbDownFill') }
].map(Object.freeze));

// 评价人数少于这个数时注明“评价较少”（大众点评要攒够 10 条精选评价才显示星级；这里社区小，用 3）
export const FEW_RATINGS = 3;
// 综合评价落在“均线之下 / 强烈拒绝”时按避雷显示；没人评价时沿用“避雷”标签
export const AVOID_BELOW_AVERAGE = 2.5;
export const AVOID_TAG = '避雷';
// “待探索”：还没去过、先标记的地点。创建时不需要评价；没人评价前地图上显示问号图标（与后端 ratingBusiness.js 一致）
export const EXPLORE_TAG = '待探索';

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
    return (Array.isArray(category)?category:[category]).some(value=>String(value||'').split(/[,，/、|]/).some(tag=>tag.trim()===AVOID_TAG));
}

function categoryTags(category) {
    return (Array.isArray(category) ? category : [category]).flatMap((value) => String(value || '').split(/[,，/、|]/)).map((tag) => tag.trim()).filter(Boolean);
}

export function hasExploreTag(category) {
    return categoryTags(category).includes(EXPLORE_TAG);
}

/** 待探索：带“待探索”标签且还没有人评价（有人评价后按普通地点显示） */
export function isUnexploredPlace(place) {
    if (!place || place.isMarked === false) return false;
    return hasExploreTag(place.category) && !(Number(place.rating_count) > 0);
}

/** 在逗号分隔的标签串里加上 / 去掉一个标签（保持其他标签的顺序） */
export function toggleCategoryTag(category, tag, on) {
    const tags = categoryTags(category).filter((item) => item !== tag);
    if (on) tags.push(tag);
    return tags.join(', ');
}

/** 社区“避雷”标签始终保留警示；其他地点按已有评价判断。 */
export function isAvoidedPlace(place) {
    if (!place) return false;
    if (hasAvoidTag(place.category)) return true;
    const count = Number(place.rating_count) || 0;
    if (count > 0) return Number(place.rating_average) < AVOID_BELOW_AVERAGE || Number(place.rating_negative_count)>count/2;
    return hasAvoidTag(place.category);
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

// Preloaded personal scores are scoped to the authenticated response owner.
// Switching accounts must never briefly render the previous account's score.
export function ratingPlaceForViewer(place,viewerId) {
    if(!place)return null;
    if(viewerId!=null&&place.rating_viewer_id!=null&&String(viewerId)===String(place.rating_viewer_id))return place;
    return {...place,predicted_rating:null,personalized_average:null,rating_mine:null};
}

// Display selection never mutates the legacy aggregates used by avoidance rules.
export function ratingDisplay(data, place) {
    const estimate = data ? data.estimate : place?.rating_estimate;
    const prediction = data ? data.prediction : place?.predicted_rating;
    const own = data ? data.mine : place?.rating_mine;
    const mine = ratingTierFor(own?.score) ? own : null;
    const valid = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 4;
    const legacy = data?.summary || summaryFromPlace(place);
    const summary = estimate?.active === true && Number(estimate.evidence_count) > 0 && valid(estimate.average)
        ? { count: Number(estimate.evidence_count) || 0, average: valid(estimate.average) ? Number(estimate.average) : null, distribution: estimate.distribution }
        : legacy;
    const oldPersonal = data?.personalized || (valid(place?.personalized_average) ? { average: Number(place.personalized_average) } : null);
    const personal = mine ? null : prediction?.active === true
        ? (prediction.status === 'ready' && valid(prediction.average) ? { ...prediction, kind: 'prediction' } : null)
        : (oldPersonal ? { ...oldPersonal, kind: 'legacy' } : null);
    const candidateRisk = data ? (data.risk || estimate?.risk) : (place?.rating_risk || estimate?.risk);
    const riskActive = candidateRisk?.active === true || (estimate?.active === true && candidateRisk?.active !== false);
    const risk = riskActive && candidateRisk?.status === 'ready' && candidateRisk.flagged === true ? candidateRisk : null;
    return { summary, personal, risk, mine };
}
