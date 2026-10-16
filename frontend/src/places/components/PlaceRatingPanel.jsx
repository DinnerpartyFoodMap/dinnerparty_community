import React from 'react';
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t, tx } from "../../i18n/index.js";
import {
    RATING_TIERS, FEW_RATINGS, ratingTierFor, tierForAverage, tierLabel, tierHint, formatAverage, summaryFromPlace
} from "../rating";

// 评价面板：上半部分是大家的评价（档位、分数、人数、分布、按口味加权），下半部分选自己的评价。
// 宽屏为居中对话框，窄屏为底部面板；iOS 原生地点卡片打开它时，原生面板暂时让位。
export default function PlaceRatingPanel({ open, onClose, place, rating, isAuthenticated, banned, onRequireAuth, showTip }) {
    return (
        <ResponsivePanel
            open={open && !!place}
            onClose={onClose}
            title={t('map:rating.panel.title')}
            label={place ? t('map:rating.panel.titleNamed', { name: place.name }) : t('map:rating.panel.title')}
            kind="place-rating"
            desktop="center"
            mobile="sheet"
            closeLabel={t('map:rating.panel.close')}
            width="min(440px, calc(100vw - 24px))"
            bodyStyle={{ padding: 0 }}
        >
            {place && (
                <RatingBody
                    place={place}
                    rating={rating}
                    isAuthenticated={isAuthenticated}
                    banned={banned}
                    onRequireAuth={onRequireAuth}
                    showTip={showTip}
                />
            )}
        </ResponsivePanel>
    );
}

const sectionTitleStyle = { fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 8 };

function RatingBody({ place, rating, isAuthenticated, banned, onRequireAuth, showTip }) {
    const data = rating.data;
    const summary = data ? data.summary : summaryFromPlace(place);
    const tier = tierForAverage(summary.average);
    const mine = data && data.mine;
    const quota = data && data.quota;
    const exhausted = !!(quota && quota.remaining <= 0 && !quota.place_counted);
    const distribution = data ? data.summary.distribution : null;
    const maxCount = distribution ? Math.max(1, ...Object.values(distribution)) : 1;

    const choose = async (score) => {
        if (!isAuthenticated) {
            onRequireAuth && onRequireAuth();
            return;
        }
        if (banned || rating.saving || (mine && mine.score === score)) return;
        try {
            await rating.submit(score);
            showTip && showTip(t('map:rating.panel.saved', { tier: tierLabel(ratingTierFor(score)) }));
        } catch (error) {
            showTip && showTip(t('map:rating.panel.saveFailed', { message: error.message || error }));
            if (error && error.status === 429) rating.reload();
        }
    };

    const withdraw = async () => {
        if (rating.saving) return;
        try {
            await rating.withdraw();
            showTip && showTip(t('map:rating.panel.withdrawn'));
        } catch (error) {
            showTip && showTip(t('map:rating.panel.saveFailed', { message: error.message || error }));
        }
    };

    return (
        <div style={{ padding: '4px 20px 20px', color: 'var(--color-text-primary)' }}>
            {/* 大家的评价 */}
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 10px' }}>
                {summary.count > 0 ? (
                    <>
                        <span style={{ fontSize: 24, fontWeight: 800, color: tier.tone }}>{tierLabel(tier)}</span>
                        <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatAverage(summary.average)}</span>
                        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{t('map:rating.panel.count', { count: summary.count })}</span>
                    </>
                ) : (
                    <span style={{ fontSize: 18, fontWeight: 700 }}>{t('map:rating.panel.empty')}</span>
                )}
            </div>
            {summary.count > 0 && summary.count < FEW_RATINGS && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>{t('map:rating.summary.few')}</div>
            )}
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                {t('map:rating.panel.weightedHint')}
            </div>

            {distribution && summary.count > 0 && (
                <div role="list" aria-label={t('map:rating.panel.distribution')} style={{ marginTop: 14, display: 'grid', gap: 6 }}>
                    {RATING_TIERS.map((item) => {
                        const count = distribution[item.score] || 0;
                        return (
                            <div key={item.score} role="listitem" aria-label={t('map:rating.panel.distributionRow', { tier: tierLabel(item), count })}
                                style={{ display: 'grid', gridTemplateColumns: '64px 1fr 28px', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                <span style={{ color: 'var(--color-text-secondary)' }}>{tierLabel(item)}</span>
                                <span style={{ height: 8, borderRadius: 999, background: 'var(--color-border)', overflow: 'hidden' }}>
                                    <span style={{ display: 'block', height: '100%', width: `${count / maxCount * 100}%`, background: item.tone, borderRadius: 999, transition: 'width 200ms ease' }} />
                                </span>
                                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>{count}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 按口味加权：鸭觅式“专属匹配度”的简化版，和公开分数并列显示，不替换它 */}
            {data && data.personalized && (
                <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--theme-secondary-0-12)', border: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:rating.panel.personalizedTitle')}</div>
                    <div style={{ marginTop: 2, fontSize: 16, fontWeight: 700 }}>
                        {tx('map:rating.panel.personalizedText', {
                            tier: <span style={{ color: tierForAverage(data.personalized.average).tone }}>{tierLabel(tierForAverage(data.personalized.average))}</span>,
                            average: formatAverage(data.personalized.average)
                        })}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                        {t('map:rating.panel.personalizedHint', { matched: data.personalized.matched_raters })}
                    </div>
                </div>
            )}
            {data && !data.personalized && isAuthenticated && summary.count > 1 && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{t('map:rating.panel.personalizedUnavailable')}</div>
            )}

            {/* 我的评价 */}
            <div style={{ marginTop: 20, ...sectionTitleStyle }}>{t('map:rating.panel.yourRating')}</div>
            <div role="radiogroup" aria-label={t('map:rating.panel.yourRating')} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                {RATING_TIERS.map((item) => {
                    const selected = !!(mine && mine.score === item.score);
                    const disabled = banned || rating.saving || (exhausted && !selected);
                    return (
                        <button
                            key={item.score}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            aria-label={t('map:rating.panel.optionLabel', { tier: tierLabel(item), hint: tierHint(item) })}
                            disabled={disabled}
                            onClick={() => choose(item.score)}
                            className="fm-pressable"
                            style={{
                                display: 'flex', alignItems: 'center', gap: 8, minHeight: 56, padding: '8px 10px', textAlign: 'left',
                                borderRadius: 'var(--radius-sm)', cursor: disabled ? 'default' : 'pointer',
                                border: `${selected ? 2 : 1}px solid ${selected ? item.tone : 'var(--color-border)'}`,
                                background: selected ? `color-mix(in srgb, ${item.tone} 14%, transparent)` : 'transparent',
                                color: 'var(--color-text-primary)', opacity: disabled && !selected ? 0.5 : 1,
                                touchAction: 'manipulation'
                            }}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: 24, color: item.tone, flexShrink: 0 }}>{item.icon}</span>
                            <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: selected ? item.tone : undefined }}>{tierLabel(item)}</span>
                                <span style={{ display: 'block', fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>{tierHint(item)}</span>
                            </span>
                        </button>
                    );
                })}
            </div>

            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 32, fontSize: 12, color: 'var(--color-text-muted)' }}>
                <span style={{ lineHeight: 1.5 }}>
                    {!isAuthenticated ? (
                        <button type="button" onClick={onRequireAuth} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--theme-primary)', fontSize: 13, cursor: 'pointer' }}>
                            {t('map:rating.panel.loginToRate')}
                        </button>
                    ) : banned ? t('map:rating.panel.banned')
                        : rating.loading && !data ? t('map:rating.panel.loading')
                        : rating.error && !data ? t('map:rating.panel.loadFailed', { message: rating.error })
                        : quota ? (exhausted ? t('map:rating.panel.quotaExhausted', { limit: quota.limit })
                            : quota.place_counted ? t('map:rating.panel.quotaCounted')
                            : t('map:rating.panel.quota', { remaining: quota.remaining })) : null}
                </span>
                {mine && !banned && (
                    <button type="button" onClick={withdraw} disabled={rating.saving}
                        style={{ flexShrink: 0, padding: '6px 0', border: 0, background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                        {t('map:rating.panel.withdraw')}
                    </button>
                )}
            </div>
            {mine && mine.source !== 'user' && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('map:rating.panel.creatorNote')}</div>
            )}
            {rating.error && !data && (
                <button type="button" onClick={rating.reload} style={{ marginTop: 8, padding: 0, border: 0, background: 'transparent', color: 'var(--theme-primary)', fontSize: 13, cursor: 'pointer' }}>
                    {t('map:rating.panel.retry')}
                </button>
            )}
        </div>
    );
}
