// 新增地点初筛（见 doc/placeModeration.md）：Place.moderation_status 在 database.js 与其他 Place 列一起补齐，
// 这里补 PlaceRequest 的复核字段和 PlaceModeration 任务表。
function initPlaceModerationSchema(database) {
    const requestColumns = database.prepare("PRAGMA table_info('PlaceRequest')").all().map((column) => column.name);
    if (!requestColumns.includes('request_type')) {
        database.exec("ALTER TABLE PlaceRequest ADD COLUMN request_type TEXT NOT NULL DEFAULT 'modify'");
    }
    if (!requestColumns.includes('moderation')) {
        database.exec('ALTER TABLE PlaceRequest ADD COLUMN moderation TEXT');
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_placerequest_open_create
        ON PlaceRequest(place_id) WHERE request_type = 'create' AND status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_place_hidden_creator
        ON Place(creator_id) WHERE moderation_status <> 'visible';
      CREATE TABLE IF NOT EXISTS PlaceModeration (
        place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        checks INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        report TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
}

module.exports = { initPlaceModerationSchema };
