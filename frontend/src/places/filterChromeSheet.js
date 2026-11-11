// iOS 原生地图控件里的筛选面板（协议 v14 的 filter 面板，从右侧按钮组展开的玻璃外壳）：
// 与网页 PlaceFilterPanel 同一份筛选状态。标签画成标签（style "chips"）：点一下包含（绿），再点排除（红），再点取消；
// “展开全部标签”是跟在标签后面的无边框文字（tone "link"）。人均与网页一样是双头拉杆（v15 style "range"），
// 松手后原生回传行 id "cost:range:<低>:<高>"。清除筛选在标题左侧（leading）。
// 地区（省 / 市 / 区）是三个下拉菜单（v16 style "menu"：行是选项，tone "accent" 为选中项），点选回传 "region:<层>:<名称>"。
import { COST_SLIDER, cyclePlaceFilterTag, isPlaceFilterActive, normalizePlaceFilter, placeFilterTagState, setPlaceFilterRegion } from './placeFilter.js';
import { regionPath } from './placeRegions.js';
import { t } from '../i18n/index.js';
import { sfSymbol } from '../platform/iconRegistry.js';

// 展开全部时最多下发的标签数（原生面板一次最多 300 行）
const TAG_LIMIT = 200;
const COST_RANGE_PREFIX = 'cost:range:';
const REGION_PREFIX = 'region:';
// 每个下拉菜单最多下发的选项数
const REGION_OPTION_LIMIT = 80;

function regionMenu(level, title, options, selected) {
    const rows = [{ id: `${REGION_PREFIX}${level}:`, title: t('places:filter.regionAny'), tone: selected ? undefined : 'accent', keepsOpen: true }];
    if (selected && !options.some((item) => item.name === selected)) rows.push({ id: `${REGION_PREFIX}${level}:${selected}`, title: selected, tone: 'accent', keepsOpen: true });
    for (const item of options.slice(0, REGION_OPTION_LIMIT)) {
        rows.push({
            id: `${REGION_PREFIX}${level}:${item.name}`,
            title: t('places:filter.regionOption', { name: item.name, count: item.count }),
            tone: item.name === selected ? 'accent' : undefined,
            keepsOpen: true
        });
    }
    return { id: `region-${level}`, title, style: 'menu', rows };
}

/**
 * 面板快照。categories 为分类目录（常用在前）；showAll 为展开全部标签；loading / error 为目录读取状态。
 */
export function filterChromeSheet({ filter, categories = [], regions = [], showAll = false, loading = false, error = '' }) {
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
            symbol: state === 'include' ? sfSymbol('include') : state === 'exclude' ? sfSymbol('exclude') : undefined,
            subtitle: state === 'include' ? t('places:filter.included') : state === 'exclude' ? t('places:filter.excluded') : undefined,
            keepsOpen: true
        };
    });
    // 与网页一样：展开 / 收起紧跟在标签后面，无边框文字，字号与标签相同
    if (others.length) {
        tagRows.push({
            id: 'tags:more',
            title: showAll ? t('places:filter.tagsCollapse') : t('places:filter.tagsExpand', { count: others.length }),
            tone: 'link',
            keepsOpen: true
        });
    }
    const sections = [];
    // 地区：选了省才出现市，选了市才出现区（原生面板最多 8 段）
    const [provinceNode, cityNode] = regionPath(regions, value);
    if (regions.length || value.province) {
        sections.push(regionMenu('province', t('places:filter.regionProvince'), regions, value.province));
        if (value.province) sections.push(regionMenu('city', t('places:filter.regionCity'), provinceNode ? provinceNode.children || [] : [], value.city));
        if (value.city && ((cityNode && (cityNode.children || []).length) || value.district)) {
            sections.push(regionMenu('district', t('places:filter.regionDistrict'), cityNode ? cityNode.children || [] : [], value.district));
        }
    }
    if (tagRows.length) {
        sections.push({ id: 'tags', title: t('places:filter.tagsTitle'), style: 'chips', footer: t('places:filter.tagsHint'), rows: tagRows });
    }
    sections.push({
        id: 'cost',
        title: t('places:filter.costTitle'),
        style: 'range',
        rows: [],
        range: {
            id: 'cost',
            min: COST_SLIDER.min,
            max: COST_SLIDER.max,
            step: COST_SLIDER.step,
            low: value.minCost ?? COST_SLIDER.min,
            high: value.maxCost ?? COST_SLIDER.max,
            labels: [t('places:filter.costMinLabel'), t('places:filter.costMaxLabel')],
            // 原生按网页的文案拼出“¥30 - 不限”：%d 为金额，%min / %max 为两端
            valueFormat: t('places:filter.costValue', { cost: '%d' }),
            noMin: t('places:filter.costNoMin'),
            noMax: t('places:filter.costNoMax'),
            rangeFormat: t('places:filter.costRange', { min: '%min', max: '%max' })
        }
    });
    return {
        id: 'filter',
        title: t('places:filter.title'),
        size: 'list',
        // 标题左侧：清除筛选
        leading: { id: 'reset', title: t('places:filter.reset'), symbol: sfSymbol('clearFilter'), disabled: !isPlaceFilterActive(value), keepsOpen: true },
        message: loading && !categories.length ? t('common:status.loading') : (error || undefined),
        messageTone: loading && !categories.length ? 'loading' : (error ? 'danger' : undefined),
        sections
    };
}

/** 点了面板里的一行（或拉杆松手）：返回 { filter } 新筛选，或 { toggleShowAll: true }；不认识的行返回 null */
export function applyFilterSheetRow(filter, rowId) {
    const id = String(rowId || '');
    if (id.startsWith('tag:')) return { filter: cyclePlaceFilterTag(filter, id.slice(4)) };
    if (id === 'tags:more') return { toggleShowAll: true };
    if (id.startsWith(REGION_PREFIX)) {
        const rest = id.slice(REGION_PREFIX.length);
        const split = rest.indexOf(':');
        const level = split > 0 ? rest.slice(0, split) : '';
        if (!['province', 'city', 'district'].includes(level)) return null;
        return { filter: setPlaceFilterRegion(filter, level, rest.slice(split + 1)) };
    }
    if (id.startsWith(COST_RANGE_PREFIX)) {
        const [low, high] = id.slice(COST_RANGE_PREFIX.length).split(':').map(Number);
        if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
        // 两端拉到头就是不限（normalizePlaceFilter 处理）
        return { filter: normalizePlaceFilter({ ...normalizePlaceFilter(filter), minCost: low, maxCost: high }) };
    }
    if (id === 'reset') return { filter: normalizePlaceFilter(null) };
    return null;
}
