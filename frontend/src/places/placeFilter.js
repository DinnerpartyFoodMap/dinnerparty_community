// 地点筛选（地图筛选按钮、地点列表页共用）：按标签与人均范围。
// 标签分两种：tags（绿色，命中任一即可）与 excludeTags（红色，命中任一就排除），即（绿 OR 绿）−（红 OR 红）。
// 规则与后端 modules/places/services/placeList.js 的 matchesFilter 一致：设了人均范围时，没填人均的地点不显示。

/** 人均拉杆的范围：拉到最右表示“不设上限” */
export const COST_SLIDER = Object.freeze({ min: 0, max: 200, step: 5 });

export const EMPTY_PLACE_FILTER = Object.freeze({ tags: [], excludeTags: [], minCost: null, maxCost: null });

const splitTags = (value) => String(value || '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

function cost(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

const tagList = (value) => [...new Set((Array.isArray(value) ? value : []).filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()))].slice(0, 20);

/** 规整筛选：标签去重（同时出现在两边时按排除算），最低人均为 0 等于不设，最高人均到拉杆上限等于不设 */
export function normalizePlaceFilter(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const excludeTags = tagList(value.excludeTags);
    const tags = tagList(value.tags).filter((tag) => !excludeTags.includes(tag));
    let minCost = cost(value.minCost);
    let maxCost = cost(value.maxCost);
    if (minCost !== null && maxCost !== null && minCost > maxCost) [minCost, maxCost] = [maxCost, minCost];
    if (minCost !== null && minCost <= COST_SLIDER.min) minCost = null;
    if (maxCost !== null && maxCost >= COST_SLIDER.max) maxCost = null;
    return { tags, excludeTags, minCost, maxCost };
}

/** 后端 AI 搜索已套用的 filter（tags / exclude_tags / min_cost / max_cost）→ 筛选，只用来在 AI 结果上方说明；没有内容时为 null */
export function placeFilterFromAi(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const filter = normalizePlaceFilter({ tags: raw.tags, excludeTags: raw.exclude_tags, minCost: raw.min_cost, maxCost: raw.max_cost });
    return isPlaceFilterActive(filter) ? filter : null;
}

export function isPlaceFilterActive(filter) {
    return !!filter && ((filter.tags || []).length > 0 || (filter.excludeTags || []).length > 0 || filter.minCost != null || filter.maxCost != null);
}

/** 标签当前的状态：'include'（绿）/ 'exclude'（红）/ null */
export function placeFilterTagState(filter, tag) {
    if ((filter?.excludeTags || []).includes(tag)) return 'exclude';
    if ((filter?.tags || []).includes(tag)) return 'include';
    return null;
}

/** 点一下标签：未选 → 包含（绿）→ 排除（红）→ 未选 */
export function cyclePlaceFilterTag(filter, tag) {
    const value = normalizePlaceFilter(filter);
    const state = placeFilterTagState(value, tag);
    const tags = value.tags.filter((item) => item !== tag);
    const excludeTags = value.excludeTags.filter((item) => item !== tag);
    if (state === null) tags.push(tag);
    else if (state === 'include') excludeTags.push(tag);
    return normalizePlaceFilter({ ...value, tags, excludeTags });
}

export function placeFilterKey(filter) {
    const value = normalizePlaceFilter(filter);
    return JSON.stringify([[...value.tags].sort(), [...value.excludeTags].sort(), value.minCost, value.maxCost]);
}

/** 高德临时地点（还没收录）没有标签和人均，不参与筛选 */
export function matchesPlaceFilter(place, filter) {
    if (!place || !isPlaceFilterActive(filter) || place.isMarked === false) return true;
    const tags = filter.tags || [];
    const excludeTags = filter.excludeTags || [];
    if (tags.length || excludeTags.length) {
        const names = splitTags(place.category);
        if (tags.length && !tags.some((tag) => names.includes(tag))) return false;
        if (excludeTags.some((tag) => names.includes(tag))) return false;
    }
    if (filter.minCost != null || filter.maxCost != null) {
        const value = Number(place.per_person_cost);
        if (!Number.isFinite(value) || value <= 0) return false;
        if (filter.minCost != null && value < filter.minCost) return false;
        if (filter.maxCost != null && value > filter.maxCost) return false;
    }
    return true;
}

/** 距离筛选的几档半径（公里），与后端 placeList.js 的 RADIUS_OPTIONS_KM 一致；null 为不限 */
export const RADIUS_OPTIONS_KM = Object.freeze([0.5, 1, 3, 5, 10]);

/** 列表接口的查询参数：标签 / 人均 + 距离（center 与 radiusKm 都有时） */
export function placeListQuery(filter, distance) {
    const params = placeFilterQuery(filter);
    const lat = Number(distance?.center?.lat);
    const lng = Number(distance?.center?.lng);
    if (distance && Number.isFinite(lat) && Number.isFinite(lng) && RADIUS_OPTIONS_KM.includes(distance.radiusKm)) {
        params.set('lat', lat.toFixed(6));
        params.set('lng', lng.toFixed(6));
        params.set('radiusKm', String(distance.radiusKm));
    }
    return params;
}

/** 列表接口的查询参数 */
export function placeFilterQuery(filter) {
    const value = normalizePlaceFilter(filter);
    const params = new URLSearchParams();
    if (value.tags.length) params.set('tags', value.tags.join(','));
    if (value.excludeTags.length) params.set('excludeTags', value.excludeTags.join(','));
    if (value.minCost !== null) params.set('minCost', String(value.minCost));
    if (value.maxCost !== null) params.set('maxCost', String(value.maxCost));
    return params;
}
