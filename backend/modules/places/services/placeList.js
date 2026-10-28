const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, personalizedAveragesSnapshot } = require('../../ratings/services/placeRatings');
const snapshot=require('../../ratings/services/ratingSnapshot');
const client=require('../../../infrastructure/numericAlgorithmClient');
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

async function viewerAverages(viewerId, now = Date.now()) {
    if (!viewerId || !isVectorSearchAvailable()) return {averages:new Map(),input_revision:null};
    const cached = personalCache.get(viewerId);
    if (cached && now - cached.at < PERSONAL_CACHE_TTL_MS && cached.value.input_revision===snapshot.revision()) return cached.value;
    let value;
    try {
        value = await personalizedAveragesSnapshot(viewerId);
    } catch (error) {
        if(error.status===409)throw error;
        console.warn('Place list personalization unavailable:', error.message);
        return {averages:new Map(),input_revision:null};
    }
    if (personalCache.size > 500) personalCache.clear();
    personalCache.set(viewerId, { at: now, value });
    return value;
}

async function listPlaces(query, viewerId = null, database = db._raw) {
    const filter = normalizeListFilter(query);
    for(let attempt=0;attempt<2;attempt++){
    let personalResult;
    try{personalResult=await viewerAverages(viewerId);}catch(e){if(e.status===409)continue;throw e;}
    const summaryRevision=await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
    const current=snapshot.context(),personal=personalResult.averages;
    if(summaryRevision!==current.input_revision)continue;
    if(personalResult.input_revision!==null&&personalResult.input_revision!==current.input_revision)continue;
    // 经纬度只用于距离筛选，不放进返回的条目
    const rows = database.prepare(`SELECT p.id, p.name, p.description, p.category, p.per_person_cost,
            p.exterior_images, p.menu_images, p.created_time, p.latitude, p.longitude,${RATING_COLUMNS_SQL}
        FROM Place p
        WHERE ${publicPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}`).all(viewerId);
    const filtered=rows.filter(row=>matchesFilter(row,filter)),byId=new Map(filtered.map(row=>[row.id,row]));
    const result=await client.compute('ratingsort',{...current,places:filtered.map(row=>({id:row.id,rating_count:row.rating_count,rating_average:row.rating_average})),personal:[...personal].map(([place_id,average])=>({place_id,average}))});
    if(!snapshot.same(current.input_revision))continue;
    const visible=new Set(database.prepare(`SELECT p.id FROM Place p WHERE ${publicPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}`).all(viewerId).map(p=>p.id));
    const ranked=result.ranked.filter(r=>visible.has(r.place_id)).map(r=>({row:byId.get(r.place_id),score:r.score,personalized:personal.get(r.place_id)}));
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
    throw client.failure(409,'stale_input');
}

module.exports = { LIST_PAGE_LIMIT, RADIUS_OPTIONS_KM, normalizeListFilter, matchesFilter, listPlaces };
