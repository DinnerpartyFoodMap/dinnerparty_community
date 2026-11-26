function initRoomSchema(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS RoomProfile (
            user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0,
            visibility TEXT NOT NULL DEFAULT 'residents',
            meets INTEGER NOT NULL DEFAULT 1,
            city TEXT,
            sheet TEXT NOT NULL DEFAULT '{}',
            sheet_hash TEXT NOT NULL DEFAULT '',
            named_at_ms INTEGER,
            named_day TEXT,
            last_opened_at_ms INTEGER,
            last_visited_at_ms INTEGER,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS RoomDay (
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            sheet_hash TEXT NOT NULL,
            city TEXT,
            corpus_version TEXT NOT NULL,
            events TEXT NOT NULL,
            used TEXT NOT NULL,
            wake_min INTEGER NOT NULL,
            sleep_min INTEGER NOT NULL,
            generated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (user_id, day)
        );
        CREATE TABLE IF NOT EXISTS RoomMeet (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day TEXT NOT NULL,
            kind TEXT NOT NULL,
            x_user TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            y_user TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            script_id TEXT NOT NULL,
            bond_script_id TEXT,
            bond_swap INTEGER NOT NULL DEFAULT 0,
            place_id INTEGER REFERENCES Place(id) ON DELETE CASCADE,
            start_min INTEGER NOT NULL,
            end_min INTEGER NOT NULL,
            seed TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_room_meet_x_day ON RoomMeet(x_user, day);
        CREATE INDEX IF NOT EXISTS idx_room_meet_y_day ON RoomMeet(y_user, day);
        CREATE TABLE IF NOT EXISTS RoomOuting (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            slot TEXT NOT NULL,
            place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
            start_min INTEGER NOT NULL,
            end_min INTEGER NOT NULL,
            reason TEXT NOT NULL,
            meet_id INTEGER REFERENCES RoomMeet(id) ON DELETE SET NULL,
            UNIQUE (user_id, day, slot)
        );
        CREATE TABLE IF NOT EXISTS RoomMoment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            t INTEGER NOT NULL,
            kind TEXT NOT NULL,
            event TEXT NOT NULL,
            meet_id INTEGER REFERENCES RoomMeet(id) ON DELETE CASCADE,
            place_id INTEGER REFERENCES Place(id) ON DELETE CASCADE,
            created_at_ms INTEGER NOT NULL,
            UNIQUE (user_id, day, t, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_room_moment_time ON RoomMoment(user_id, day DESC, t DESC, id DESC);
        CREATE TABLE IF NOT EXISTS RoomTextQuota (
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (user_id, day)
        );
        CREATE TABLE IF NOT EXISTS RoomBond (
            user_low TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            user_high TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            score INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (user_low, user_high)
        );
        CREATE TABLE IF NOT EXISTS RoomText (
            user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            field TEXT NOT NULL,
            value TEXT NOT NULL,
            status TEXT NOT NULL,
            report TEXT,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (user_id, field)
        );
        CREATE TABLE IF NOT EXISTS RoomSchedulerRun (
            day TEXT PRIMARY KEY,
            started_at_ms INTEGER,
            finished_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_room_outing_meet ON RoomOuting(meet_id) WHERE meet_id IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS room_meet_delete_outings BEFORE DELETE ON RoomMeet BEGIN
            DELETE FROM RoomOuting WHERE meet_id = OLD.id AND reason = 'meet';
        END;
    `);
    if (!database.prepare('PRAGMA table_info(RoomMeet)').all().some(({ name }) => name === 'bond_swap')) {
        database.exec('ALTER TABLE RoomMeet ADD COLUMN bond_swap INTEGER NOT NULL DEFAULT 0');
    }
}

module.exports = { initRoomSchema };
