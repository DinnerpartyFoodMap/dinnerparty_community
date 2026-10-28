// Async numeric API migration: assertions unchanged; await remote computations.
(async()=>{
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-reputation-'));
process.env.DB_FILE = path.join(directory, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
const { db, init } = require('../../infrastructure/database');
const service = require('../../modules/ratings/services/ratingReputation');
const ratings = require('../../modules/ratings/services/placeRatings');
const DAY_MS=86400000; // Time fixture; reputation formulas are exercised in the private suite.
const sql = db._raw;
const now = Date.UTC(2026, 9, 15, 4);
try {
    init();
    sql.prepare("INSERT INTO User(id, username, password) VALUES ('alice', 'alice', 'unused'), ('bob', 'bob', 'unused')").run();
    sql.prepare("INSERT INTO Place(id, name, category) VALUES (1, 'old', '面馆'), (2, 'new', '面馆')").run();
    sql.prepare(`INSERT INTO PlaceRating(place_id, user_id, score, source, created_at, updated_at)
        VALUES (1, 'alice', 4, 'user', ?, ?)`).run(now - 30 * DAY_MS, now - 30 * DAY_MS);
    assert.equal(service.userRatingWeight('alice'), 0.5, 'a new user has neutral consistency and baseline contribution');
    assert.equal(await service.refreshRatingWeightsIfNeeded(now), true, 'missing batch state catches up on startup');
    const alice = sql.prepare("SELECT * FROM UserReputation WHERE user_id = 'alice'").get();
    assert.equal(alice.gamma, 1, 'without two other active raters consistency stays neutral');
    assert.ok(Math.abs(alice.beta - 0.5099006633466224) < 1e-12, 'one other-owned rating contributes P = 0.1');
    assert.equal(alice.evidence, 0);
    assert.equal(alice.updated_at, now);
    assert.equal(sql.prepare('SELECT weight FROM PlaceRating WHERE place_id = 1').get().weight, alice.weight, '30 days has no time discount');
    assert.equal(await service.refreshRatingWeightsIfNeeded(now + DAY_MS - 1), false, 'recent batches are reused');
    assert.equal(await service.refreshRatingWeightsIfNeeded(now + DAY_MS), true, 'exactly 24 hours triggers the next batch');
    assert.ok(sql.prepare('SELECT weight FROM PlaceRating WHERE place_id = 1').get().weight < alice.weight, 'older ratings decay after the first month');
    const realNow = Date.now;
    Date.now = () => now + DAY_MS + 1000;
    try {
        let state = await ratings.ratePlace({ id: 'alice' }, 2, 3);
        assert.equal(state.mine.score, 3);
        let row = sql.prepare("SELECT * FROM PlaceRating WHERE place_id = 2 AND user_id = 'alice'").get();
        assert.equal(row.weight, alice.weight, 'a fresh rating uses the persisted W with tau = 1');
        assert.equal(row.updated_at, Date.now());
        sql.prepare("UPDATE PlaceRating SET weight = 0.2 WHERE place_id = 2 AND user_id = 'alice'").run();
        Date.now = () => now + DAY_MS + 2000;
        state = await ratings.ratePlace({ id: 'alice' }, 2, 3);
        row = sql.prepare("SELECT * FROM PlaceRating WHERE place_id = 2 AND user_id = 'alice'").get();
        assert.equal(row.weight, 0.2, 'resubmitting the same score cannot refresh its time weight');
        assert.equal(row.updated_at, now + DAY_MS + 1000);
        await ratings.ratePlace({ id: 'alice' }, 2, 1);
        row = sql.prepare("SELECT * FROM PlaceRating WHERE place_id = 2 AND user_id = 'alice'").get();
        assert.equal(row.weight, alice.weight, 'changing a score resets tau');
        assert.equal(row.created_at, now + DAY_MS + 1000, 're-rating preserves creation time');
        assert.equal(row.updated_at, Date.now());
        sql.prepare("INSERT INTO Place(id, name, creator_id) VALUES (3, 'created', 'alice')").run();
        ratings.insertCreationRating(3, 'alice', 4);
        assert.equal(sql.prepare('SELECT weight FROM PlaceRating WHERE place_id = 3').get().weight, alice.weight, 'all creation paths use the current reputation weight too');
        await ratings.ratePlace({ id: 'bob' }, 2, 4);
    }
    finally {
        Date.now = realNow;
    }
    const before = sql.prepare('SELECT * FROM RatingWeightRefresh').get();
    const beforeWeights = sql.prepare('SELECT * FROM UserReputation ORDER BY user_id').all();
    sql.exec(`CREATE TRIGGER test_fail_weight BEFORE UPDATE OF weight ON PlaceRating
        BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
    await assert.rejects(async () => await service.refreshRatingWeights(now + 2 * DAY_MS), /test rollback/);
    assert.deepEqual(sql.prepare('SELECT * FROM RatingWeightRefresh').get(), before, 'failed refresh does not advance freshness');
    assert.deepEqual(sql.prepare('SELECT * FROM UserReputation ORDER BY user_id').all(), beforeWeights, 'reputations and rating weights publish in one atomic transaction');
    sql.exec('DROP TRIGGER test_fail_weight');
    sql.prepare("UPDATE User SET is_banned = 1 WHERE id = 'alice'").run();
    assert.equal((await ratings.ratingSummary(2)).average, 4, 'banned ratings disappear immediately, before the next batch');
    await service.refreshRatingWeights(now + 2 * DAY_MS);
    assert.equal(sql.prepare("SELECT * FROM UserReputation WHERE user_id = 'alice'").get(), undefined);
    assert.equal(sql.prepare("SELECT gamma FROM UserReputation WHERE user_id = 'bob'").get().gamma, 1);
    sql.prepare("DELETE FROM User WHERE id = 'bob'").run();
    assert.equal(sql.prepare("SELECT * FROM UserReputation WHERE user_id = 'bob'").get(), undefined);
    console.log('Rating reputation integration passed: refresh cadence, weights, re-rating, bans, cascades and atomic publication.');
}
finally {
    // The API queues profile work; cancel it before closing the temporary DB.
    require('../../modules/preferences/services/userPreferenceService').startUserVectorWorker()();
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        const file = process.env.DB_FILE + suffix;
        if (fs.existsSync(file))
            fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
}

})().catch(error=>{console.error(error);process.exitCode=1;});
