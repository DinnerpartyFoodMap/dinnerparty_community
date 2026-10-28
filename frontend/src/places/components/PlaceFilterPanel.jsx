import React, { useEffect, useState } from 'react';
import Button from '../../components/primitives/Button';
import RangeSlider from '../../components/forms/RangeSlider';
import { loadCategoryDirectory } from '../categoryDirectory';
import { COST_SLIDER, EMPTY_PLACE_FILTER, isPlaceFilterActive, normalizePlaceFilter } from '../placeFilter';
import { getThemeColor } from '../../theme/theme';
import { t } from '../../i18n/index.js';

const costText = (value, bound) => {
    if (value !== null) return t('places:filter.costValue', { cost: value });
    return bound === 'min' ? t('places:filter.costNoMin') : t('places:filter.costNoMax');
};

/** 筛选内容：标签（常用在前，可展开全部）与人均拉杆。value / onChange 是 placeFilter.js 的筛选对象，改动立即生效 */
export default function PlaceFilterPanel({ backendUrl, value = EMPTY_PLACE_FILTER, onChange, source = null }) {
    const [categories, setCategories] = useState([]);
    const [loadError, setLoadError] = useState('');
    const [showAll, setShowAll] = useState(false);
    const accent = getThemeColor() || '#E2789F';
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
    // 已选但不在当前显示范围里的标签（例如 AI 选的不常用标签）也要能看到、能取消
    const shown = showAll ? [...common, ...others] : [...common, ...filter.tags.filter((tag) => !common.includes(tag))];

    const toggleTag = (tag) => {
        const tags = filter.tags.includes(tag) ? filter.tags.filter((item) => item !== tag) : [...filter.tags, tag];
        onChange(normalizePlaceFilter({ ...filter, tags }));
    };
    const sliderValue = [filter.minCost ?? COST_SLIDER.min, filter.maxCost ?? COST_SLIDER.max];
    const setCost = ([low, high]) => onChange(normalizePlaceFilter({ ...filter, minCost: low, maxCost: high }));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--color-text-primary)' }}>
            {source === 'ai' && isPlaceFilterActive(filter) && (
                <div role="status" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('places:filter.fromAi')}</div>
            )}
            <section>
                <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{t('places:filter.tagsTitle')}</h3>
                {loadError && <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>{loadError}</div>}
                <div role="group" aria-label={t('places:filter.tagsTitle')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: showAll ? 220 : undefined, overflowY: showAll ? 'auto' : undefined }}>
                    {shown.map((tag) => {
                        const selected = filter.tags.includes(tag);
                        return (
                            <button
                                key={tag}
                                type="button"
                                className="fm-pressable"
                                aria-pressed={selected}
                                onClick={() => toggleTag(tag)}
                                style={{
                                    minHeight: 32, padding: '4px 12px', borderRadius: 16, cursor: 'pointer', fontSize: 13,
                                    border: `1px solid ${selected ? accent : 'var(--color-border)'}`,
                                    background: selected ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
                                    color: selected ? accent : 'var(--color-text-primary)', fontWeight: selected ? 700 : 400
                                }}
                            >
                                {tag}
                            </button>
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
