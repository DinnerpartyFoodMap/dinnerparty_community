'use strict';

const { createHash } = require('node:crypto');
const { profileInput, searchProfileInputHash } = require('./searchProfiles');

function initSearchProfileSchema(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS PlaceSearchProfile (
        place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,
        input_hash TEXT NOT NULL,
        profile_version INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        attempt_hash TEXT,
        attempt_version INTEGER,
        facts TEXT,
        inferred TEXT,
        closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
        model TEXT,
        updated_at INTEGER NOT NULL
    );`);
    database.transaction(() => {
        const columns = new Set(database.prepare('PRAGMA table_info(PlaceSearchProfile)').all().map(({ name }) => name));
        for (const field of ['profile_version INTEGER', 'attempt_hash TEXT', 'attempt_version INTEGER']) {
            if (!columns.has(field.split(' ')[0])) database.exec('ALTER TABLE PlaceSearchProfile ADD COLUMN ' + field);
        }
        if (columns.has('profile_version')) return;

        // Convert only archives whose original versioned hash verifies against today's place content.
        const legacyVersion = 1;
        const legacyPromptVersion = 1;
        const rows = database.prepare(`SELECT p.id, p.name, p.category, p.description, s.input_hash
            FROM PlaceSearchProfile s JOIN Place p ON p.id = s.place_id
            WHERE s.status = 'done' AND s.facts IS NOT NULL AND s.inferred IS NOT NULL`);
        const save = database.prepare('UPDATE PlaceSearchProfile SET input_hash = ?, profile_version = ? WHERE place_id = ?');
        const verified = [];
        for (const row of rows.iterate()) {
            const input = profileInput(row);
            const oldHash = createHash('sha256')
                .update(JSON.stringify([input.name, input.category, input.description, legacyVersion, legacyPromptVersion])).digest('hex');
            if (row.input_hash === oldHash) verified.push([row.id, searchProfileInputHash(input)]);
        }
        for (const [id, hash] of verified) save.run(hash, legacyVersion, id);
    }).immediate();
}

module.exports = { initSearchProfileSchema };
