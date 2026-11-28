const service = require('../../../infrastructure/numericAlgorithmClient');
const { parseCategoryNames, canonicalCategoryNames } = require('../../places/services/categoryMerges');

const MAX_TAGS = 5;
const MAX_COST = 100000;
const defaultDatabase = () => require('../../../infrastructure/database').db._raw;
// 给模型挑选的标签：公开地点实际用到的标签，用得多的在前。以前从 Category 表按常用和排序取前 200 个，
// 而表里有 400 多个，火锅店、湘菜都排在 200 名外，“不要火锅”就排除不了
const CATEGORY_TTL_MS = 5 * 60 * 1000;
let categoryCache = null;

function knownCategories(database = defaultDatabase(), now = Date.now()) {
    if (categoryCache && categoryCache.database === database && now - categoryCache.at < CATEGORY_TTL_MS) return categoryCache.names;
    const counts = new Map();
    for (const { category } of database.prepare(`SELECT category FROM Place WHERE moderation_status = 'visible'`).iterate()) {
        for (const name of canonicalCategoryNames(parseCategoryNames(category))) counts.set(name, (counts.get(name) || 0) + 1);
    }
    const names = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
        .map(([name]) => name);
    categoryCache = { database, at: now, names };
    return names;
}

function cost(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(MAX_COST, Math.round(number)) : null;
}

/** 校验模型给的筛选：排除的标签必须是现有分类，人均为非负整数；想要的标签（tags）一律丢掉；什么都没有时为 null */
function normalizeSearchFilter(raw, categories) {
    if (!raw || typeof raw !== 'object') return null;
    const allowed = new Set(categories);
    const pick = (list) => [...new Set((Array.isArray(list) ? list : []).filter((tag) => typeof tag === 'string' && allowed.has(tag)))].slice(0, MAX_TAGS);
    const excludeTags = pick(raw.exclude_tags);
    let minCost = cost(raw.min_cost);
    let maxCost = cost(raw.max_cost);
    if (minCost === 0) minCost = null;
    if (minCost !== null && maxCost !== null && minCost > maxCost) [minCost, maxCost] = [maxCost, minCost];
    if (!excludeTags.length && minCost === null && maxCost === null) return null;
    return { tags: [], exclude_tags: excludeTags, min_cost: minCost, max_cost: maxCost };
}

/** 筛选 → 地点判断函数（与地点列表同一套规则）；没有筛选时为 null */
function searchFilterPredicate(filter) {
    if (!filter) return null;
    const { matchesFilter } = require('../../places/services/placeList');
    const rule = { tags: filter.tags || [], excludeTags: filter.exclude_tags || [], minCost: filter.min_cost ?? null, maxCost: filter.max_cost ?? null };
    return (place) => matchesFilter(place, rule);
}

async function compileSearchQuery(query, { database = defaultDatabase(), useCache = true } = {}) {
    const { plan } = await service.compute('searchcompile', {
        query, tags: knownCategories(database), ...(!useCache && { use_cache: false })
    });
    return plan;
}

module.exports = { normalizeSearchFilter, searchFilterPredicate, knownCategories, compileSearchQuery };
