const { db } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL, isAvoidedPlace } = require('../../ratings/services/placeRatings');
const { normalizeCenter, haversineDistanceKm } = require('./semanticSearch');
const { creationTimestamp } = require('../../ratings/services/placeRatingSchema');

const QUERY_MAX_LENGTH = 300;
const GEO_BONUS = 30;
const GEO_OFFSET_KM = 0.3;
// Keep city-scale category matches competitive with remote name substrings.
const GEO_HALF_LIFE_KM = 15;

function normalizeText(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function splitTerms(value) {
    return String(value ?? '').normalize('NFKC').split(/[\s,、;]+/u).map(normalizeText).filter(Boolean);
}

// Use exactly the same normalization for candidate retrieval and scoring. instr
// treats input literally, so SQL wildcards never broaden the candidate set.
db._raw.function('place_search_text', { deterministic: true }, normalizeText);

function textScore(row, terms) {
    if (!terms.length) return 0; // A bare 避雷 query is a status filter.
    const name = normalizeText(row.name);
    const category = normalizeText(row.category);
    const tags = splitTerms(row.category);
    const description = normalizeText(row.description);
    return terms.reduce((sum, term) => sum + Math.max(
        name.includes(term) ? 100 + 5 * term.length / name.length : 0,
        tags.includes(term) ? 95 : (category.includes(term) ? 90 : 0),
        description.includes(term) ? 55 : 0
    ), 0) / terms.length;
}

function searchCenter(point) {
    if (!point || !['lat', 'lng'].every(key => typeof point[key] === 'number'
        || (typeof point[key] === 'string' && point[key].trim() !== ''))) return null;
    return normalizeCenter(point);
}

// Keyword search shared by both HTTP aliases and the QQ bot. The optional center
// biases broad discovery; a complete restaurant name still wins across cities.
// See services/placeSearch.md for sources, weights and warning-query rules.
// viewerId：网页 / App 带登录态时传入，结果包含自己还在复核中的地点；QQ 机器人等不传，只搜公开地点。
function fastSearch(query, limit = 50, { center, viewerId = null } = {}) {
    const rawQuery = String(query ?? '').trim().slice(0, QUERY_MAX_LENGTH);
    const queryTerms = splitTerms(rawQuery);
    if (!queryTerms.length) return [];
    const wantsAvoided = queryTerms.includes('避雷');
    const terms = [...new Set(queryTerms.filter(term => term !== '避雷'))];
    const exactName = normalizeText(rawQuery);
    const safeCenter = searchCenter(center);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const parameters = { viewer: viewerId == null ? null : String(viewerId) };
    const predicates = terms.map((term, index) => {
        parameters[`term${index}`] = term;
        return `(instr(place_search_text(p.name), @term${index}) > 0
            OR instr(place_search_text(p.category), @term${index}) > 0
            OR instr(place_search_text(p.description), @term${index}) > 0)`;
    });
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE (p.moderation_status = 'visible' OR p.creator_id = @viewer)
                   AND ${predicates.length ? predicates.join(' AND ') : '1 = 1'}`;
    // Never truncate candidates here: a nearby category match can otherwise be
    // lost behind an entire page of remote name matches before ranking starts.
    const rows = db._raw.prepare(sql).all(parameters);
    return rows.filter(row => !wantsAvoided || isAvoidedPlace(row)).map(row => {
        const placePoint = searchCenter({ lat: row.latitude, lng: row.longitude });
        const distance = safeCenter && placePoint
            ? haversineDistanceKm(safeCenter, placePoint)
            : null;
        const proximity = distance === null ? 0
            : GEO_BONUS * 2 ** (-Math.max(0, distance - GEO_OFFSET_KM) / GEO_HALF_LIFE_KM);
        return {
            row,
            exact: !wantsAvoided && normalizeText(row.name) === exactName,
            avoided: !wantsAvoided && isAvoidedPlace(row),
            score: textScore(row, terms) + proximity,
            distance,
            created: creationTimestamp(row.created_time, 0)
        };
    }).sort((left, right) => Number(right.exact) - Number(left.exact)
        || Number(left.avoided) - Number(right.avoided)
        || right.score - left.score
        || (left.distance ?? Infinity) - (right.distance ?? Infinity)
        || right.created - left.created
        || right.row.id - left.row.id
    ).slice(0, safeLimit).map(({ row, distance }) => safeCenter ? {
        ...row,
        distance_km: distance === null ? null : Number(distance.toFixed(3))
    } : row);
}

module.exports = { fastSearch };
