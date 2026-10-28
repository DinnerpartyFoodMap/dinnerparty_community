// Async numeric API migration: assertions unchanged; await remote computations.
(async()=>{
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-ratings-'));
process.env.DB_FILE = path.join(tempDirectory, 'ratings.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.PLACE_RATING_DAILY_LIMIT = '3';
// Real JWT/user checks through the existing Redis-unavailable path; no external services.
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const database = require('../../infrastructure/database');
const { db, init } = database;
const { EMBEDDING_DIMENSIONS } = require('../../infrastructure/aiClients');
const ratings = require('../../modules/ratings/services/placeRatings');
const preferences = require('../../modules/preferences/services/userPreferenceService');
const { initPlaceRatingSchema } = require('../../modules/ratings/services/placeRatingSchema');
const { initUserPreferenceSchema } = require('../../modules/preferences/services/userPreferenceSchema');
const placeService = require('../../modules/places/services/placeService');
const { nearbyCandidates } = require('../../modules/discovery/services/randomRecommendation');
const { rankSemanticRows } = require('../../modules/discovery/services/semanticSearch');
const sql = db._raw;
function makeUser(name, { banned = false } = {}) {
    const id = randomUUID();
    sql.prepare('INSERT INTO User(id, username, password, is_banned) VALUES (?, ?, ?, ?)').run(id, name, 'unused', banned ? 1 : 0);
    return id;
}
function makePlace(name, { category = '测试分类', creator = null, lat = 0, lng = 0 } = {}) {
    return Number(sql.prepare('INSERT INTO Place(name, category, creator_id, latitude, longitude) VALUES (?, ?, ?, ?, ?)')
        .run(name, category, creator, lat, lng).lastInsertRowid);
}
function rate(placeId, userId, score) {
    sql.prepare(`INSERT INTO PlaceRating(place_id, user_id, score, source, created_at, updated_at) VALUES (?, ?, ?, 'user', 0, 0)
        ON CONFLICT(place_id, user_id) DO UPDATE SET score = excluded.score`).run(placeId, userId, score);
}
function putVector(placeId, axis) {
    const values = new Float32Array(EMBEDDING_DIMENSIONS);
    values[axis] = 1;
    sql.prepare('DELETE FROM place_vectors WHERE place_id = ?').run(BigInt(placeId));
    sql.prepare('INSERT INTO place_vectors(place_id, embedding) VALUES (?, ?)').run(BigInt(placeId), Buffer.from(values.buffer));
    sql.prepare('UPDATE Place SET has_vector = 1, vector_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(placeId);
}
function testPureRules() {
    assert.equal(ratings.ratingTier(null), null);
    assert.equal(ratings.ratingTier(1), 1);
    assert.equal(ratings.ratingTier(1.49), 1);
    assert.equal(ratings.ratingTier(1.5), 2, 'half-way rounds up to the better tier');
    assert.equal(ratings.ratingTier(2.5), 3);
    assert.equal(ratings.ratingTier(3.5), 4);
    assert.equal(ratings.ratingTier(4), 4);
    for (const bad of [0, 5, 2.5, '4', true, null, undefined])
        assert.equal(ratings.isValidScore(bad), false, `rejects ${bad}`);
    assert.equal(ratings.defaultCreationScore('快餐, 避雷'), 1);
    assert.equal(ratings.defaultCreationScore(['火锅']), 4);
    assert.equal(ratings.defaultCreationScore(''), 4);
    // Ratings decide once anyone has rated; the 避雷 tag only covers unrated places.
    assert.equal(ratings.isAvoidedPlace({ category: '避雷', rating_count: 0, rating_average: null }), true);
    assert.equal(ratings.isAvoidedPlace({ category: '避雷', rating_count: 3, rating_average: 3.2 }), false);
    assert.equal(ratings.isAvoidedPlace({ category: '火锅', rating_count: 2, rating_average: 2.49 }), true);
    assert.equal(ratings.isAvoidedPlace({ category: '火锅', rating_count: 2, rating_average: 2.5 }), false);
    // Beijing-time quota day: 2026-10-14 23:59 +08 and 2026-10-15 00:00 +08.
    const beforeMidnight = Date.UTC(2026, 9, 14, 15, 59);
    assert.equal(ratings.quotaDay(beforeMidnight), '2026-10-14');
    assert.equal(ratings.quotaDay(beforeMidnight + 60000), '2026-10-15');
    assert.equal(ratings.quotaResetsAt(beforeMidnight), beforeMidnight + 60000);
}
function testMigrationSeed() {
    const creator = makeUser('seed-creator');
    const gone = makeUser('seed-gone');
    const goodPlace = makePlace('老字号', { category: '面食', creator });
    const avoidPlace = makePlace('踩雷店', { category: '快餐, 避雷', creator });
    const orphanPlace = makePlace('无主店', { creator: gone });
    sql.prepare('DELETE FROM User WHERE id = ?').run(gone);
    // Simulate an existing database that predates ratings.
    sql.exec('DROP TABLE PlaceRating; DROP TABLE PlaceRatingEvent;');
    initPlaceRatingSchema(sql);
    initUserPreferenceSchema(sql);
    const seeded = sql.prepare('SELECT place_id, user_id, score, source FROM PlaceRating ORDER BY place_id').all();
    assert.deepEqual(seeded, [
        { place_id: goodPlace, user_id: creator, score: 4, source: 'migration' },
        { place_id: avoidPlace, user_id: creator, score: 1, source: 'migration' }
    ], '避雷 → 强烈拒绝, others → 强烈推荐, missing creators are skipped');
    assert.ok(!seeded.some((row) => row.place_id === orphanPlace));
    // The seed runs only when the table is first created: a withdrawn seed stays withdrawn.
    sql.prepare('DELETE FROM PlaceRating WHERE place_id = ?').run(goodPlace);
    initPlaceRatingSchema(sql);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRating WHERE place_id = ?').get(goodPlace).n, 0);
    assert.equal(sql.prepare('SELECT dirty FROM UserPreference WHERE user_id = ?').get(creator).dirty, 1, 'seeded raters get a profile row so the worker builds their vector');
    sql.prepare('DELETE FROM Place WHERE id IN (?, ?, ?)').run(goodPlace, avoidPlace, orphanPlace);
}
async function testCreationRatings() {
    const creator = makeUser('creator');
    const plain = await placeService.createPlace({ name: '新店', latitude: 1, longitude: 1, category: '火锅' }, creator, { source: 'web' });
    const avoid = await placeService.createPlace({ name: '雷店', latitude: 1, longitude: 1, category: '火锅, 避雷' }, creator, { source: 'web' });
    const chosen = await placeService.createPlace({ name: '一般店', latitude: 1, longitude: 1, category: '避雷', rating: 3 }, creator, { source: 'web' });
    assert.deepEqual([plain, avoid, chosen].map((place) => [place.rating_count, place.rating_average]), [[1, 4], [1, 1], [1, 3]], 'creation responses carry the creator rating aggregate');
    assert.equal(sql.prepare('SELECT source FROM PlaceRating WHERE place_id = ?').get(plain.id).source, 'create');
    for (const rating of [0, 5, '4', 2.5]) {
        await assert.rejects(async () => await placeService.createPlace({ name: 'x', latitude: 1, longitude: 1, rating }, creator, { source: 'web' }), (error) => error.status === 400 && error.publicMessage === '评价无效');
    }
    // QQ Bot path: insertPlaceSync inside the caller's transaction, default rule applies.
    const validated = placeService.validateNewPlace({ name: '机器人店', latitude: 2, longitude: 2, category: '避雷' });
    const botPlace = sql.transaction(() => placeService.insertPlaceSync(validated.value, creator, { source: 'qq_bot' })).immediate();
    assert.equal(sql.prepare('SELECT score FROM PlaceRating WHERE place_id = ?').get(botPlace).score, 1);
    assert.equal(ratings.ratingQuota(creator).used, 0, 'creation ratings never use the daily quota');
    // Diary-created markers use the same default.
    const { createPlace: createDiaryPlace } = require('../../modules/journeys/services/journeyMapLinks');
    const made = sql.transaction(() => createDiaryPlace(creator, { name: '日记店', category: '甜品', lat: 3, lng: 3 }, {})).immediate();
    assert.equal(sql.prepare('SELECT score FROM PlaceRating WHERE place_id = ?').get(made.place_id).score, 4);
}
async function testWeightedSummaries() {
    const place = makePlace('贡献加权店');
    const trusted = makeUser('weighted-trusted');
    const newcomer = makeUser('weighted-new');
    rate(place, trusted, 4);
    rate(place, newcomer, 1);
    sql.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?').run(1.2, place, trusted);
    sql.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?').run(0.4, place, newcomer);
    const summary = await ratings.ratingSummary(place);
    assert.equal(summary.average, 3.25, 'public scores use rating weights rather than head counts');
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.distribution, { 1: 1, 2: 0, 3: 0, 4: 1 }, 'distribution still counts people');
    const row = sql.prepare(`SELECT ${ratings.RATING_COLUMNS_SQL} FROM Place p WHERE p.id = ?`).get(place);
    assert.equal(row.rating_average, summary.average, 'map/search aggregates match the panel');
    assert.equal(row.rating_count, 2);
    assert.equal(ratings.isAvoidedPlace(row), false, 'avoidance uses the weighted public score');
    sql.prepare('DELETE FROM Place WHERE id = ?').run(place);
}
async function testPersonalization() {
    // Two taste clusters on separate axes. Five places each give full profile reliability.
    const noodle = Array.from({ length: 5 }, (_, i) => makePlace(`面馆${i}`));
    const dessert = Array.from({ length: 5 }, (_, i) => makePlace(`甜品${i}`));
    const other = Array.from({ length: 5 }, (_, i) => makePlace(`其他${i}`));
    noodle.forEach((id) => putVector(id, 0));
    dessert.forEach((id) => putVector(id, 1));
    other.forEach((id, i) => putVector(id, 2 + i));
    ratings.resetMeanVectorCache();
    const viewer = makeUser('viewer-noodle');
    const twin = makeUser('rater-noodle');
    const opposite = makeUser('rater-dessert');
    const blank = makeUser('rater-without-profile');
    const dessertViewer = makeUser('viewer-dessert');
    for (const user of [viewer, twin])
        noodle.forEach((id) => sql.prepare('INSERT INTO Favorite(user_id, place_id) VALUES (?, ?)').run(user, id));
    for (const user of [opposite, dessertViewer])
        dessert.forEach((id) => sql.prepare('INSERT INTO Favorite(user_id, place_id) VALUES (?, ?)').run(user, id));
    for (const user of [viewer, twin, opposite, dessertViewer])
        assert.equal((await preferences.getUserPreference(user)).status, 'ready');
    const target = makePlace('争议店');
    rate(target, twin, 4);
    rate(target, opposite, 1);
    rate(target, viewer, 1);
    const publicSummary = await ratings.ratingSummary(target);
    assert.equal(publicSummary.count, 3);
    assert.equal(publicSummary.average, 2);
    assert.deepEqual(publicSummary.distribution, { 1: 2, 2: 0, 3: 0, 4: 1 });
    const mine = await ratings.personalizedSummary(target, viewer);
    assert.equal(mine.rater_count, 2, "the viewer's own rating is left out");
    assert.equal(mine.matched_raters, 2);
    assert.ok(mine.average > 3.5, `a same-taste rater dominates: ${mine.average}`);
    assert.equal(mine.tier, 4);
    const theirs = await ratings.personalizedSummary(target, dessertViewer);
    assert.ok(theirs.average < 2, `the opposite viewer leans the other way: ${theirs.average}`);
    // Reputation/time weights multiply taste weights; the viewer is still excluded.
    sql.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?').run(0.001, target, twin);
    sql.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?').run(1, target, opposite);
    sql.prepare('UPDATE PlaceRating SET weight = ? WHERE place_id = ? AND user_id = ?').run(100, target, viewer);
    const reputationWeighted = await ratings.personalizedSummary(target, viewer);
    assert.ok(reputationWeighted.average < 1.5, 'a small rating weight can outweigh even a strong taste match');
    assert.equal(reputationWeighted.rater_count, 2, 'even a large own weight never enters the taste average');
    sql.prepare('UPDATE PlaceRating SET weight = 0.5 WHERE place_id = ?').run(target);
    // Raters without a profile count with a neutral weight.
    rate(target, blank, 4);
    const withBlank = await ratings.personalizedSummary(target, dessertViewer);
    assert.equal(withBlank.rater_count, 4, 'a viewer who has not rated sees every rater');
    assert.equal(withBlank.matched_raters, 3);
    assert.ok(withBlank.average > theirs.average);
    // No personalization without a viewer profile or with fewer than two other raters.
    assert.equal(await ratings.personalizedSummary(target, blank), null);
    const lonely = makePlace('只有一人评');
    rate(lonely, twin, 2);
    assert.equal(await ratings.personalizedSummary(lonely, viewer), null);
    // Rating vector inputs (algorithm v2): 强烈推荐 adds weight, a dislike removes the place entirely.
    const rater = makeUser('vector-rater');
    rate(noodle[0], rater, 4);
    let profile = await preferences.getUserPreference(rater);
    assert.equal(profile.algorithm_version, 2);
    assert.equal(profile.total_weight,5);
    rate(noodle[1], rater, 3);
    profile = await preferences.getUserPreference(rater);
    assert.equal(profile.total_weight,7);
    sql.prepare('INSERT INTO Favorite(user_id, place_id) VALUES (?, ?)').run(rater, dessert[0]);
    rate(dessert[0], rater, 2);
    profile = await preferences.getUserPreference(rater);
    assert.equal(profile.source_place_count, 2, 'a disliked place is not an interest source even when favorited');
    return { target, twin, viewer };
}
async function testHttp({ target, twin }) {
    const app = express();
    app.use(express.json());
    app.use('/api/ratings', require('../../modules/ratings/routes/placeRatings'));
    app.use('/places', require('../../modules/places/routes/places'));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const request = async (route, method = 'GET', body, userId = null) => {
            const headers = { 'Content-Type': 'application/json' };
            if (userId)
                headers.Authorization = `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET || 'yuyuko_secret_key', { expiresIn: 3600 })}`;
            const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, headers: response.headers, body: await response.json() };
        };
        const alice = makeUser('http-alice');
        const places = Array.from({ length: 5 }, (_, i) => makePlace(`可评店${i}`, { lat: 30, lng: 120 + i * 0.001 }));
        // Guests read the public summary only; a bad token is rejected rather than ignored.
        const guest = await request(`/api/ratings/places/${target}`);
        assert.equal(guest.status, 200);
        assert.equal(guest.headers.get('cache-control'), 'no-store');
        assert.equal(guest.body.summary.count, 4);
        assert.equal(guest.body.mine, null);
        assert.equal(guest.body.personalized, null);
        assert.equal(guest.body.quota, null);
        const badToken = await fetch(`${base}/api/ratings/places/${target}`, { headers: { Authorization: 'Bearer nope' } });
        assert.equal(badToken.status, 401);
        assert.equal((await request('/api/ratings/places/abc')).status, 400);
        assert.equal((await request('/api/ratings/places/999999')).status, 404);
        assert.equal((await request(`/api/ratings/places/${places[0]}`, 'PUT', { score: 4 })).status, 401);
        const own = await request(`/api/ratings/places/${target}`, 'GET', undefined, twin);
        assert.equal(own.body.mine.score, 4);
        assert.equal(own.body.quota.limit, 3);
        for (const score of [0, 5, '4', 2.5, null]) {
            assert.equal((await request(`/api/ratings/places/${places[0]}`, 'PUT', { score }, alice)).status, 400, `rejects ${score}`);
        }
        // Rate, change the same place again (counts once), repeat the same score (no-op).
        let result = await request(`/api/ratings/places/${places[0]}`, 'PUT', { score: 4 }, alice);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.mine && result.body.mine.score, 4);
        assert.equal(result.body.summary.count, 1);
        assert.equal(result.body.quota.used, 1);
        result = await request(`/api/ratings/places/${places[0]}`, 'PUT', { score: 2 }, alice);
        assert.equal(result.body.summary.average, 2);
        assert.equal(result.body.quota.used, 1, 're-rating the same place today counts once');
        assert.equal(result.body.quota.place_counted, true);
        await request(`/api/ratings/places/${places[0]}`, 'PUT', { score: 2 }, alice);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRatingEvent WHERE user_id = ?').get(alice).n, 2, 'unchanged scores are not logged');
        // Daily limit (3 here): a 4th new place is refused, re-rating a counted one still works.
        await request(`/api/ratings/places/${places[1]}`, 'PUT', { score: 3 }, alice);
        result = await request(`/api/ratings/places/${places[2]}`, 'PUT', { score: 3 }, alice);
        assert.equal(result.body.quota.remaining, 0);
        result = await request(`/api/ratings/places/${places[3]}`, 'PUT', { score: 4 }, alice);
        assert.equal(result.status, 429);
        assert.match(result.body.error, /今天已经评价了 3 家店/);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRating WHERE place_id = ?').get(places[3]).n, 0);
        assert.equal((await request(`/api/ratings/places/${places[1]}`, 'PUT', { score: 1 }, alice)).status, 200);
        // Withdrawing works at the limit but does not hand quota back.
        result = await request(`/api/ratings/places/${places[2]}`, 'DELETE', undefined, alice);
        assert.equal(result.status, 200);
        assert.equal(result.body.mine, null);
        assert.equal(result.body.summary.count, 0);
        assert.equal(result.body.quota.used, 3);
        assert.equal((await request(`/api/ratings/places/${places[3]}`, 'PUT', { score: 4 }, alice)).status, 429);
        // The next Beijing day starts a fresh quota.
        const realNow = Date.now;
        try {
            Date.now = () => ratings.quotaResetsAt(realNow()) + 1000;
            result = await request(`/api/ratings/places/${places[3]}`, 'PUT', { score: 4 }, alice);
            assert.equal(result.status, 200);
            assert.equal(result.body.quota.used, 1);
        }
        finally {
            Date.now = realNow;
        }
        // Banned users cannot rate, and their existing ratings drop out of every aggregate.
        const troll = makeUser('troll');
        rate(places[4], troll, 1);
        rate(places[4], alice, 4);
        assert.equal((await ratings.ratingSummary(places[4])).average, 2.5);
        sql.prepare("UPDATE User SET is_banned = 1, ban_reason = '刷分' WHERE id = ?").run(troll);
        assert.equal((await request(`/api/ratings/places/${places[0]}`, 'PUT', { score: 1 }, troll)).status, 403);
        assert.equal((await ratings.ratingSummary(places[4])).average, 4);
        // Map queries carry the aggregate that decides the 避雷 icon.
        const nearby = await request('/places/nearby?minLng=119&minLat=29&maxLng=121&maxLat=31');
        const nearbyPlace = nearby.body.find((place) => place.id === places[4]);
        assert.equal(nearbyPlace.rating_count, 1);
        assert.equal(nearbyPlace.rating_average, 4);
        const single = await request(`/places/${places[0]}`);
        assert.equal(single.body.rating_average, 2);
        const created = await request('/places', 'POST', { name: '表单新店', latitude: 30, longitude: 120, category: '避雷', rating: 3 }, alice);
        assert.equal(created.status, 200);
        assert.equal(created.body.rating_average, 3);
        assert.equal((await request('/places', 'POST', { name: '坏评价', latitude: 30, longitude: 120, rating: 9 }, alice)).status, 400);
    }
    finally {
        await new Promise((resolve) => server.close(resolve));
    }
}
async function testAvoidedFilters() {
    const center = { lat: 10, lng: 10 };
    const creator = makeUser('filter-creator');
    const fan = makeUser('filter-fan');
    const taggedButLiked = makePlace('标签避雷但大家喜欢', { category: '避雷', creator, lat: 10, lng: 10 });
    const untaggedButDisliked = makePlace('没标签但被拒绝', { category: '火锅', lat: 10, lng: 10.001 });
    const taggedUnrated = makePlace('标签避雷且无人评价', { category: '避雷', lat: 10, lng: 10.002 });
    const normal = makePlace('普通店', { category: '火锅', lat: 10, lng: 10.003 });
    rate(taggedButLiked, creator, 1);
    rate(taggedButLiked, fan, 4);
    rate(taggedButLiked, makeUser('filter-fan-2'), 4);
    rate(untaggedButDisliked, fan, 1);
    const ids = (await nearbyCandidates(sql, center)).map(({ place }) => place.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [taggedButLiked, normal], 'random picks follow the rating, then the tag');
    const rows = [taggedButLiked, untaggedButDisliked, taggedUnrated, normal].map((id) => ({
        ...sql.prepare(`SELECT p.*, ${ratings.RATING_COLUMNS_SQL} FROM Place p WHERE p.id = ?`).get(id),
        vector_distance: 0.01
    }));
    const ranked = rankSemanticRows(rows, { center, limit: 10 }).map((match) => match.place.id).sort((a, b) => a - b);
    assert.deepEqual(ranked, [taggedButLiked, normal], 'AI recommendations skip avoided places by the same rule');
}
function testCascades() {
    const user = makeUser('leaver');
    const place = makePlace('即将删除');
    const kept = makePlace('保留');
    rate(place, user, 4);
    rate(kept, user, 4);
    sql.prepare(`INSERT INTO PlaceRatingEvent(user_id, place_id, action, score, quota_day, occurred_at) VALUES (?, ?, 'rate', 4, ?, ?)`)
        .run(user, place, ratings.quotaDay(), Date.now());
    sql.prepare('DELETE FROM Place WHERE id = ?').run(place);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRating WHERE place_id = ?').get(place).n, 0);
    assert.equal(ratings.ratingQuota(user).used, 1, 'a deleted place does not refund the quota');
    sql.prepare('DELETE FROM User WHERE id = ?').run(user);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRating WHERE user_id = ?').get(user).n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceRatingEvent WHERE user_id = ?').get(user).n, 0);
}
async function main() {
    try {
        init();
        init();
        assert.ok(database.isVectorSearchAvailable(), 'the installed sqlite-vec extension is required for vector tests');
        testPureRules();
        testMigrationSeed();
        await testCreationRatings();
        await testWeightedSummaries();
        const context = await testPersonalization();
        await testHttp(context);
        await testAvoidedFilters();
        testCascades();
        console.log('Place rating tests passed: tiers, migration seed, creation defaults, quota, withdrawal, bans, taste weighting, vector v2, map fields, 避雷 filters and cascades.');
    }
    finally {
        db.close();
        for (const suffix of ['', '-wal', '-shm']) {
            const file = process.env.DB_FILE + suffix;
            if (fs.existsSync(file))
                fs.unlinkSync(file);
        }
        fs.rmdirSync(tempDirectory);
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

})().catch(error=>{console.error(error);process.exitCode=1;});
