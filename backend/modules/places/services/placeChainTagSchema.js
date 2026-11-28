'use strict';

const { hasChainTagSql } = require('./chainTagText');

function initPlaceChainTagSchema(sql) {
    const oldHasTag = hasChainTagSql('OLD.category');
    const newHasTag = hasChainTagSql('NEW.category');
    const now = 'CAST(unixepoch(\'subsec\') * 1000 AS INTEGER)';
    // Record the name at removal even before classification, so a later rename can clear a suppression.
    sql.exec(`CREATE TABLE IF NOT EXISTS PlaceChainCheck (
        place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,
        name_key TEXT,
        suppressed_name TEXT,
        rule_version INTEGER,
        verdict TEXT CHECK (verdict IN ('chain', 'category_name', 'independent', 'not_food', 'unknown')),
        brand TEXT,
        scope TEXT CHECK (scope IN ('national', 'regional')),
        confidence REAL CHECK (confidence BETWEEN 0 AND 1),
        source TEXT CHECK (source IN ('rule', 'model')),
        model TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        tag_applied INTEGER NOT NULL DEFAULT 0 CHECK (tag_applied IN (0, 1)),
        suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
        checked_at INTEGER,
        applied_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (${now})
    );
    CREATE TRIGGER IF NOT EXISTS place_chain_check_remove AFTER UPDATE OF category ON Place
    WHEN (${oldHasTag}) AND NOT (${newHasTag}) BEGIN
        INSERT INTO PlaceChainCheck (place_id, suppressed_name, suppressed)
        VALUES (NEW.id, OLD.name, 1)
        ON CONFLICT(place_id) DO UPDATE SET suppressed_name = excluded.suppressed_name,
            suppressed = 1, tag_applied = 0, updated_at = ${now};
    END;
    CREATE TRIGGER IF NOT EXISTS place_chain_check_add AFTER UPDATE OF category ON Place
    WHEN NOT (${oldHasTag}) AND (${newHasTag}) BEGIN
        UPDATE PlaceChainCheck SET suppressed = 0, suppressed_name = NULL, updated_at = ${now}
        WHERE place_id = NEW.id AND suppressed = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS place_chain_check_delete AFTER DELETE ON Place BEGIN
        DELETE FROM PlaceChainCheck WHERE place_id = OLD.id;
    END;`);
}

module.exports = { initPlaceChainTagSchema };
