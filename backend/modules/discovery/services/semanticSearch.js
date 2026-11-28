const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, isAvoidedPlace } = require('../../ratings/services/placeRatings');
const { placeDetailCompleteness } = require('../../places/services/placeQuality');
const { parseCategoryNames, canonicalCategoryNames } = require('../../places/services/categoryMerges');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const ai = require('../../../infrastructure/aiClients');
const { recommendationReason, verifiedEvidence } = require('./recommendationReason');
const { compileSearchQuery } = require('./searchFilter');
const { profileInput, searchProfileInputHash } = require('./searchProfiles');
const service = require('../../../infrastructure/numericAlgorithmClient');

const EARTH_RADIUS_KM = 6371.0088;
const REVIEW_CANDIDATES = 8;
// 向量兜底的绝对下限和相对于最佳候选的分差。
const configuredCandidateSemanticScore = Number.parseFloat(process.env.AI_CANDIDATE_MIN_SEMANTIC_SCORE);
const CANDIDATE_MIN_SEMANTIC_SCORE = Number.isFinite(configuredCandidateSemanticScore)
    ? Math.max(0, Math.min(1, configuredCandidateSemanticScore))
    : 0.35;
const CANDIDATE_RELATIVE_MARGIN = 0.12;
const configuredPlaceDetailWeight = Number.parseFloat(process.env.AI_PLACE_DETAIL_WEIGHT);
const PLACE_DETAIL_WEIGHT = Number.isFinite(configuredPlaceDetailWeight)
    ? Math.max(0, Math.min(0.5, configuredPlaceDetailWeight))
    : 0.25;
// 审核需要地点相关且达到置信度门槛。
const configuredRelevanceConfidence = Number.parseFloat(process.env.AI_RELEVANCE_MIN_CONFIDENCE);
const RELEVANCE_MIN_CONFIDENCE = Number.isFinite(configuredRelevanceConfidence)
    ? Math.max(0, Math.min(1, configuredRelevanceConfidence))
    : 0.5;
// 有地图中心时，候选取半径内的全部地点；视野较大时取视野半径的两倍。
const configuredSearchRadiusKm = Number.parseFloat(process.env.AI_SEARCH_RADIUS_KM);
const SEARCH_RADIUS_KM = Number.isFinite(configuredSearchRadiusKm)
    ? Math.max(5, Math.min(300, configuredSearchRadiusKm))
    : 50;
// 排序分 = 资料修正后的相似度 × (1 - 权重) + 距离分 × 权重。相关度差不多时近的在前，
// 明显更相关的店仍能排过眼前普通的店
const configuredProximityWeight = Number.parseFloat(process.env.AI_PROXIMITY_WEIGHT);
const PROXIMITY_WEIGHT = Number.isFinite(configuredProximityWeight)
    ? Math.max(0, Math.min(0.3, configuredProximityWeight))
    : 0.12;

function buildEmbeddingQuery(query, intentExpansion = null) {
    const original = String(query || '').trim();
    const retrievalText = String(intentExpansion?.retrieval_text || '').trim();
    const expanded = intentExpansion?.needs_expansion === true
        && retrievalText
        && retrievalText !== original;
    const intentHint = expanded ? `\nDeepSeek 标准化检索意图：${retrievalText}` : '';
    return {
        text: `检索任务：从地点库中找出最符合用户用餐需求的地点。\n用户原始需求：${original}${intentHint}`,
        expanded,
        expansion_source: expanded ? String(intentExpansion?.source || 'deepseek') : 'original'
    };
}

function vectorBuffer(embedding) {
    if (!Array.isArray(embedding) || embedding.length !== ai.EMBEDDING_DIMENSIONS) {
        throw new Error(`expected a ${ai.EMBEDDING_DIMENSIONS}-dimension query embedding`);
    }
    const typed = new Float32Array(embedding);
    return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
}

function semanticScore(distance) {
    const similarity = 1 - Number(distance);
    if (!Number.isFinite(similarity)) return 0;
    return Math.max(0, Math.min(1, similarity));
}

function finiteCoordinate(value, min, max) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeCenter(center) {
    if (!center || typeof center !== 'object') return null;
    const lat = finiteCoordinate(center.lat, -90, 90);
    const lng = finiteCoordinate(center.lng, -180, 180);
    return lat === null || lng === null ? null : { lat, lng };
}

function normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const minLat = finiteCoordinate(bounds.minLat, -90, 90);
    const maxLat = finiteCoordinate(bounds.maxLat, -90, 90);
    const minLng = finiteCoordinate(bounds.minLng, -180, 180);
    const maxLng = finiteCoordinate(bounds.maxLng, -180, 180);
    if ([minLat, maxLat, minLng, maxLng].some((value) => value === null)) return null;
    if (minLat > maxLat || minLng > maxLng) return null;
    return { minLat, maxLat, minLng, maxLng };
}

function toRadians(value) {
    return value * Math.PI / 180;
}

function haversineDistanceKm(a, b) {
    const pointA = normalizeCenter(a);
    const pointB = normalizeCenter(b);
    if (!pointA || !pointB) return null;
    const latDelta = toRadians(pointB.lat - pointA.lat);
    const lngDelta = toRadians(pointB.lng - pointA.lng);
    const latA = toRadians(pointA.lat);
    const latB = toRadians(pointB.lat);
    const h = Math.sin(latDelta / 2) ** 2
        + Math.cos(latA) * Math.cos(latB) * Math.sin(lngDelta / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isInsideBounds(point, bounds) {
    if (!point || !bounds) return false;
    return point.lat >= bounds.minLat && point.lat <= bounds.maxLat
        && point.lng >= bounds.minLng && point.lng <= bounds.maxLng;
}

function viewportRadiusKm(center, bounds) {
    if (!center || !bounds) return null;
    const corners = [
        { lat: bounds.minLat, lng: bounds.minLng },
        { lat: bounds.minLat, lng: bounds.maxLng },
        { lat: bounds.maxLat, lng: bounds.minLng },
        { lat: bounds.maxLat, lng: bounds.maxLng }
    ];
    return Math.max(...corners.map((corner) => haversineDistanceKm(center, corner) || 0));
}

function publicPlace(row) {
    const place = { ...row };
    delete place.vector_distance;
    return place;
}

// 候选半径：SEARCH_RADIUS_KM，视野更大时取视野半径的两倍
function searchRadiusKm(viewRadius) {
    return Math.max(SEARCH_RADIUS_KM, viewRadius === null ? 0 : viewRadius * 2);
}

function placePosition(row, center, bounds, viewRadius) {
    const point = normalizeCenter({ lat: row.latitude, lng: row.longitude });
    const distance = center && point ? haversineDistanceKm(center, point) : null;
    // 距离分在视野半径处为 0.5，视野较小时使用最小距离尺度。
    const scale = Math.max(2, viewRadius ?? 5);
    return {
        distance_km: distance === null ? null : Number(distance.toFixed(3)),
        in_view: isInsideBounds(point, bounds),
        proximity_score: distance === null ? 0 : 1 / (1 + (distance / scale) ** 1.35)
    };
}

function rankSemanticRows(rows, { center, bounds, limit = REVIEW_CANDIDATES, minimumSemanticScore = CANDIDATE_MIN_SEMANTIC_SCORE } = {}) {
    const safeCenter = normalizeCenter(center);
    const safeBounds = normalizeBounds(bounds);
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || REVIEW_CANDIDATES));
    const safeMinimumSemanticScore = Number.isFinite(Number(minimumSemanticScore))
        ? Math.max(0, Math.min(1, Number(minimumSemanticScore)))
        : CANDIDATE_MIN_SEMANTIC_SCORE;
    const viewRadius = viewportRadiusKm(safeCenter, safeBounds);
    const radiusKm = safeCenter ? searchRadiusKm(viewRadius) : null;

    // 避雷地点（综合评价在“均线之下”及以下；无人评价时看“避雷”标签）不进入 AI 推荐
    const candidates = rows.filter((row) => !isAvoidedPlace(row)).map((row) => {
        const semantic = semanticScore(row.vector_distance);
        const detailCompleteness = placeDetailCompleteness(row);
        const detailAdjustedSemantic = semantic * (1 - PLACE_DETAIL_WEIGHT + PLACE_DETAIL_WEIGHT * detailCompleteness);
        const position = placePosition(row, safeCenter, safeBounds, viewRadius);
        return {
            place: publicPlace(row),
            score: safeCenter
                ? Math.max(0, Math.min(1, detailAdjustedSemantic * (1 - PROXIMITY_WEIGHT) + position.proximity_score * PROXIMITY_WEIGHT))
                : detailAdjustedSemantic,
            semantic_score: semantic,
            detail_completeness: detailCompleteness,
            detail_adjusted_score: detailAdjustedSemantic,
            vector_distance: Number(row.vector_distance),
            ...position
        };
    }).filter((candidate) => !safeCenter || (candidate.distance_km !== null && candidate.distance_km <= radiusKm));

    const best = candidates.reduce((maximum, candidate) => Math.max(maximum, candidate.semantic_score), 0);
    const floor = Math.max(safeMinimumSemanticScore, best - CANDIDATE_RELATIVE_MARGIN);
    return candidates
        .filter((candidate) => candidate.semantic_score >= floor)
        .sort((a, b) => b.score - a.score
            || b.semantic_score - a.semantic_score
            || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity) || a.place.id - b.place.id)
        .slice(0, safeLimit);
}

function isConfidentRecommendationReview(review, minimumConfidence = RELEVANCE_MIN_CONFIDENCE) {
    const confidence = Number(review?.confidence);
    const safeMinimum = Number.isFinite(Number(minimumConfidence))
        ? Math.max(0, Math.min(1, Number(minimumConfidence)))
        : RELEVANCE_MIN_CONFIDENCE;
    return review?.relevant === true && Number.isFinite(confidence) && confidence >= safeMinimum;
}

function structuredPool(database, center, bounds) {
    const viewRadius = viewportRadiusKm(center, bounds);
    const radius = searchRadiusKm(viewRadius);
    const latitudeDelta = radius / (EARTH_RADIUS_KM * Math.PI / 180);
    const rows = database.prepare(`SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,
        ${RATING_COLUMNS_SQL}, s.input_hash AS profile_hash, s.profile_version AS profile_version, s.facts AS profile_facts,
        s.inferred AS profile_inferred, s.closed AS profile_closed
        FROM Place p
        LEFT JOIN User u ON p.creator_id = u.id
        LEFT JOIN User uu ON p.updated_by = uu.id
        LEFT JOIN PlaceSearchProfile s ON s.place_id = p.id
        WHERE ${publicPlaceSql('p')} ${center ? 'AND p.latitude BETWEEN ? AND ?' : ''}
        ${center ? 'ORDER BY p.id' : 'ORDER BY COALESCE(p.updated_time, p.created_time) DESC, p.id DESC LIMIT 3000'}`).iterate(...(center ? [center.lat - latitudeDelta, center.lat + latitudeDelta] : []));
    const pool = [];
    for (const { profile_hash, profile_version, profile_facts, profile_inferred, profile_closed, ...place } of rows) {
        const position = placePosition(place, center, bounds, viewRadius);
        if (center && (position.distance_km === null || position.distance_km > radius)) continue;
        const input = profileInput(place);
        let profile = null;
        if (profile_hash && profile_facts && profile_inferred && profile_hash === searchProfileInputHash(input)) {
            profile = {
                version: profile_version,
                facts: JSON.parse(profile_facts),
                inferred: JSON.parse(profile_inferred),
                closed: profile_closed === 1
            };
        }
        const perPersonCost = place.per_person_cost == null ? null : Number(place.per_person_cost);
        pool.push({
            place, ...position, detail_completeness: placeDetailCompleteness(place),
            input: {
                ...input,
                description: [...input.description].slice(0, 600).join(''),
                tags: canonicalCategoryNames(parseCategoryNames(place.category)),
                per_person_cost: Number.isFinite(perPersonCost) && perPersonCost >= 0 ? perPersonCost : null,
                profile, avoided: isAvoidedPlace(place)
            }
        });
    }
    return pool;
}

async function vectorCandidates(query, pool, candidates, vectorPlan, { database, center, bounds, embed, onVectorLookup }) {
    const seen = new Set(candidates.map(({ place }) => place.id));
    const ids = vectorPlan.eligible_ids.filter((id) => !seen.has(id));
    if (!ids.length || !isVectorSearchAvailable() || !ai.hasEmbeddingConfiguration()) return [];
    try {
        onVectorLookup?.();
        const vector = vectorBuffer(await embed(buildEmbeddingQuery(query).text));
        const distances = database.prepare(`SELECT place_id, vec_distance_cosine(embedding, ?) AS vector_distance
            FROM place_vectors WHERE place_id IN (SELECT value FROM json_each(?))`).all(vector, JSON.stringify(ids));
        const rows = distances.map(({ place_id, vector_distance }) => ({ ...pool.get(place_id).place, vector_distance }));
        return rankSemanticRows(rows, { center, bounds, limit: vectorPlan.max }).map((match) => {
            const row = pool.get(match.place.id);
            return {
                ...row, ...match, source: 'vector', normalizedEvidence: 0,
                reviewCost: row.input.per_person_cost ?? row.input.profile?.facts.cost_mentioned ?? null
            };
        });
    } catch (error) {
        console.warn('AI search vector fallback failed:', error.message);
        return [];
    }
}

function publicMatch(match) {
    return {
        place: match.place, score: match.score, semantic_score: match.semantic_score,
        detail_completeness: match.detail_completeness, vector_distance: match.vector_distance ?? null,
        distance_km: match.distance_km, in_view: match.in_view, source: match.source
    };
}

async function searchSemanticPlaces(query, {
    limit = 5, center = null, bounds = null, database = db._raw, includeDiagnostics = false,
    compile = compileSearchQuery, embed = ai.createEmbedding, review = ai.reviewRecommendationRelevance,
    prepareRatings = () => require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries(), onVectorLookup
} = {}) {
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 5));
    const safeCenter = normalizeCenter(center);
    const safeBounds = normalizeBounds(bounds);
    const [plan, rows] = await Promise.all([
        compile(query, { database }),
        (async () => {
            await prepareRatings();
            return structuredPool(database, safeCenter, safeBounds);
        })()
    ]);
    const { core, soft, must_not, keywords, exclude_tags, min_cost, max_cost } = plan;
    const filter = { tags: [], exclude_tags, min_cost, max_cost };
    const response = (status, recommendations = [], matches = []) => ({
        status, recommendation: recommendations[0] ?? null, recommendations, matches, filter,
        ...(includeDiagnostics && { conditions: { core, soft, must_not, keywords } })
    });

    const pool = new Map(rows.map((row) => [row.place.id, row]));
    const rank = await service.compute('searchrank', {
        plan, center_given: Boolean(safeCenter),
        places: rows.map(({ input, distance_km, proximity_score, detail_completeness }) => ({
            ...input, distance_km, proximity_score, detail_completeness
        }))
    });
    const candidates = rank.candidates.map((match) => ({
        ...pool.get(match.id), source: 'structured', normalizedEvidence: match.evidence_norm,
        semantic_score: match.evidence_norm, score: match.retrieval_norm, matched: match.matched,
        factualCore: match.factual_core, reviewCost: match.review_cost
    }));
    if (rank.vector.wanted) {
        candidates.push(...await vectorCandidates(query, pool, candidates, rank.vector,
            { database, center: safeCenter, bounds: safeBounds, embed, onVectorLookup }));
    }
    if (!candidates.length) {
        if (!rank.counts.pool) return response(safeCenter ? 'no_nearby_match' : 'index_empty');
        if (!rank.counts.eligible) return response('no_filter_match');
        return response('no_relevant_match');
    }

    const batches = [];
    for (let i = 0; i < candidates.length; i += REVIEW_CANDIDATES) batches.push(candidates.slice(i, i + REVIEW_CANDIDATES));
    const checked = await Promise.allSettled(batches.map(async (batch) => {
        const reviews = await review(query, batch);
        if (!Array.isArray(reviews) || reviews.length !== batch.length) throw new Error('Invalid relevance review');
        return reviews;
    }));
    const failed = checked.filter(({ status }) => status === 'rejected');
    for (const failure of failed) console.warn('DeepSeek relevance review failed:', failure.reason?.message ?? failure.reason);
    if (failed.length === batches.length) return response('unavailable');

    const accepted = batches.flatMap((batch, batchIndex) => {
        const reviews = checked[batchIndex].value;
        return batch.flatMap((match, index) => {
            const verdict = reviews?.[index];
            if (reviews ? !isConfidentRecommendationReview(verdict) : !match.factualCore) return [];
            const confidence = reviews ? Number(verdict.confidence) : 0;
            return [{ match, verdict, confidence }];
        });
    });
    let ordered = accepted;
    if (accepted.length) {
        try {
            const { order } = await service.compute('searchorder', {
                items: accepted.map(({ match, confidence }) => ({
                    id: match.place.id, evidence_norm: match.normalizedEvidence,
                    proximity_score: match.proximity_score, confidence
                }))
            });
            const byId = new Map(accepted.map((entry) => [entry.match.place.id, entry]));
            ordered = order.map((id) => byId.get(id));
        } catch (error) {
            console.warn('AI search card ordering failed:', error.message);
            ordered = accepted.sort((a, b) => b.confidence - a.confidence
                || b.match.normalizedEvidence - a.match.normalizedEvidence);
        }
    }
    const recommendations = ordered.slice(0, 3)
        .map(({ match, verdict, confidence }, index) => ({
            place: match.place,
            score: match.score,
            semantic_score: match.semantic_score,
            detail_completeness: match.detail_completeness,
            match_percent: Math.round((match.source === 'structured' ? match.normalizedEvidence : match.score) * 100),
            distance_km: match.distance_km,
            in_view: match.in_view,
            review_confidence: confidence,
            review_source: verdict ? 'deepseek' : 'local_fallback',
            reason: recommendationReason(query, match, verifiedEvidence(verdict?.evidence, match.place), index),
            reason_source: 'template',
            ...(includeDiagnostics && match.matched && { matched: match.matched }),
            source: match.source
        }));
    const status = failed.length ? 'partial' : recommendations.length ? 'ok' : 'no_confident_match';
    return response(status, recommendations, candidates.slice(0, safeLimit).map(publicMatch));
}

module.exports = {
    searchSemanticPlaces,
    haversineDistanceKm,
    normalizeCenter,
    normalizeBounds,
    rankSemanticRows,
    CANDIDATE_MIN_SEMANTIC_SCORE,
    REVIEW_CANDIDATES,
    PLACE_DETAIL_WEIGHT,
    RELEVANCE_MIN_CONFIDENCE,
    SEARCH_RADIUS_KM,
    PROXIMITY_WEIGHT,
    placeDetailCompleteness,
    isConfidentRecommendationReview,
    buildEmbeddingQuery
};
