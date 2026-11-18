function initPlaceCheckInSchema(database) {
    const columns = database.prepare('PRAGMA table_info(Place)').all();
    if (!columns.some(column => column.name === 'checkin_images')) {
        database.exec('ALTER TABLE Place ADD COLUMN checkin_images TEXT');
    }
    database.exec(`
        CREATE TABLE IF NOT EXISTS PlaceCheckIn (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            local_day TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            companion_id TEXT NOT NULL,
            satiety INTEGER NOT NULL,
            score INTEGER CHECK(score BETWEEN 1 AND 4),
            rating_base_revision INTEGER NOT NULL DEFAULT 0,
            rating_revision INTEGER,
            description_approved INTEGER NOT NULL DEFAULT 0,
            photos_approved INTEGER NOT NULL DEFAULT 0,
            UNIQUE(user_id, request_id),
            UNIQUE(user_id, local_day, place_id)
        );
        CREATE INDEX IF NOT EXISTS PlaceCheckIn_place_user ON PlaceCheckIn(place_id, user_id);
        CREATE TABLE IF NOT EXISTS PlaceCheckInPhoto (
            id TEXT PRIMARY KEY,
            checkin_id TEXT NOT NULL REFERENCES PlaceCheckIn(id) ON DELETE CASCADE,
            hash TEXT NOT NULL,
            content_type TEXT NOT NULL,
            bytes BLOB NOT NULL,
            approved INTEGER NOT NULL DEFAULT 0,
            UNIQUE(checkin_id, hash)
        );
        CREATE TABLE IF NOT EXISTS PlaceCheckInRequest (
            request_id INTEGER PRIMARY KEY REFERENCES PlaceRequest(id) ON DELETE CASCADE,
            checkin_id TEXT NOT NULL REFERENCES PlaceCheckIn(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('description', 'photos')),
            UNIQUE(checkin_id, kind)
        );
        CREATE TRIGGER IF NOT EXISTS PlaceCheckIn_remove_photos BEFORE DELETE ON PlaceCheckIn
        BEGIN
            UPDATE Place SET checkin_images=(
                SELECT json_group_array(value) FROM json_each(checkin_images)
                WHERE value NOT IN (SELECT '/places/check-in-photos/' || id FROM PlaceCheckInPhoto WHERE checkin_id=OLD.id)
            ) WHERE id=OLD.place_id AND checkin_images IS NOT NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS PlaceCheckIn_remove_pending_requests BEFORE DELETE ON PlaceCheckIn
        BEGIN
            DELETE FROM PlaceRequest WHERE status='pending' AND request_type='check_in'
                AND id IN (SELECT request_id FROM PlaceCheckInRequest WHERE checkin_id=OLD.id);
        END;
    `);
    if (!database.prepare('PRAGMA table_info(PlaceCheckIn)').all().some(column => column.name === 'rating_base_revision')) {
        database.exec('ALTER TABLE PlaceCheckIn ADD COLUMN rating_base_revision INTEGER NOT NULL DEFAULT 0');
    }
}

module.exports = { initPlaceCheckInSchema };
