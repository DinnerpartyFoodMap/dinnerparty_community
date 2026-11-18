const { db } = require('../../../infrastructure/database');
const { findPack } = require('./resourcePacks');

const DEFAULT_COMPANION_ID = 'stick-figure';

function initCompanionStateSchema(database = db._raw) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS CompanionSelection (
            user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
            companion_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS CompanionSatiety (
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            companion_id TEXT NOT NULL,
            satiety INTEGER NOT NULL DEFAULT 0 CHECK(satiety >= 0),
            PRIMARY KEY(user_id, companion_id)
        );
    `);
}

function activeCompanion(userId, database) {
    const ownedSelection = database.prepare(`SELECT s.companion_id FROM CompanionSelection s
        JOIN UserCompanion c ON c.user_id=s.user_id AND c.companion_id=s.companion_id
        WHERE s.user_id=?`).get(userId);
    const id = ownedSelection?.companion_id;
    return id && findPack('companion', id) ? id : DEFAULT_COMPANION_ID;
}

function getCompanionState(userId, database = db._raw) {
    const active = activeCompanion(userId, database);
    const satiety = database.prepare('SELECT satiety FROM CompanionSatiety WHERE user_id=? AND companion_id=?')
        .get(userId, active)?.satiety || 0;
    return { active, satiety };
}

function setActiveCompanion(userId, companionId, database = db._raw) {
    return database.transaction(() => {
        database.prepare(`INSERT INTO CompanionSelection (user_id, companion_id) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET companion_id=excluded.companion_id`).run(userId, companionId);
        return getCompanionState(userId, database);
    }).immediate();
}

// The caller already owns the transaction that inserts the unique check-in.
function feedCompanionSync(userId, database = db._raw) {
    const active = activeCompanion(userId, database);
    return database.prepare(`INSERT INTO CompanionSatiety (user_id, companion_id, satiety) VALUES (?, ?, 1)
        ON CONFLICT(user_id, companion_id) DO UPDATE SET satiety=satiety+1
        RETURNING companion_id AS active, satiety`).get(userId, active);
}

module.exports = { DEFAULT_COMPANION_ID, initCompanionStateSchema, getCompanionState, setActiveCompanion, feedCompanionSync };
