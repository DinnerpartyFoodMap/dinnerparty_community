const { db, isVectorSearchAvailable } = require('../../../infrastructure/database');
const { DAY_MS, timeDecay, calculateReputations } = require('./ratingWeightModel');
const { placeMeanVector, prepareTasteProfile, tasteSimilarity } = require('./ratingSimilarity');

function userRatingWeight(userId) {
    return db._raw.prepare('SELECT weight FROM UserReputation WHERE user_id = ?').get(userId)?.weight ?? 0.5;
}

const refreshTransaction = db._raw.transaction((now) => {
    const users = db._raw.prepare('SELECT id, is_banned FROM User').all();
    const places = db._raw.prepare(`SELECT id, creator_id, description, category, per_person_cost,
        exterior_images, menu_images FROM Place`).all();
    const ratings = db._raw.prepare('SELECT place_id, user_id, score, source, updated_at FROM PlaceRating').all();
    const favorites = db._raw.prepare('SELECT user_id, place_id FROM Favorite').all();
    const requests = db._raw.prepare("SELECT requester_id, status FROM PlaceRequest WHERE status = 'approved'").all();
    const profiles = new Map();
    if (isVectorSearchAvailable()) {
        // Missing/obsolete profiles stay neutral, just as in the public taste score.
        const mean = placeMeanVector(now);
        for (const row of db._raw.prepare('SELECT * FROM UserPreference').all()) {
            profiles.set(row.user_id, prepareTasteProfile(row, mean));
        }
    }
    const reputations = calculateReputations({
        users, places, ratings, favorites, requests,
        similarity: (left, right) => tasteSimilarity(profiles.get(left), profiles.get(right))
    }, now);

    db._raw.prepare('DELETE FROM UserReputation').run();
    const save = db._raw.prepare(`INSERT INTO UserReputation
        (user_id, beta, gamma, weight, contribution, evidence, rating_count, agreement, updated_at)
        VALUES (@user_id, @beta, @gamma, @weight, @contribution, @evidence, @rating_count, @agreement, @updated_at)`);
    for (const row of reputations.values()) save.run({ ...row, updated_at: now });
    const update = db._raw.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?');
    for (const rating of ratings) {
        update.run((reputations.get(rating.user_id)?.weight ?? 0.5) * timeDecay(rating.updated_at, now),
            rating.place_id, rating.user_id);
    }
    db._raw.prepare(`INSERT INTO RatingWeightRefresh(id, updated_at) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(now);
    return reputations.size;
});

function refreshRatingWeights(now = Date.now()) {
    return refreshTransaction.immediate(now);
}

function refreshRatingWeightsIfNeeded(now = Date.now()) {
    const last = db._raw.prepare('SELECT updated_at FROM RatingWeightRefresh WHERE id = 1').get();
    if (last && now >= last.updated_at && now - last.updated_at < DAY_MS) return false;
    refreshRatingWeights(now);
    return true;
}

function startRatingReputationWorker() {
    // Synchronous startup catch-up publishes all weights before the first request.
    refreshRatingWeightsIfNeeded();
    const interval = setInterval(() => {
        try { refreshRatingWeightsIfNeeded(); }
        catch (error) { console.warn('Rating reputation refresh failed:', error.message); }
    }, 60000);
    interval.unref?.();
    return () => clearInterval(interval);
}

module.exports = { userRatingWeight, refreshRatingWeights, refreshRatingWeightsIfNeeded, startRatingReputationWorker };
