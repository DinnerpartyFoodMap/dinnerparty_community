const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, isAvoidedPlace } = require('../../ratings/services/placeRatings');
const { placeDetailCompleteness } = require('../../places/services/placeQuality');
const {
    EMBEDDING_DIMENSIONS,
    createEmbedding,
    expandSearchIntent,
    reviewRecommendationRelevance,
    hasEmbeddingConfiguration,
    hasDeepseekConfiguration
} = require('../../../infrastructure/aiClients');
const { recommendationReason, verifiedEvidence } = require('./recommendationReason');

const EARTH_RADIUS_KM = 6371.0088;
const MAX_VECTOR_CANDIDATES = 200;
// 送给模型审核的候选数。向量相似度只粗排，是否相关由审核决定，所以多审几家，免得前几家被否掉就一家不剩
const REVIEW_CANDIDATES = 8;
// 审核前的相似度下限，只挡明显无关的地点。Qwen3-Embedding 的余弦值挤在一个窄区间里，而且随查询整体浮动：
// “寿司”附近的寿司店在 0.6 上下，“适合聚餐”这种笼统的说法连大排档、火锅店也只有 0.42–0.44。
// 所以下限是相对的：比附近最相似的那家低 CANDIDATE_RELATIVE_MARGIN 以内都算候选，但不低于绝对下限
// （旧的固定 0.6 / 0.55 门槛让大多数查询一家都不剩）
const configuredCandidateSemanticScore = Number.parseFloat(process.env.AI_CANDIDATE_MIN_SEMANTIC_SCORE);
const CANDIDATE_MIN_SEMANTIC_SCORE = Number.isFinite(configuredCandidateSemanticScore)
    ? Math.max(0, Math.min(1, configuredCandidateSemanticScore))
    : 0.35;
const CANDIDATE_RELATIVE_MARGIN = 0.12;
// 审核通过的几家都算相关，卡片顺序里距离占得更重：近处的相关店排在远处更相似的店前面
const ACCEPTED_PROXIMITY_WEIGHT = 0.3;
const configuredPlaceDetailWeight = Number.parseFloat(process.env.AI_PLACE_DETAIL_WEIGHT);
const PLACE_DETAIL_WEIGHT = Number.isFinite(configuredPlaceDetailWeight)
    ? Math.max(0, Math.min(0.5, configuredPlaceDetailWeight))
    : 0.25;
// 审核结果先看 relevant；confidence 只挡模型自己没把握的。提示词给的刻度是：描述写到 0.8+、店名或分类推出约 0.7、
// 按常识推断场景约 0.6。旧默认 0.68 正好卡在模型来回浮动的 0.6–0.7 之间，同一句查询这次有推荐、下次一家没有
const configuredRelevanceConfidence = Number.parseFloat(process.env.AI_RELEVANCE_MIN_CONFIDENCE);
const RELEVANCE_MIN_CONFIDENCE = Number.isFinite(configuredRelevanceConfidence)
    ? Math.max(0, Math.min(1, configuredRelevanceConfidence))
    : 0.5;
const configuredFallbackRelevanceScore = Number.parseFloat(process.env.AI_FALLBACK_RELEVANCE_MIN_SCORE);
const FALLBACK_RELEVANCE_MIN_SCORE = Number.isFinite(configuredFallbackRelevanceScore)
    ? Math.max(0, Math.min(1, configuredFallbackRelevanceScore))
    : 0.58;
// 有地图中心时，候选取中心这个半径内（或视野半径的两倍，取大的）的全部地点，逐个算相似度；
// 不再先在全国取前 100/200 再按距离筛，否则地点少的城市常常一家都进不了候选
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
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`expected a ${EMBEDDING_DIMENSIONS}-dimension query embedding`);
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

function rankSemanticRows(rows, { center, bounds, limit = REVIEW_CANDIDATES, minimumSemanticScore = CANDIDATE_MIN_SEMANTIC_SCORE } = {}) {
    const safeCenter = normalizeCenter(center);
    const safeBounds = normalizeBounds(bounds);
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || REVIEW_CANDIDATES));
    const safeMinimumSemanticScore = Number.isFinite(Number(minimumSemanticScore))
        ? Math.max(0, Math.min(1, Number(minimumSemanticScore)))
        : CANDIDATE_MIN_SEMANTIC_SCORE;
    const viewRadius = viewportRadiusKm(safeCenter, safeBounds);
    const radiusKm = safeCenter ? searchRadiusKm(viewRadius) : null;
    // 距离分在视野半径处为 0.5；视野很小时按 2 公里算，免得几百米的差距压过相关度
    const proximityScale = Math.max(2, viewRadius ?? 5);

    // 避雷地点（综合评价在“均线之下”及以下；无人评价时看“避雷”标签）不进入 AI 推荐
    const candidates = rows.filter((row) => !isAvoidedPlace(row)).map((row) => {
        const semantic = semanticScore(row.vector_distance);
        const detailCompleteness = placeDetailCompleteness(row);
        const detailAdjustedSemantic = semantic * (1 - PLACE_DETAIL_WEIGHT + PLACE_DETAIL_WEIGHT * detailCompleteness);
        const placePoint = normalizeCenter({ lat: row.latitude, lng: row.longitude });
        const distanceKm = safeCenter && placePoint ? haversineDistanceKm(safeCenter, placePoint) : null;
        const inView = Boolean(safeBounds && placePoint && isInsideBounds(placePoint, safeBounds));
        const proximity = distanceKm === null ? 0 : 1 / (1 + (distanceKm / proximityScale) ** 1.35);
        return {
            place: publicPlace(row),
            score: safeCenter
                ? Math.max(0, Math.min(1, detailAdjustedSemantic * (1 - PROXIMITY_WEIGHT) + proximity * PROXIMITY_WEIGHT))
                : detailAdjustedSemantic,
            semantic_score: semantic,
            detail_completeness: detailCompleteness,
            detail_adjusted_score: detailAdjustedSemantic,
            vector_distance: Number(row.vector_distance),
            distance_km: distanceKm === null ? null : Number(distanceKm.toFixed(3)),
            in_view: inView,
            proximity_score: proximity
        };
    }).filter((candidate) => !safeCenter || (candidate.distance_km !== null && candidate.distance_km <= radiusKm));

    const best = Math.max(0, ...candidates.map((candidate) => candidate.semantic_score));
    const floor = Math.max(safeMinimumSemanticScore, best - CANDIDATE_RELATIVE_MARGIN);
    return candidates
        .filter((candidate) => candidate.semantic_score >= floor)
        .sort((a, b) => b.score - a.score
            || b.semantic_score - a.semantic_score
            || (a.distance_km ?? Number.POSITIVE_INFINITY) - (b.distance_km ?? Number.POSITIVE_INFINITY))
        .slice(0, safeLimit);
}

// 响应里的 matches 不带内部排序用的分数
function publicMatch({ detail_adjusted_score, proximity_score, ...match }) {
    return match;
}

function acceptedOrderScore(match) {
    return match.detail_adjusted_score * (1 - ACCEPTED_PROXIMITY_WEIGHT) + match.proximity_score * ACCEPTED_PROXIMITY_WEIGHT;
}

function isConfidentRecommendationReview(review, minimumConfidence = RELEVANCE_MIN_CONFIDENCE) {
    const confidence = Number(review?.confidence);
    const safeMinimum = Number.isFinite(Number(minimumConfidence))
        ? Math.max(0, Math.min(1, Number(minimumConfidence)))
        : RELEVANCE_MIN_CONFIDENCE;
    return review?.relevant === true && Number.isFinite(confidence) && confidence >= safeMinimum;
}

function passesLocalRecommendationThreshold(match, minimumScore = FALLBACK_RELEVANCE_MIN_SCORE) {
    const score = Number(match?.score);
    const safeMinimum = Number.isFinite(Number(minimumScore))
        ? Math.max(0, Math.min(1, Number(minimumScore)))
        : FALLBACK_RELEVANCE_MIN_SCORE;
    return Number.isFinite(score) && score >= safeMinimum;
}

const CANDIDATE_COLUMNS_SQL = `p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}`;

// 没有地图中心：全国按向量取最近的 MAX_VECTOR_CANDIDATES 家
function nearestVectorRows(vector) {
    return db._raw.prepare(`WITH nearest AS (
            SELECT place_id, distance
            FROM place_vectors
            WHERE embedding MATCH ? AND k = ?
        )
        SELECT ${CANDIDATE_COLUMNS_SQL}, nearest.distance AS vector_distance
        FROM nearest
        JOIN Place p ON p.id = nearest.place_id
        LEFT JOIN User u ON p.creator_id = u.id
        LEFT JOIN User uu ON p.updated_by = uu.id
        WHERE p.moderation_status = 'visible'
        ORDER BY nearest.distance`).all(vector, MAX_VECTOR_CANDIDATES);
}

// 有地图中心：先按经纬度方框取半径内的地点，再逐个算余弦距离（几百到几千家，sqlite-vec 算起来是毫秒级）；
// 方框比圆大，圆外的由 rankSemanticRows 按实际距离去掉
function nearbyVectorRows(vector, center, radiusKm) {
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180)));
    return db._raw.prepare(`SELECT ${CANDIDATE_COLUMNS_SQL}, vec_distance_cosine(v.embedding, ?) AS vector_distance
        FROM Place p
        JOIN place_vectors v ON v.place_id = p.id
        LEFT JOIN User u ON p.creator_id = u.id
        LEFT JOIN User uu ON p.updated_by = uu.id
        WHERE p.moderation_status = 'visible'
          AND p.latitude BETWEEN ? AND ?
          AND p.longitude BETWEEN ? AND ?
        ORDER BY vector_distance`).all(vector,
        center.lat - latDelta, center.lat + latDelta, center.lng - lngDelta, center.lng + lngDelta);
}

// placeFilter：可选的地点判断函数（或它的 Promise），AI 从原话里读出的筛选（排除的标签、人均）；在候选上先筛，再排序与审核
async function searchSemanticPlaces(query, { limit = 5, center = null, bounds = null, placeFilter = null } = {}) {
    if (!isVectorSearchAvailable()) throw new Error('sqlite-vec is unavailable');
    if (!hasEmbeddingConfiguration()) throw new Error('SILICONFLOW_API_KEY is not configured');
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 5));
    const safeCenter = normalizeCenter(center);
    const safeBounds = normalizeBounds(bounds);
    const intentExpansion = await expandSearchIntent(query);
    const queryProfile = buildEmbeddingQuery(query, intentExpansion);
    const embedding = await createEmbedding(queryProfile.text);
    // 筛选提取与意图扩展、向量化并行，到这里才需要它的结果；提取失败按没有筛选处理
    const accept = await Promise.resolve(placeFilter).catch(() => null);
    await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
    const vector = vectorBuffer(embedding);
    const candidateRows = safeCenter
        ? nearbyVectorRows(vector, safeCenter, searchRadiusKm(viewportRadiusKm(safeCenter, safeBounds)))
        : nearestVectorRows(vector);
    const rows = typeof accept === 'function' ? candidateRows.filter(accept) : candidateRows;
    if (!rows.length && candidateRows.length) {
        return { status: 'no_filter_match', recommendation: null, recommendations: [], matches: [] };
    }

    // 排序多取几家给审核用；响应里的 matches 仍按 limit 截
    const matches = rankSemanticRows(rows, {
        center: safeCenter,
        bounds: safeBounds,
        limit: Math.max(safeLimit, REVIEW_CANDIDATES)
    });
    if (!matches.length) {
        return {
            status: !rows.length ? (safeCenter ? 'no_nearby_match' : 'index_empty') : 'no_relevant_match',
            recommendation: null,
            recommendations: [],
            matches: []
        };
    }

    // Review several semantic candidates so rejected generic matches can be
    // replaced while the public response still contains at most three cards.
    // The model only judges relevance and quotes the description; the sentence
    // shown to the user is always a fixed template (recommendationReason.js).
    const reviewCandidates = matches.slice(0, REVIEW_CANDIDATES);
    let reviews = null;
    let deepseekReviewCompleted = false;
    if (hasDeepseekConfiguration()) {
        try {
            reviews = await reviewRecommendationRelevance(query, reviewCandidates);
            deepseekReviewCompleted = Array.isArray(reviews);
        } catch (error) {
            console.warn('DeepSeek relevance review failed:', error.message);
        }
    }

    const accepted = reviewCandidates
        .map((match, index) => ({ match, review: reviews?.[index] || null }))
        .filter(({ match, review }) => (deepseekReviewCompleted
            ? isConfidentRecommendationReview(review)
            : passesLocalRecommendationThreshold(match)))
        .sort((a, b) => acceptedOrderScore(b.match) - acceptedOrderScore(a.match))
        .slice(0, 3);
    const recommendations = accepted.map(({ match, review }, cardIndex) => {
        const excerpt = deepseekReviewCompleted ? verifiedEvidence(review.evidence, match.place) : '';
        const reason = recommendationReason(query, match, excerpt, cardIndex);
        return {
            place: match.place,
            score: match.score,
            semantic_score: match.semantic_score,
            detail_completeness: match.detail_completeness,
            match_percent: Math.round(match.score * 100),
            distance_km: match.distance_km,
            in_view: match.in_view,
            review_confidence: deepseekReviewCompleted ? Number(review.confidence) : Number(match.score),
            review_source: deepseekReviewCompleted ? 'deepseek' : 'local_fallback',
            reason,
            // Always a fixed template: older clients label only 'deepseek', so they show no AI tag either.
            reason_source: 'template'
        };
    });

    const publicMatches = matches.slice(0, safeLimit).map(publicMatch);
    if (!recommendations.length) {
        return {
            status: 'no_confident_match',
            recommendation: null,
            recommendations: [],
            matches: publicMatches
        };
    }

    return {
        status: deepseekReviewCompleted ? 'ok' : 'partial',
        recommendation: recommendations[0] || null,
        recommendations,
        matches: publicMatches
    };
}

module.exports = {
    searchSemanticPlaces,
    haversineDistanceKm,
    normalizeCenter,
    normalizeBounds,
    rankSemanticRows,
    acceptedOrderScore,
    CANDIDATE_MIN_SEMANTIC_SCORE,
    REVIEW_CANDIDATES,
    PLACE_DETAIL_WEIGHT,
    RELEVANCE_MIN_CONFIDENCE,
    FALLBACK_RELEVANCE_MIN_SCORE,
    SEARCH_RADIUS_KM,
    PROXIMITY_WEIGHT,
    placeDetailCompleteness,
    isConfidentRecommendationReview,
    passesLocalRecommendationThreshold,
    buildEmbeddingQuery
};
