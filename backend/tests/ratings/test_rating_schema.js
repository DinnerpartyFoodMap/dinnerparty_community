const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initPlaceRatingSchema } = require('../../modules/ratings/services/placeRatingSchema');

function withDatabase(test) {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE User (id TEXT PRIMARY KEY);
        CREATE TABLE Place (id INTEGER PRIMARY KEY, creator_id TEXT, category TEXT, created_time TEXT);
        INSERT INTO User(id) VALUES ('creator');`);
    try { test(database); } finally { database.close(); }
}

function testMigrationDates() {
    withDatabase((database) => {
        const cases = [
            ['3/19/2025 17:23', '2025-03-19T09:23:00.000Z'],
            ['3/19/2025 17:23:45', '2025-03-19T09:23:45.000Z'],
            ['2/29/2024 0:05', '2024-02-28T16:05:00.000Z'],
            ['2025-03-19 17:23:45', '2025-03-19T17:23:45.000Z'],
            ['2025-03-19T17:23:45.123Z', '2025-03-19T17:23:45.123Z'],
            ['2025-03-19T17:23:45+08:00', '2025-03-19T09:23:45.000Z'],
            ['2025-03-19', '2025-03-19T00:00:00.000Z'],
            ['2025-03-19T17:23:45', '2025-03-19T17:23:45.000Z'],
            ['2/29/2025 17:23', null],
            ['4/31/2025 17:23', null],
            ['2025-02-30 17:23:45', null],
            ['2025-13-01T17:23:45Z', null],
            ['3/19/2025 24:23', null],
            ['3/19/2025 17:60', null],
            ['2025-03-19T17:23:45+24:00', null],
            ['unreadable', null],
            [null, null]
        ];
        const insert = database.prepare('INSERT INTO Place(id, creator_id, category, created_time) VALUES (?, ?, ?, ?)');
        cases.forEach(([createdAt], index) => insert.run(index + 1, 'creator', index === 1 ? '面馆, 避雷' : '面馆', createdAt));
        insert.run(100, 'deleted-account', '面馆', '2025-03-19 17:23:45');
        const before = Date.now();
        initPlaceRatingSchema(database);
        const after = Date.now();
        const rows = database.prepare('SELECT * FROM PlaceRating ORDER BY place_id').all();
        assert.equal(rows.length, cases.length, 'places without a surviving creator are not seeded');
        cases.forEach(([input, expected], index) => {
            const row = rows[index];
            if (expected) assert.equal(row.created_at, Date.parse(expected), `creation time: ${input}`);
            else assert.ok(row.created_at >= before && row.created_at <= after, `invalid creation time falls back to migration time: ${input}`);
            assert.equal(row.updated_at, row.created_at);
            assert.equal(row.source, 'migration');
            assert.equal(row.score, index === 1 ? 1 : 4);
        });
    });
}

function testNewSchema() {
    withDatabase((database) => {
        database.prepare('INSERT INTO Place(id, creator_id) VALUES (1, ?)').run('creator');
        initPlaceRatingSchema(database);
        assert.equal(database.prepare('SELECT weight FROM PlaceRating').get().weight, 0.5);
        assert.throws(() => database.prepare('UPDATE PlaceRating SET weight = 0').run(), /CHECK constraint failed/);
        assert.throws(() => database.prepare('UPDATE PlaceRating SET weight = -1').run(), /CHECK constraint failed/);
        assert.throws(() => database.prepare('UPDATE PlaceRating SET weight = NULL').run(), /NOT NULL constraint failed/);
        database.prepare(`INSERT INTO UserReputation
            (user_id, beta, gamma, weight, contribution, evidence, rating_count, agreement, updated_at)
            VALUES ('creator', 0.6, 1, 0.6, 2, 0, 0, 0.8, 100)`).run();
        database.prepare('INSERT INTO RatingWeightRefresh(id, updated_at) VALUES (1, 100)').run();
        assert.throws(() => database.prepare('INSERT INTO RatingWeightRefresh(id, updated_at) VALUES (2, 200)').run(), /CHECK constraint failed/);
        initPlaceRatingSchema(database);
        assert.equal(database.prepare('SELECT weight FROM UserReputation').get().weight, 0.6);
        assert.equal(database.prepare('SELECT updated_at FROM RatingWeightRefresh').get().updated_at, 100);
        database.prepare("DELETE FROM User WHERE id = 'creator'").run();
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM UserReputation').get().count, 0);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM PlaceRating').get().count, 0);
    });
}

function testUpgradePreservesRatingsAndWithdrawals() {
    withDatabase((database) => {
        database.exec(`CREATE TABLE PlaceRating (
            place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 4),
            source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'create', 'migration')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (place_id, user_id)
        ) WITHOUT ROWID;
        INSERT INTO Place(id, creator_id, category, created_time) VALUES
            (1, 'creator', '面馆', '3/19/2025 17:23'),
            (2, 'creator', '面馆', '3/19/2025 17:23');
        INSERT INTO PlaceRating(place_id, user_id, score, source, created_at, updated_at)
            VALUES (1, 'creator', 2, 'user', 123, 456);`);
        initPlaceRatingSchema(database);
        assert.deepEqual(database.prepare('SELECT * FROM PlaceRating').get(), {
            place_id: 1, user_id: 'creator', score: 2, source: 'user', created_at: 123, updated_at: 456, weight: 0.5
        });
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM PlaceRating WHERE place_id = 2').get().count, 0,
            'upgrading an existing table must not restore withdrawn migration ratings');
        database.prepare('UPDATE PlaceRating SET weight = 0.75').run();
        database.prepare(`INSERT INTO PlaceRatingEvent(user_id, place_id, action, score, quota_day, occurred_at)
            VALUES ('creator', 2, 'withdraw', NULL, '2026-10-15', 789)`).run();
        initPlaceRatingSchema(database);
        assert.equal(database.prepare('SELECT weight FROM PlaceRating').get().weight, 0.75, 'repeat startup preserves computed weights');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM PlaceRatingEvent').get().count, 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM PlaceRating WHERE place_id = 2').get().count, 0);
    });
}

const tests = [testMigrationDates, testNewSchema, testUpgradePreservesRatingsAndWithdrawals];
let failed = 0;
for (const test of tests) {
    try { test(); console.log(`PASS ${test.name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${test.name}: ${error.stack}`); }
}
if (failed) process.exitCode = 1;
else console.log('Rating schema tests passed: date migration, weight defaults and constraints, reputation cascade and idempotent upgrades.');
