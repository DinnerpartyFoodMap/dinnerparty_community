function initResidentCommentSchema(database) {
    const columns = new Set(database.prepare('PRAGMA table_info(Comment)').all().map(column => column.name));
    for (const [column, type] of [
        ['source', 'TEXT'],
        ['moderation_status', "TEXT NOT NULL DEFAULT 'visible'"],
        ['updated_at', 'TEXT']
    ]) {
        if (!columns.has(column)) database.exec(`ALTER TABLE Comment ADD COLUMN ${column} ${type}`);
    }

    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_resident_place_user
            ON Comment(place_id, user_id) WHERE source = 'resident';
        CREATE INDEX IF NOT EXISTS idx_comment_resident_user
            ON Comment(user_id) WHERE source = 'resident';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_placerequest_open_comment
            ON PlaceRequest(json_extract(proposed, '$.comment_id'))
            WHERE request_type = 'comment' AND status = 'pending';

        CREATE TABLE IF NOT EXISTS CommentModeration (
            comment_id INTEGER PRIMARY KEY REFERENCES Comment(id) ON DELETE CASCADE,
            checks INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT,
            report TEXT
        );
        CREATE TABLE IF NOT EXISTS ResidentCommentQuota (
            user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
            local_day TEXT NOT NULL,
            writes INTEGER NOT NULL
        );

        CREATE TRIGGER IF NOT EXISTS resident_comment_withdraw_review BEFORE DELETE ON Comment
        WHEN OLD.source = 'resident'
        BEGIN
            UPDATE PlaceRequest SET status = 'withdrawn', reviewed_time = CURRENT_TIMESTAMP
            WHERE request_type = 'comment' AND status = 'pending'
                AND json_extract(proposed, '$.comment_id') = OLD.id;
        END;

        -- Comment predates foreign keys on user_id and place_id. Preserve system history.
        CREATE TRIGGER IF NOT EXISTS place_delete_resident_comments BEFORE DELETE ON Place
        BEGIN
            DELETE FROM Comment WHERE place_id = OLD.id AND source = 'resident';
        END;
        CREATE TRIGGER IF NOT EXISTS user_delete_resident_comments BEFORE DELETE ON User
        BEGIN
            DELETE FROM Comment WHERE user_id = OLD.id AND source = 'resident';
        END;
    `);
}

module.exports = { initResidentCommentSchema };
