const { db } = require('../../../infrastructure/database');
const { getUserPreference, queueUserVectorRefresh } = require('../../preferences/services/userPreferenceService');
const {
    SIMILARITY_SHARPNESS, placeMeanVector, compatibleProfile, prepareTasteProfile, tasteSimilarity, resetMeanVectorCache
} = require('./ratingSimilarity');
const { userRatingWeight } = require('./ratingReputation');

// 四档评价（见 ../doc/placeRatings.md）：4 强烈推荐、3 均线之上、2 均线之下、1 强烈拒绝。
const RATING_SCORES = Object.freeze([1, 2, 3, 4]);
const AVOID_TAG = '避雷';
// 综合评价落在“均线之下 / 强烈拒绝”（平均分 < 2.5）的地点按避雷处理；没人评价时沿用“避雷”标签。
const AVOID_BELOW_AVERAGE = 2.5;
const DEFAULT_DAILY_LIMIT = 10;
// 每日次数按北京时间（UTC+8，无夏令时）0 点重置。
const QUOTA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// With fewer other raters, any weighting just repeats their scores.
const MIN_PERSONALIZED_RATERS = 2;

// Aggregates for a Place row aliased `p`. Ratings by currently banned users are left out.
const RATING_COLUMNS_SQL = `
    (SELECT COUNT(*) FROM PlaceRating pr JOIN User pru ON pru.id = pr.user_id
        WHERE pr.place_id = p.id AND COALESCE(pru.is_banned, 0) = 0) AS rating_count,
    (SELECT ROUND(SUM(pr.weight * pr.score) / SUM(pr.weight), 4) FROM PlaceRating pr JOIN User pru ON pru.id = pr.user_id
        WHERE pr.place_id = p.id AND COALESCE(pru.is_banned, 0) = 0) AS rating_average`;

function fail(status, message) {
    throw Object.assign(new Error(message), { status, publicMessage: message });
}

function dailyLimit() {
    const value = Number.parseInt(process.env.PLACE_RATING_DAILY_LIMIT || '', 10);
    return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : DEFAULT_DAILY_LIMIT;
}

function validPlaceId(value) {
    const valid = (typeof value === 'string' && /^[1-9]\d*$/.test(value)) || typeof value === 'number';
    return valid && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

/** Strict 1–4 integer; anything else (strings, decimals, booleans) is rejected. */
function isValidScore(value) {
    return Number.isInteger(value) && RATING_SCORES.includes(value);
}

/** Nearest tier for an average (half-way points round up), or null without ratings. */
function ratingTier(average) {
    const value = Number(average);
    if (average === null || average === undefined || !Number.isFinite(value)) return null;
    return Math.max(1, Math.min(4, Math.floor(value + 0.5)));
}

function hasAvoidTag(category) {
    return String(category || '').includes(AVOID_TAG);
}

/** Avoided = rated into 均线之下 / 强烈拒绝; unrated places fall back to the 避雷 tag. */
function isAvoidedPlace(place) {
    if (!place) return false;
    const count = Number(place.rating_count) || 0;
    if (count > 0) return Number(place.rating_average) < AVOID_BELOW_AVERAGE;
    return hasAvoidTag(place.category);
}

/** The rating a creator gets when none is chosen: 避雷 → 强烈拒绝, otherwise 强烈推荐. */
function defaultCreationScore(category) {
    const names = Array.isArray(category) ? category : [category];
    return names.some(hasAvoidTag) ? 1 : 4;
}

/**
 * The creator's own rating for a place created by them. Synchronous so it runs
 * inside the caller's place-creation transaction; never counts toward the daily quota.
 */
function insertCreationRating(placeId, userId, score, now = Date.now()) {
    if (!userId || !isValidScore(score)) return;
    db._raw.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at, weight)
        SELECT ?, id, ?, 'create', ?, ?, ? FROM User WHERE id = ?
        ON CONFLICT(place_id, user_id) DO NOTHING`).run(placeId, score, now, now, userRatingWeight(userId), userId);
}

function quotaDay(now = Date.now()) {
    return new Date(now + QUOTA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function quotaResetsAt(now = Date.now()) {
    return (Math.floor((now + QUOTA_UTC_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - QUOTA_UTC_OFFSET_MS;
}

/** Places rated or re-rated today count once each; withdrawing gives nothing back. */
function ratingQuota(userId, placeId = null, now = Date.now()) {
    const day = quotaDay(now);
    const rows = db._raw.prepare(`SELECT DISTINCT place_id FROM PlaceRatingEvent
        WHERE user_id = ? AND quota_day = ? AND action = 'rate'`).all(userId, day);
    const limit = dailyLimit();
    const used = rows.length;
    return {
        limit,
        used,
        remaining: Math.max(0, limit - used),
        place_counted: placeId !== null && rows.some((row) => row.place_id === placeId),
        resets_at: quotaResetsAt(now)
    };
}

function ratingSummary(placeId) {
    const rows = db._raw.prepare(`SELECT r.score, COUNT(*) AS count, SUM(r.weight) AS weight
        FROM PlaceRating r JOIN User u ON u.id = r.user_id
        WHERE r.place_id = ? AND COALESCE(u.is_banned, 0) = 0
        GROUP BY r.score`).all(placeId);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let count = 0;
    let total = 0;
    let weightTotal = 0;
    for (const row of rows) {
        distribution[row.score] = row.count;
        count += row.count;
        total += row.score * row.weight;
        weightTotal += row.weight;
    }
    const average = weightTotal > 0 ? Math.round(total / weightTotal * 10000) / 10000 : null;
    return { count, average, tier: ratingTier(average), distribution };
}

/**
 * Weighted average of the OTHER raters' scores, each weighted by how close the
 * rater's taste vector is to the viewer's. Null when the viewer has no profile,
 * fewer than two others rated, or none of them has a profile (the number would
 * just repeat the public average).
 */
function personalizedSummary(placeId, viewerId, { readViewerPreference = getUserPreference } = {}) {
    const viewer = readViewerPreference(viewerId);
    if (!compatibleProfile(viewer) || !viewer.vector) return null;
    const mean = placeMeanVector();
    const viewerVector = prepareTasteProfile(viewer, mean);
    if (!viewerVector) return null;

    // Raters' stored profiles are read as-is; the background worker keeps them fresh.
    const raters = db._raw.prepare(`SELECT r.user_id, r.score, r.weight, up.vector, up.status, up.model, up.dimensions,
            up.algorithm_version, up.vector_place_count
        FROM PlaceRating r
        JOIN User u ON u.id = r.user_id
        LEFT JOIN UserPreference up ON up.user_id = r.user_id
        WHERE r.place_id = ? AND r.user_id <> ? AND COALESCE(u.is_banned, 0) = 0`).all(placeId, viewerId);
    if (raters.length < MIN_PERSONALIZED_RATERS) return null;
    let weightedTotal = 0;
    let weightTotal = 0;
    let matched = 0;
    for (const rater of raters) {
        const raterVector = prepareTasteProfile(rater, mean);
        if (raterVector) matched += 1;
        const weight = rater.weight * Math.exp(SIMILARITY_SHARPNESS * tasteSimilarity(viewerVector, raterVector));
        weightedTotal += weight * rater.score;
        weightTotal += weight;
    }
    if (!matched || weightTotal <= 0) return null;
    const average = Math.round(weightedTotal / weightTotal * 10000) / 10000;
    return { average, tier: ratingTier(average), matched_raters: matched, rater_count: raters.length };
}

function ownRating(placeId, userId) {
    const row = db._raw.prepare('SELECT score, source, updated_at FROM PlaceRating WHERE place_id = ? AND user_id = ?')
        .get(placeId, userId);
    return row ? { score: row.score, source: row.source, updated_at: row.updated_at } : null;
}

// A place still under moderation (doc/placeModeration.md) exists only for its creator.
function requirePlace(placeId, viewerId = null) {
    if (!validPlaceId(placeId)) fail(400, '无效的地点');
    const id = Number(placeId);
    if (!db._raw.prepare("SELECT id FROM Place WHERE id = ? AND (moderation_status = 'visible' OR creator_id = ?)").get(id, viewerId)) fail(404, '地点不存在');
    return id;
}

/** Everything the rating panel shows. `viewer` is the authenticated user or null for guests. */
function ratingState(placeId, viewer = null) {
    const id = requirePlace(placeId, viewer ? viewer.id : null);
    const state = { place_id: id, summary: ratingSummary(id), mine: null, personalized: null, quota: null };
    if (!viewer) return state;
    state.mine = ownRating(id, viewer.id);
    state.quota = ratingQuota(viewer.id, id);
    try {
        state.personalized = personalizedSummary(id, viewer.id);
    } catch (error) {
        // The public summary stays available when profiles or vectors cannot be read.
        console.warn('Personalized rating unavailable:', error.message);
    }
    return state;
}

const rateTransaction = db._raw.transaction((userId, placeId, score, now) => {
    if (!db._raw.prepare("SELECT id FROM Place WHERE id = ? AND (moderation_status = 'visible' OR creator_id = ?)").get(placeId, userId)) fail(404, '地点不存在');
    const current = db._raw.prepare('SELECT score FROM PlaceRating WHERE place_id = ? AND user_id = ?').get(placeId, userId);
    if (current && current.score === score) return false;
    const quota = ratingQuota(userId, placeId, now);
    if (!quota.place_counted && quota.used >= quota.limit) {
        fail(429, `今天已经评价了 ${quota.limit} 家店，明天再来吧`);
    }
    db._raw.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at, weight)
        VALUES (?, ?, ?, 'user', ?, ?, ?)
        ON CONFLICT(place_id, user_id) DO UPDATE SET score = excluded.score, source = 'user',
            updated_at = excluded.updated_at, weight = excluded.weight`)
        .run(placeId, userId, score, now, now, userRatingWeight(userId));
    db._raw.prepare(`INSERT INTO PlaceRatingEvent (user_id, place_id, action, score, quota_day, occurred_at)
        VALUES (?, ?, 'rate', ?, ?, ?)`).run(userId, placeId, score, quotaDay(now), now);
    return true;
});

function ratePlace(user, placeId, score) {
    const id = requirePlace(placeId, user.id);
    if (!isValidScore(score)) fail(400, '请选择一个评价');
    // The acting user always comes from authentication, never from the request body.
    const changed = rateTransaction.immediate(user.id, id, score, Date.now());
    if (changed) queueUserVectorRefresh(user.id);
    return ratingState(id, user);
}

const withdrawTransaction = db._raw.transaction((userId, placeId, now) => {
    const removed = db._raw.prepare('DELETE FROM PlaceRating WHERE place_id = ? AND user_id = ?').run(placeId, userId);
    if (!removed.changes) return false;
    db._raw.prepare(`INSERT INTO PlaceRatingEvent (user_id, place_id, action, score, quota_day, occurred_at)
        VALUES (?, ?, 'withdraw', NULL, ?, ?)`).run(userId, placeId, quotaDay(now), now);
    return true;
});

function withdrawRating(user, placeId) {
    const id = requirePlace(placeId, user.id);
    if (withdrawTransaction.immediate(user.id, id, Date.now())) queueUserVectorRefresh(user.id);
    return ratingState(id, user);
}

module.exports = {
    RATING_SCORES,
    RATING_COLUMNS_SQL,
    AVOID_BELOW_AVERAGE,
    SIMILARITY_SHARPNESS,
    isValidScore,
    ratingTier,
    isAvoidedPlace,
    defaultCreationScore,
    insertCreationRating,
    quotaDay,
    quotaResetsAt,
    ratingQuota,
    ratingSummary,
    personalizedSummary,
    ratingState,
    ratePlace,
    withdrawRating,
    dailyLimit,
    resetMeanVectorCache
};
