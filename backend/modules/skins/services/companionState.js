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
            fed_at_ms INTEGER,
            PRIMARY KEY(user_id, companion_id)
        );
    `);
    // 上次投喂时间（底栏小伙伴的饿 / 饱）：旧库补列，并用打卡记录回填（每次打卡都投喂了当时的角色）
    const columns = database.prepare("PRAGMA table_info('CompanionSatiety')").all().map((column) => column.name);
    if (!columns.includes('fed_at_ms')) {
        database.exec('ALTER TABLE CompanionSatiety ADD COLUMN fed_at_ms INTEGER');
        const checkIns = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='PlaceCheckIn'").get();
        if (checkIns) {
            database.exec(`UPDATE CompanionSatiety SET fed_at_ms = (SELECT MAX(c.created_at_ms) FROM PlaceCheckIn c
                WHERE c.user_id = CompanionSatiety.user_id AND c.companion_id = CompanionSatiety.companion_id)`);
        }
    }
}

/** SQLite 的 CURRENT_TIMESTAMP（UTC，没有时区标记）或 ISO 文本 → ISO；无效时为 null */
function isoTime(value) {
    if (!value) return null;
    const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function activeCompanion(userId, database) {
    const ownedSelection = database.prepare(`SELECT s.companion_id FROM CompanionSelection s
        JOIN UserCompanion c ON c.user_id=s.user_id AND c.companion_id=s.companion_id
        WHERE s.user_id=?`).get(userId);
    const id = ownedSelection?.companion_id;
    return id && findPack('companion', id) ? id : DEFAULT_COMPANION_ID;
}

/**
 * 当前角色与饱食度。fed_at：上次投喂（ISO，没喂过为 null）；adopted_at：领养时间，内置角色为注册时间、
 * 额外角色为兑换时间（底栏小伙伴从没喂过时按它算饿不饿）。只返回给本人。
 */
function getCompanionState(userId, database = db._raw) {
    const active = activeCompanion(userId, database);
    const row = database.prepare('SELECT satiety, fed_at_ms FROM CompanionSatiety WHERE user_id=? AND companion_id=?').get(userId, active);
    const adopted = active === DEFAULT_COMPANION_ID
        ? database.prepare('SELECT created_time AS time FROM User WHERE id=?').get(userId)?.time
        : database.prepare('SELECT unlocked_time AS time FROM UserCompanion WHERE user_id=? AND companion_id=?').get(userId, active)?.time;
    return {
        active,
        satiety: row?.satiety || 0,
        fed_at: Number.isFinite(row?.fed_at_ms) ? new Date(row.fed_at_ms).toISOString() : null,
        adopted_at: isoTime(adopted)
    };
}

function setActiveCompanion(userId, companionId, database = db._raw) {
    return database.transaction(() => {
        database.prepare(`INSERT INTO CompanionSelection (user_id, companion_id) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET companion_id=excluded.companion_id`).run(userId, companionId);
        return getCompanionState(userId, database);
    }).immediate();
}

// The caller already owns the transaction that inserts the unique check-in. now: 投喂时间（打卡时间，毫秒）
function feedCompanionSync(userId, database = db._raw, now = Date.now()) {
    const active = activeCompanion(userId, database);
    return database.prepare(`INSERT INTO CompanionSatiety (user_id, companion_id, satiety, fed_at_ms) VALUES (?, ?, 1, ?)
        ON CONFLICT(user_id, companion_id) DO UPDATE SET satiety=satiety+1, fed_at_ms=excluded.fed_at_ms
        RETURNING companion_id AS active, satiety`).get(userId, active, now);
}

module.exports = { DEFAULT_COMPANION_ID, initCompanionStateSchema, getCompanionState, setActiveCompanion, feedCompanionSync };
