import React, { useEffect, useState } from 'react';
import Button from '../../components/primitives/Button';
import Chip from '../../components/primitives/Chip';
import RangeSlider from '../../components/forms/RangeSlider';
import { loadCategoryDirectory } from '../categoryDirectory';
import { COST_SLIDER, EMPTY_PLACE_FILTER, cyclePlaceFilterTag, isPlaceFilterActive, normalizePlaceFilter, placeFilterTagState } from '../placeFilter';
import { getThemeColor, DEFAULT_PRIMARY } from '../../theme/theme';
import { t } from '../../i18n/index.js';

const costText = (value, bound) => {
    if (value !== null) return t('places:filter.costValue', { cost: value });
    return bound === 'min' ? t('places:filter.costNoMin') : t('places:filter.costNoMax');
};

/** 一句话说明筛选（AI 推荐上方用）：包含的标签、排除的标签、人均范围；没有内容时为空串 */
export function describePlaceFilter(raw) {
    const filter = normalizePlaceFilter(raw);
    const parts = [];
    if (filter.tags.length) parts.push(filter.tags.join(t('places:filter.tagJoiner')));
    if (filter.excludeTags.length) parts.push(t('places:filter.excludeSummary', { tags: filter.excludeTags.join(t('places:filter.tagJoiner')) }));
    if (filter.minCost !== null || filter.maxCost !== null) {
        parts.push(t('places:filter.costSummary', { range: t('places:filter.costRange', { min: costText(filter.minCost, 'min'), max: costText(filter.maxCost, 'max') }) }));
    }
    return parts.join(' · ');
}

// 标签的三种状态：未选 / 包含（绿）/ 排除（红）
// 包含为成功色、排除为危险色（iOS 原生筛选面板相同）
const TAG_TONES = { include: 'success', exclude: 'danger' };

/**
 * 筛选内容：标签（常用在前，可展开全部）与人均拉杆。value / onChange 是 placeFilter.js 的筛选对象，改动立即生效。
 * 点一下标签变绿（包含，多个绿色命中任一即可），再点变红（排除，命中任一就不显示），再点取消。
 */
export default function PlaceFilterPanel({ backendUrl, value = EMPTY_PLACE_FILTER, onChange }) {
    const [categories, setCategories] = useState([]);
    const [loadError, setLoadError] = useState('');
    const [showAll, setShowAll] = useState(false);
    const accent = getThemeColor() || DEFAULT_PRIMARY;
    const filter = normalizePlaceFilter(value);

    useEffect(() => {
        let cancelled = false;
        loadCategoryDirectory(backendUrl)
            .then((list) => { if (!cancelled) setCategories(list); })
            .catch((error) => { if (!cancelled) setLoadError(error.message || t('places:filter.tagsLoadFailed')); });
        return () => { cancelled = true; };
    }, [backendUrl]);

    const common = categories.filter((item) => item.is_common).map((item) => item.name);
    const others = categories.filter((item) => !item.is_common).map((item) => item.name);
    // 已选但不在常用里的标签（展开后选的）收起时也要能看到、能取消
    const picked = [...filter.tags, ...filter.excludeTags];
    const shown = showAll ? [...common, ...others] : [...common, ...picked.filter((tag) => !common.includes(tag))];

    const toggleTag = (tag) => onChange(cyclePlaceFilterTag(filter, tag));
    const sliderValue = [filter.minCost ?? COST_SLIDER.min, filter.maxCost ?? COST_SLIDER.max];
    const setCost = ([low, high]) => onChange(normalizePlaceFilter({ ...filter, minCost: low, maxCost: high }));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--color-text-primary)' }}>
            <section>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, margin: '0 0 8px' }}>
                    <h3 style={{ margin: 0, fontSize: 14 }}>{t('places:filter.tagsTitle')}</h3>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('places:filter.tagsHint')}</span>
                </div>
                {loadError && <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>{loadError}</div>}
                <div role="group" aria-label={t('places:filter.tagsTitle')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: showAll ? 220 : undefined, overflowY: showAll ? 'auto' : undefined }}>
                    {shown.map((tag) => {
                        const state = placeFilterTagState(filter, tag);
                        return (
                            <Chip
                                key={tag}
                                selected={state !== null}
                                tone={state ? TAG_TONES[state] : undefined}
                                icon={state ? (state === 'include' ? 'check' : 'block') : undefined}
                                aria-pressed={state === null ? false : (state === 'include' ? true : 'mixed')}
                                aria-label={state === 'include' ? t('places:filter.tagIncluded', { tag }) : state === 'exclude' ? t('places:filter.tagExcluded', { tag }) : tag}
                                onClick={() => toggleTag(tag)}
                            >
                                {tag}
                            </Chip>
                        );
                    })}
                </div>
                {others.length > 0 && (
                    <button type="button" onClick={() => setShowAll((value) => !value)} style={{ marginTop: 6, padding: 0, border: 0, background: 'none', color: accent, fontSize: 13, cursor: 'pointer' }}>
                        {showAll ? t('places:filter.tagsCollapse') : t('places:filter.tagsExpand', { count: others.length })}
                    </button>
                )}
            </section>
            <section>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                    <h3 style={{ margin: 0, fontSize: 14 }}>{t('places:filter.costTitle')}</h3>
                    <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                        {t('places:filter.costRange', { min: costText(filter.minCost, 'min'), max: costText(filter.maxCost, 'max') })}
                    </span>
                </div>
                <RangeSlider
                    min={COST_SLIDER.min}
                    max={COST_SLIDER.max}
                    step={COST_SLIDER.step}
                    value={sliderValue}
                    onChange={setCost}
                    accent={accent}
                    labels={[t('places:filter.costMinLabel'), t('places:filter.costMaxLabel')]}
                    formatValue={(cost) => (cost >= COST_SLIDER.max ? t('places:filter.costNoMax') : t('places:filter.costValue', { cost }))}
                />
            </section>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button themeAware onClick={() => onChange(EMPTY_PLACE_FILTER)} disabled={!isPlaceFilterActive(filter)}>{t('places:filter.reset')}</Button>
            </div>
        </div>
    );
}
