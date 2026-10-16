// Place ratings. Called from db.init() after Place/User exist and BEFORE the
// user preference schema, whose triggers read PlaceRating.

// SQLite/ISO dates without a zone are UTC. The old spreadsheet export used
// M/D/YYYY H:mm[:ss] in China local time; do not let the server's zone decide it.
function creationTimestamp(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    const legacy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    const iso = legacy ? null : /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/i.exec(text);
    if (!legacy && !iso) return fallback;
    const year = Number(legacy ? legacy[3] : iso[1]);
    const month = Number(legacy ? legacy[1] : iso[2]);
    const day = Number(legacy ? legacy[2] : iso[3]);
    const hour = Number((legacy || iso)[4] || 0);
    const minute = Number((legacy || iso)[5] || 0);
    const second = Number((legacy || iso)[6] || 0);
    const millisecond = legacy ? 0 : Number((iso[7] || '').padEnd(3, '0'));
    const offsetHours = iso ? Number(iso[10] || 0) : 8;
    const offsetMinutes = iso ? Number(iso[11] || 0) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23
        || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return fallback;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fallback;
    const offsetSign = iso && iso[9] === '-' ? -1 : 1;
    return date.getTime() - offsetSign * (offsetHours * 60 + offsetMinutes) * 60000;
}

function initPlaceRatingSchema(rawDb) {
    const existed = !!rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'PlaceRating'").get();
    const create = rawDb.transaction(() => {
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS PlaceRating (
                place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
                score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 4),
                source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'create', 'migration')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                weight REAL NOT NULL DEFAULT 0.5 CHECK(weight > 0),
                PRIMARY KEY (place_id, user_id)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_place_rating_user ON PlaceRating(user_id, place_id);

            -- Only ratings made through the rating API are logged here; they drive
            -- the daily quota. place_id is not a foreign key so a deleted place
            -- does not hand back quota already used today.
            CREATE TABLE IF NOT EXISTS PlaceRatingEvent (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
                place_id INTEGER NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('rate', 'withdraw')),
                score INTEGER CHECK(score IS NULL OR score BETWEEN 1 AND 4),
                quota_day TEXT NOT NULL,
                occurred_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_place_rating_event_quota ON PlaceRatingEvent(user_id, quota_day, action, place_id);

            CREATE TABLE IF NOT EXISTS UserReputation (
                user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
                beta REAL NOT NULL,
                gamma REAL NOT NULL,
                weight REAL NOT NULL,
                contribution REAL NOT NULL,
                evidence REAL NOT NULL,
                rating_count INTEGER NOT NULL,
                agreement REAL NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS RatingWeightRefresh (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                updated_at INTEGER NOT NULL
            );
        `);
        if (!rawDb.prepare('PRAGMA table_info(PlaceRating)').all().some((column) => column.name === 'weight')) {
            rawDb.exec('ALTER TABLE PlaceRating ADD COLUMN weight REAL NOT NULL DEFAULT 0.5 CHECK(weight > 0)');
        }
        if (existed) return 0;
        // One-time seed when the table is first created: every existing place
        // gets its creator's rating, 强烈拒绝 for places tagged 避雷 and 强烈推荐
        // otherwise. Places whose creator account no longer exists stay unrated.
        const places = rawDb.prepare(`SELECT p.id, p.creator_id, p.category, p.created_time
            FROM Place p JOIN User u ON u.id = p.creator_id`).all();
        const insert = rawDb.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at)
            VALUES (?, ?, ?, 'migration', ?, ?)`);
        const now = Date.now();
        for (const place of places) {
            const at = creationTimestamp(place.created_time, now);
            const score = String(place.category || '').includes('避雷') ? 1 : 4;
            insert.run(place.id, place.creator_id, score, at, at);
        }
        return places.length;
    });
    const seeded = create.immediate();
    if (seeded) console.log(`Migrated: seeded ${seeded} place rating(s) from existing places.`);
}

module.exports = { initPlaceRatingSchema, creationTimestamp };
