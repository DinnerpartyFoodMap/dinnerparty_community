const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, personalizedAveragesSnapshot } = require('../../ratings/services/placeRatings');
const snapshot=require('../../ratings/services/ratingSnapshot');
const client=require('../../../infrastructure/numericAlgorithmClient');
const migration=require('../../ratings/services/ratingEstimateAdapter');
const { publicPlaceSql } = require('./placeVisibility');
const { notBlockedSql } = require('../../accounts/services/userRelations');
const { parseCategoryNames } = require('./placeService');

// 地点列表（GET /places/list，见 ../doc/README.md）：店名、简介、第一张图、评价，可按标签、人均与距离筛选，
// 模型可用时按本人预测分加首选前五名加成排序；否则使用保留的旧策略。只给公开地点，
// 返回字段里没有经纬度、地址和距离：列表只链接 /p/:id，位置留在地图里看，整页抓取拿不到坐标。
// 距离只用来筛选（lat / lng 为中心，radiusKm 为半径，只接受几档固定值），不返回每家店的具体距离。
const LIST_PAGE_LIMIT = 30;
const MAX_COST = 100000;
// 距离筛选的几档半径（公里），与前端的下拉框一致
const RADIUS_OPTIONS_KM = Object.freeze([0.5, 1, 3, 5, 10]);
const EARTH_RADIUS_KM = 6371.0088;
// 评价少的地点向中性分（均线）收缩：1 个人打的“强烈推荐”不应排在 20 个人的“均线之上”前面
// 观看者的口味平均在一段时间内复用：翻页时不必每页重算
const PERSONAL_CACHE_TTL_MS = 2 * 60 * 1000;
const personalCache = new Map();
const { createHash, randomUUID } = require('node:crypto');
const LIST_SNAPSHOT_TTL_MS = 2 * 60 * 1000;
const listSnapshots = new Map();
const MAX_SNAPSHOT_ROWS = 100000;
function snapshotKey(filter, viewerId, model) {
    const { offset, limit, ...criteria } = filter;
    criteria.tags = [...criteria.tags].sort();
    criteria.excludeTags = [...criteria.excludeTags].sort();
    return createHash('sha256').update(JSON.stringify({ viewerId, criteria, sort: 'ratingsort-v1',
        dataset: process.env.ALGORITHM_DATASET_ID || 'primary', modes: migration.modes(),model:model?.model??null,calibration_policy:model?.calibration_policy??null,text_evidence_mode:require('../../ratings/services/ratingTextEvidence').mode() })).digest('hex');
}
function listRevision(database) { return database.prepare('SELECT revision FROM PlaceListClock WHERE id=1').get().revision; }
function pruneSnapshots(now) {
    for (const [token, entry] of listSnapshots) if (now >= entry.expires) listSnapshots.delete(token);
}
function snapshotPage(entry, token, filter) {
    return { items: entry.items.slice(filter.offset, filter.offset + filter.limit), total: entry.items.length,
        offset: filter.offset, limit: filter.limit, personalized: entry.personalized, snapshot: token };
}
function visibleIds(database, viewerId) {
    return new Set(database.prepare(`SELECT p.id FROM Place p WHERE ${publicPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}`).all(viewerId).map(p => p.id));
}

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
 * 查询参数：tags 逗号分隔（命中任一即可），excludeTags 逗号分隔（命中任一就排除），
 * minCost / maxCost 为人均范围（设了范围时没填人均的地点不显示），
 * lat / lng / radiusKm 为距离范围
 */
function normalizeListFilter(query = {}) {
    const excludeTags = parseCategoryNames(typeof query.excludeTags === 'string' ? query.excludeTags : '').slice(0, 20);
    const tags = parseCategoryNames(typeof query.tags === 'string' ? query.tags : '').filter((tag) => !excludeTags.includes(tag)).slice(0, 20);
    let minCost = parseCost(query.minCost);
    let maxCost = parseCost(query.maxCost);
    if (minCost !== null && maxCost !== null && minCost > maxCost) [minCost, maxCost] = [maxCost, minCost];
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(LIST_PAGE_LIMIT, Number.parseInt(query.limit, 10) || 20));
    return { tags, excludeTags, minCost, maxCost, distance: parseDistance(query), offset, limit };
}

function matchesFilter(place, { tags = [], excludeTags = [], minCost = null, maxCost = null, distance = null }) {
    if (distance) {
        const lat = Number(place.latitude);
        const lng = Number(place.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || distanceKm(distance, { lat, lng }) > distance.radiusKm) return false;
    }
    if (tags.length || excludeTags.length) {
        const names = parseCategoryNames(place.category);
        if (tags.length && !tags.some((tag) => names.includes(tag))) return false;
        if (excludeTags.some((tag) => names.includes(tag))) return false;
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

async function listPlaces(query = {}, viewerId = null, database = db._raw) {
    const filter = normalizeListFilter(query);
    const model=await migration.configuration();
    const key = snapshotKey(filter, viewerId, model), now = Date.now();
    pruneSnapshots(now);
    if (query.snapshot !== undefined) {
        const entry = typeof query.snapshot === 'string' && listSnapshots.get(query.snapshot);
        if (!entry || entry.key !== key || entry.database !== database || entry.sourceRevision !== listRevision(database)) throw client.failure(409, 'stale_input');
        // Recheck every candidate, including rows outside this page, before returning cached data.
        const visible = visibleIds(database, viewerId);
        if (entry.items.some(item => !visible.has(item.id))) {
            listSnapshots.delete(query.snapshot);
            throw client.failure(409, 'stale_input');
        }
        return snapshotPage(entry, query.snapshot, filter);
    }
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
    const mine=snapshot.viewerRatings(viewerId,database),rejected=new Set([...mine].filter(([,rating])=>rating.score<=2).map(([id])=>id));
    const result=await client.compute('ratingsort',{...current,places:filtered.map(row=>({id:row.id,rating_count:row.rating_count,rating_average:row.rating_average})),personal:[...personal].map(([place_id,average])=>({place_id,average}))});
    let views={estimates:[],predictions:[]};
    try{views=await require('../../ratings/services/ratingEstimateAdapter').ratingViews(filtered.map(row=>row.id),viewerId);}catch(e){if(e.status===409)continue;console.warn('Shadow list ratings unavailable');}
    if(views.input_revision!==undefined&&views.input_revision!==current.input_revision)continue;
    const estimates=new Map(views.estimates.map(r=>[r.place_id,r])),predictions=new Map(views.predictions.map(r=>[r.place_id,r]));
    let replacement=null;
    if(model&&migration.modes().rank!=='off'){
        // Score the entire filtered set once, before pagination. Unrated places
        // may use an internal prior; the public displayed score stays null.
        const legacy=new Map(result.ranked.map(r=>[r.place_id,r.score]));
        const candidates=filtered.filter(row=>!rejected.has(row.id)).map(row=>({place_id:row.id,predicted_rating:mine.get(row.id)?.score??predictions.get(row.id)?.average??estimates.get(row.id)?.average??estimates.get(row.id)?.prior_average??legacy.get(row.id)??2.5}));
        try{const ranked=await migration.rankCandidates(candidates,viewerId,current,{database,config:model});if(migration.modes().rank==='active')replacement=ranked;}catch(e){if(e.status===409)continue;console.warn('Bootstrap list ranking unavailable');}
    }
    if(!snapshot.same(current.input_revision))continue;
    const visible=new Set(database.prepare(`SELECT p.id FROM Place p WHERE ${publicPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}`).all(viewerId).map(p=>p.id));
    // Explicit personal dislikes are retained for browsing, after the other
    // places. They cannot consume a top-five choice bonus or become first pick.
    const order=replacement?[...replacement.ranked,...result.ranked.filter(r=>rejected.has(r.place_id))]:result.ranked;
    const ranked=order.filter(r=>visible.has(r.place_id)).map(r=>({row:byId.get(r.place_id),score:rejected.has(r.place_id)?mine.get(r.place_id).score:r.ranking_score??r.score,personalized:personal.get(r.place_id)}))
        .sort((a,b)=>Number(rejected.has(a.row.id))-Number(rejected.has(b.row.id))||(rejected.has(a.row.id)?b.score-a.score:0));
    const items = ranked.map(({ row, personalized, score }) => ({
        id: row.id,
        name: row.name,
        description: row.description || '',
        category: row.category || '',
        per_person_cost: row.per_person_cost,
        image: firstImage(row.exterior_images, row.menu_images),
        rating_count: Number(row.rating_count) || 0,
        rating_average: row.rating_average,
        personalized_average: personalized ?? null,
        rating_estimate: estimates.get(row.id)??null,
        rating_risk: estimates.get(row.id)?.risk??null,
        predicted_rating: predictions.get(row.id)??null,
        rating_mine: mine.get(row.id)??null,
        rating_viewer_id: viewerId??null,
        score: Math.round(score * 10000) / 10000
    }));
    if (items.length > MAX_SNAPSHOT_ROWS) throw client.failure(503, 'snapshot_capacity');
    let cachedRows = [...listSnapshots.values()].reduce((sum, entry) => sum + entry.items.length, 0);
    while (listSnapshots.size >= 128 || cachedRows + items.length > MAX_SNAPSHOT_ROWS) {
        const oldest = listSnapshots.keys().next().value;
        cachedRows -= listSnapshots.get(oldest).items.length;
        listSnapshots.delete(oldest);
    }
    const token = randomUUID(), entry = { key, database, sourceRevision: listRevision(database), expires: Date.now() + LIST_SNAPSHOT_TTL_MS, items, personalized: replacement?!!viewerId:personal.size > 0 };
    listSnapshots.set(token, entry);
    return snapshotPage(entry, token, filter);
    }
    throw client.failure(409,'stale_input');
}

module.exports = { LIST_PAGE_LIMIT, RADIUS_OPTIONS_KM, normalizeListFilter, matchesFilter, listPlaces };
