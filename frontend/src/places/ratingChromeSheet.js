// iOS 原生评价面板（协议 v19 的 rating，从右侧按钮组展开的玻璃外壳，同筛选、收藏）：与网页 PlaceRatingPanel 同样的内容，
// 只下发展示字段，点按回传行 id（rate:<分数> / login / withdraw / retry），由 MapUI 用 ratingActions 执行。纯函数，test:rating 覆盖。
import { t } from '../i18n/index.js';
import { sfSymbol } from '../platform/iconRegistry.js';
import { RATING_TIERS, FEW_RATINGS, tierForAverage, tierLabel, tierHint, formatAverage, ratingDisplay } from './rating.js';

// 四档在原生面板上的语气：与 rating.js 的颜色一一对应（设计参考 1.4：成功色、主题色、警告色、危险色）
const TIER_TONES = Object.freeze({ strongYes: 'success', aboveAverage: 'accent', belowAverage: 'warning', strongNo: 'danger' });

export function ratingTierTone(tier) {
    return tier ? TIER_TONES[tier.key] : undefined;
}

/** 原生面板回传的行 id → 操作；未知 id 返回 null */
export function ratingSheetAction(rowId) {
    const match = /^rate:([1-4])$/.exec(String(rowId || ''));
    if (match) return { type: 'rate', score: Number(match[1]) };
    return ['login', 'withdraw', 'retry'].includes(rowId) ? { type: rowId } : null;
}

/**
 * @param {{ place: object, rating: { data, loading, error, saving }, isAuthenticated: boolean, banned: boolean,
 *           notice?: string|null, iconFor?: (slot: string) => object }} options
 * notice：上一次操作失败的说明（显示在面板提示里）；iconFor：评价表情的皮肤图标（MapUI 的 nativeIcon）
 */
export function ratingChromeSheet({ place, rating, isAuthenticated, banned, notice = null, iconFor = () => ({}) }) {
    const data = rating?.data || null;
    const { summary, personal, risk, mine } = ratingDisplay(data, place);
    const tier = tierForAverage(summary.average);
    const quota = data && data.quota;
    const exhausted = !!(quota && quota.remaining <= 0 && !quota.place_counted);
    const saving = !!rating?.saving;
    const loading = !data && !!rating?.loading;
    const loadFailed = !data && !loading && !!rating?.error;
    const rated = summary.count > 0 && !!tier;
    const counts = RATING_TIERS.map((item) => Number(summary.distribution?.[item.score]) || 0);
    const maxCount = Math.max(1, ...counts);

    const status = !isAuthenticated ? null
        : banned ? t('map:rating.panel.banned')
        : quota ? (exhausted ? t('map:rating.panel.quotaExhausted', { limit: quota.limit })
            : quota.place_counted ? t('map:rating.panel.quotaCounted')
            : t('map:rating.panel.quota', { remaining: quota.remaining }))
        : null;

    const personalTier = personal ? tierForAverage(personal.average) : null;
    const personalSection = personal && personalTier ? {
        id: 'personal',
        style: 'note',
        title: personal.kind === 'prediction' ? t('map:rating.panel.predictionTitle') : t('map:rating.panel.personalizedTitle'),
        footer: personal.kind === 'legacy' && personal.matched_raters != null
            ? t('map:rating.panel.personalizedHint', { matched: personal.matched_raters }) : undefined,
        rows: [{
            id: 'personal',
            title: tierLabel(personalTier),
            subtitle: formatAverage(personal.average),
            // “预计你会给”的数字加粗放大（与网页 RatingPredictionValue 一致）
            subtitleEmphasis: personal.kind === 'prediction' ? formatAverage(personal.average) : undefined,
            tone: ratingTierTone(personalTier)
        }]
    } : (data && !personal && !mine && isAuthenticated && summary.count > 1 ? {
        id: 'personal',
        footer: data.prediction?.active === true ? t('map:rating.panel.predictionUnavailable') : t('map:rating.panel.personalizedUnavailable'),
        rows: []
    } : null);

    return {
        id: 'rating',
        size: 'fit',
        title: t('map:rating.panel.title'),
        subtitle: place?.name || t('common:label.unnamedPlace'),
        message: notice || (loading ? t('map:rating.panel.loading')
            : loadFailed ? t('map:rating.panel.loadFailed', { message: rating.error }) : undefined),
        messageTone: notice || loadFailed ? 'danger' : loading ? 'loading' : undefined,
        sections: [
            {
                id: 'summary',
                style: 'stat',
                footer: rated ? [t('map:rating.panel.count', { count: summary.count }), summary.count < FEW_RATINGS ? t('map:rating.summary.few') : null]
                    .filter(Boolean).join(' · ') : undefined,
                rows: [rated ? {
                    id: 'summary',
                    title: tierLabel(tier),
                    subtitle: formatAverage(summary.average),
                    symbol: tier.symbol,
                    ...iconFor(`rating.${tier.key}`),
                    tone: ratingTierTone(tier)
                } : { id: 'summary', title: t('map:rating.panel.empty') }]
            },
            risk && { id: 'risk', style: 'note', rows: [{ id: 'risk', title: t('map:rating.riskHint'), symbol: sfSymbol('riskWarning'), tone: 'warning' }] },
            rated && summary.distribution && {
                id: 'distribution',
                style: 'bars',
                title: t('map:rating.panel.distribution'),
                rows: RATING_TIERS.map((item, index) => ({
                    id: `bar:${item.score}`,
                    title: tierLabel(item),
                    // 读屏读这一句（“强烈推荐 7 人”）
                    subtitle: t('map:rating.panel.distributionRow', { tier: tierLabel(item), count: counts[index] }),
                    badge: String(counts[index]),
                    value: counts[index] / maxCount,
                    tone: ratingTierTone(item)
                }))
            },
            personalSection,
            {
                id: 'mine',
                style: 'grid',
                title: t('map:rating.panel.yourRating'),
                footer: status || undefined,
                rows: RATING_TIERS.map((item) => {
                    const selected = !!(mine && mine.score === item.score);
                    return {
                        id: `rate:${item.score}`,
                        title: tierLabel(item),
                        subtitle: tierHint(item),
                        symbol: item.symbol,
                        ...iconFor(`rating.${item.key}`),
                        tone: ratingTierTone(item),
                        selected,
                        disabled: !!banned || saving || (exhausted && !selected),
                        keepsOpen: true
                    };
                })
            }
        ].filter(Boolean),
        actions: [
            !isAuthenticated && { id: 'login', title: t('map:rating.panel.loginToRate'), tone: 'accent', keepsOpen: true },
            loadFailed && { id: 'retry', title: t('map:rating.panel.retry'), symbol: sfSymbol('retry'), tone: 'accent', keepsOpen: true },
            mine && !banned && { id: 'withdraw', title: t('map:rating.panel.withdraw'), disabled: saving, keepsOpen: true }
        ].filter(Boolean)
    };
}
