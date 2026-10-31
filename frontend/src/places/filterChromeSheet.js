// iOS 原生地图控件里的筛选面板（协议 v14 的 filter 面板，从右侧按钮组展开的玻璃外壳）：
// 与网页 PlaceFilterPanel 同一份筛选状态。标签画成标签（style "chips"）：点一下包含（绿），再点排除（红），再点取消；
// 人均用几档常用范围（原生面板里没有双滑块），网页拉杆设出的其他范围在说明里显示，点“不限”可清除。
import { cyclePlaceFilterTag, isPlaceFilterActive, normalizePlaceFilter, placeFilterTagState } from './placeFilter.js';
import { t } from '../i18n/index.js';

/** 人均档位：[最低, 最高]，null 为不设 */
export const FILTER_COST_PRESETS = Object.freeze([
    { id: 'any', min: null, max: null },
    { id: '0-30', min: null, max: 30 },
    { id: '30-60', min: 30, max: 60 },
    { id: '60-100', min: 60, max: 100 },
    { id: '100-', min: 100, max: null }
]);

// 展开全部时最多下发的标签数（原生面板一次最多 300 行）
const TAG_LIMIT = 200;

const costPresetLabel = (preset) => {
    if (preset.min === null && preset.max === null) return t('places:filter.costNoMin');
    if (preset.min === null) return t('places:filter.costAtMost', { max: preset.max });
    if (preset.max === null) return t('places:filter.costAtLeast', { min: preset.min });
    return t('places:filter.costBetween', { min: preset.min, max: preset.max });
};

const costValue = (value, bound) => {
    if (value !== null) return t('places:filter.costValue', { cost: value });
    return bound === 'min' ? t('places:filter.costNoMin') : t('places:filter.costNoMax');
};

/**
 * 面板快照。categories 为分类目录（常用在前）；showAll 为展开全部标签；loading / error 为目录读取状态。
 */
export function filterChromeSheet({ filter, categories = [], showAll = false, loading = false, error = '' }) {
    const value = normalizePlaceFilter(filter);
    const common = categories.filter((item) => item.is_common).map((item) => item.name);
    const others = categories.filter((item) => !item.is_common).map((item) => item.name);
    const picked = [...value.tags, ...value.excludeTags];
    const tags = (showAll ? [...common, ...others] : [...common, ...picked.filter((tag) => !common.includes(tag))]).slice(0, TAG_LIMIT);
    const tagRows = tags.map((tag) => {
        const state = placeFilterTagState(value, tag);
        return {
            id: `tag:${tag}`,
            title: tag,
            tone: state || undefined,
            symbol: state === 'include' ? 'checkmark' : state === 'exclude' ? 'nosign' : undefined,
            subtitle: state === 'include' ? t('places:filter.included') : state === 'exclude' ? t('places:filter.excluded') : undefined,
            keepsOpen: true
        };
    });
    const presetSelected = (preset) => preset.min === value.minCost && preset.max === value.maxCost;
    const customCost = !FILTER_COST_PRESETS.some(presetSelected);
    const sections = [];
    if (tagRows.length) {
        sections.push({ id: 'tags', title: t('places:filter.tagsTitle'), style: 'chips', footer: t('places:filter.tagsHint'), rows: tagRows });
    }
    if (others.length) {
        sections.push({
            id: 'more',
            rows: [{
                id: 'tags:more',
                title: showAll ? t('places:filter.tagsCollapse') : t('places:filter.tagsExpand', { count: others.length }),
                symbol: showAll ? 'chevron.up' : 'chevron.down',
                keepsOpen: true
            }]
        });
    }
    sections.push({
        id: 'cost',
        title: t('places:filter.costTitle'),
        style: 'chips',
        footer: customCost
            ? t('places:filter.costCurrent', { range: t('places:filter.costRange', { min: costValue(value.minCost, 'min'), max: costValue(value.maxCost, 'max') }) })
            : undefined,
        rows: FILTER_COST_PRESETS.map((preset) => ({
            id: `cost:${preset.id}`,
            title: costPresetLabel(preset),
            tone: presetSelected(preset) ? 'accent' : undefined,
            keepsOpen: true
        }))
    });
    sections.push({
        id: 'actions',
        rows: [{ id: 'reset', title: t('places:filter.reset'), symbol: 'xmark.circle', tone: 'danger', disabled: !isPlaceFilterActive(value), keepsOpen: true }]
    });
    return {
        id: 'filter',
        title: t('places:filter.title'),
        size: 'list',
        message: loading && !categories.length ? t('common:status.loading') : (error || undefined),
        messageTone: loading && !categories.length ? 'loading' : (error ? 'danger' : undefined),
        sections
    };
}

/** 点了面板里的一行：返回 { filter } 新筛选，或 { toggleShowAll: true }；不认识的行返回 null */
export function applyFilterSheetRow(filter, rowId) {
    const id = String(rowId || '');
    if (id.startsWith('tag:')) return { filter: cyclePlaceFilterTag(filter, id.slice(4)) };
    if (id === 'tags:more') return { toggleShowAll: true };
    if (id.startsWith('cost:')) {
        const preset = FILTER_COST_PRESETS.find((item) => `cost:${item.id}` === id);
        if (!preset) return null;
        return { filter: normalizePlaceFilter({ ...normalizePlaceFilter(filter), minCost: preset.min, maxCost: preset.max }) };
    }
    if (id === 'reset') return { filter: normalizePlaceFilter(null) };
    return null;
}
