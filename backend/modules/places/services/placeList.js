const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, personalizedAverages } = require('../../ratings/services/placeRatings');
const { publicPlaceSql } = require('./placeVisibility');
const { notBlockedSql } = require('../../accounts/services/userRelations');
const { parseCategoryNames } = require('./placeService');

// 地点列表（GET /places/list，见 ../doc/README.md）：店名、简介、第一张图、评价，可按标签、人均与距离筛选，
// 按“综合评价 + 与观看者口味相近的人的评价”排序。只给公开地点，
// 返回字段里没有经纬度、地址和距离：列表只链接 /p/:id，位置留在地图里看，整页抓取拿不到坐标。
// 距离只用来筛选（lat / lng 为中心，radiusKm 为半径，只接受几档固定值），不返回每家店的具体距离。
const LIST_PAGE_LIMIT = 30;
const MAX_COST = 100000;
// 距离筛选的几档半径（公里），与前端的下拉框一致
const RADIUS_OPTIONS_KM = Object.freeze([1, 3, 5, 10, 20, 50]);
const EARTH_RADIUS_KM = 6371.0088;
// 评价少的地点向中性分（均线）收缩：1 个人打的“强烈推荐”不应排在 20 个人的“均线之上”前面
const NEUTRAL_SCORE = 2.5;
const PRIOR_WEIGHT = 2;
// 观看者的口味平均在一段时间内复用：翻页时不必每页重算
const PERSONAL_CACHE_TTL_MS = 2 * 60 * 1000;
const personalCache = new Map();

function firstImage(...fields) {
    for (const value of fields) {
        if (!value) continue;
        try {
            const list = JSON.parse(value);
            const url = Array.isArray(list) ? list.find((item) => typeof item === 'string' && item) : null;
            if (url) return url;
        } catch (_) { /* 旧数据格式不对时当作没有图片 */ }
    }
    return null;
}

function parseCost(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(MAX_COST, Math.floor(number)) : null;
}

function coordinate(value, bound) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= bound ? number : null;
}

/** 距离筛选：中心与半径都合法时才生效 */
function parseDistance(query) {
    const lat = coordinate(query.lat, 90);
    const lng = coordinate(query.lng, 180);
    const radiusKm = Number(query.radiusKm);
    if (lat === null || lng === null || !RADIUS_OPTIONS_KM.includes(radiusKm)) return null;
    return { lat, lng, radiusKm };
}

function distanceKm(a, b) {
    const toRadians = (value) => value * Math.PI / 180;
    const latDelta = toRadians(b.lat - a.lat);
    const lngDelta = toRadians(b.lng - a.lng);
    const h = Math.sin(latDelta / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(lngDelta / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 查询参数：tags 逗号分隔（命中任一即可），minCost / maxCost 为人均范围（设了范围时没填人均的地点不显示），
 * lat / lng / radiusKm 为距离范围
 */
function normalizeListFilter(query = {}) {
    const tags = parseCategoryNames(typeof query.tags === 'string' ? query.tags : '').slice(0, 20);
    let minCost = parseCost(query.minCost);
    let maxCost = parseCost(query.maxCost);
    if (minCost !== null && maxCost !== null && minCost > maxCost) [minCost, maxCost] = [maxCost, minCost];
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(LIST_PAGE_LIMIT, Number.parseInt(query.limit, 10) || 20));
    return { tags, minCost, maxCost, distance: parseDistance(query), offset, limit };
}

function matchesFilter(place, { tags, minCost, maxCost, distance = null }) {
    if (distance) {
        const lat = Number(place.latitude);
        const lng = Number(place.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || distanceKm(distance, { lat, lng }) > distance.radiusKm) return false;
    }
    if (tags.length) {
        const names = parseCategoryNames(place.category);
        if (!tags.some((tag) => names.includes(tag))) return false;
    }
    if (minCost !== null || maxCost !== null) {
        const cost = Number(place.per_person_cost);
        if (!Number.isFinite(cost) || cost <= 0) return false;
        if (minCost !== null && cost < minCost) return false;
        if (maxCost !== null && cost > maxCost) return false;
    }
    return true;
}

function shrunkScore(average, count) {
    const n = Number(count) || 0;
    const value = Number(average);
    if (!n || !Number.isFinite(value)) return NEUTRAL_SCORE;
    return (n * value + PRIOR_WEIGHT * NEUTRAL_SCORE) / (n + PRIOR_WEIGHT);
}

function viewerAverages(viewerId, now = Date.now()) {
    if (!viewerId || !isVectorSearchAvailable()) return new Map();
    const cached = personalCache.get(viewerId);
    if (cached && now - cached.at < PERSONAL_CACHE_TTL_MS) return cached.value;
    let value = new Map();
    try {
        value = personalizedAverages(viewerId);
    } catch (error) {
        console.warn('Place list personalization unavailable:', error.message);
    }
    if (personalCache.size > 500) personalCache.clear();
    personalCache.set(viewerId, { at: now, value });
    return value;
}

/** 综合分：公开评价（向均线收缩），有口味加权平均时与它各占一半 */
function combinedScore(place, personal) {
    const publicScore = shrunkScore(place.rating_average, place.rating_count);
    if (personal === undefined) return publicScore;
    return (publicScore + personal) / 2;
}

function listPlaces(query, viewerId = null, database = db._raw) {
    const filter = normalizeListFilter(query);
    // 经纬度只用于距离筛选，不放进返回的条目
    const rows = database.prepare(`SELECT p.id, p.name, p.description, p.category, p.per_person_cost,
            p.exterior_images, p.menu_images, p.created_time, p.latitude, p.longitude,${RATING_COLUMNS_SQL}
        FROM Place p
        WHERE ${publicPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}`).all(viewerId);
    const personal = viewerAverages(viewerId);
    const ranked = rows.filter((row) => matchesFilter(row, filter)).map((row) => {
        const personalized = personal.get(row.id);
        return { row, personalized, score: combinedScore(row, personalized) };
    });
    ranked.sort((a, b) => (b.score - a.score)
        || ((Number(b.row.rating_count) || 0) - (Number(a.row.rating_count) || 0))
        || (b.row.id - a.row.id));
    const page = ranked.slice(filter.offset, filter.offset + filter.limit).map(({ row, personalized, score }) => ({
        id: row.id,
        name: row.name,
        description: row.description || '',
        category: row.category || '',
        per_person_cost: row.per_person_cost,
        image: firstImage(row.exterior_images, row.menu_images),
        rating_count: Number(row.rating_count) || 0,
        rating_average: row.rating_average,
        personalized_average: personalized ?? null,
        score: Math.round(score * 10000) / 10000
    }));
    return {
        items: page,
        total: ranked.length,
        offset: filter.offset,
        limit: filter.limit,
        personalized: personal.size > 0
    };
}

module.exports = { LIST_PAGE_LIMIT, RADIUS_OPTIONS_KM, normalizeListFilter, matchesFilter, shrunkScore, combinedScore, listPlaces };
