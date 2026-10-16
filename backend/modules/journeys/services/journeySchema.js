function initJourneySchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Journey (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1, document TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journey_owner ON Journey(user_id, updated_at);
      CREATE TABLE IF NOT EXISTS JourneyDraft (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        journey_id TEXT REFERENCES Journey(id) ON DELETE CASCADE, base_revision INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL, document TEXT NOT NULL, content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', published_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journey_draft_owner ON JourneyDraft(user_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS JourneyRevision (
        journey_id TEXT NOT NULL REFERENCES Journey(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(journey_id, revision)
      );
      CREATE TABLE IF NOT EXISTS JourneyMedia (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        data BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS JourneyJob (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journey_job ON JourneyJob(status, created_at);
      CREATE TABLE IF NOT EXISTS JourneyJobRequest (
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, input_hash TEXT NOT NULL, job_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(user_id,request_id), UNIQUE(job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_journey_request_budget ON JourneyJobRequest(user_id,created_at);
      CREATE TABLE IF NOT EXISTS JourneyClarificationRequest (
        job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL REFERENCES JourneyDraft(id) ON DELETE CASCADE, created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO JourneyJobRequest(user_id,request_id,input_hash,job_id,created_at)
        SELECT user_id,'legacy_' || id,'legacy',id,created_at FROM JourneyJob;
      CREATE TABLE IF NOT EXISTS JourneyCorrection (
        id TEXT PRIMARY KEY, journey_id TEXT NOT NULL REFERENCES Journey(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, stop_id TEXT NOT NULL, field TEXT NOT NULL,
        before_value TEXT NOT NULL, after_value TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(journey_id,revision,stop_id,field)
      );
      CREATE TABLE IF NOT EXISTS JourneyMergeRequest (
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, preview_hash TEXT NOT NULL, journey_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS MapConsent (
        user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
        feedback INTEGER NOT NULL DEFAULT 1, research INTEGER NOT NULL DEFAULT 1,
        discovery INTEGER NOT NULL DEFAULT 1, tags TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO MapConsent(user_id,feedback,research,discovery,tags,version,updated_at)
        SELECT id,1,1,1,'[]',0,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM User;
      CREATE TRIGGER IF NOT EXISTS journey_default_consent AFTER INSERT ON User
      BEGIN
        INSERT OR IGNORE INTO MapConsent(user_id,feedback,research,discovery,tags,version,updated_at)
        VALUES(NEW.id,1,1,1,'[]',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TABLE IF NOT EXISTS PublicCollection (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        title TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS PublicCollectionItem (
        collection_id TEXT NOT NULL REFERENCES PublicCollection(id) ON DELETE CASCADE,
        place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
        PRIMARY KEY(collection_id, place_id)
      );
      CREATE TABLE IF NOT EXISTS MapInteraction (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, kind TEXT NOT NULL, surface TEXT NOT NULL,
        decision_id TEXT, place_id INTEGER, rank INTEGER, reason TEXT,
        research_allowed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_map_interaction_owner ON MapInteraction(user_id, created_at);
      CREATE TABLE IF NOT EXISTS MapInteractionContext (
        event_id TEXT PRIMARY KEY REFERENCES MapInteraction(id) ON DELETE CASCADE,
        context TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS MapDecision (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL, snapshot TEXT NOT NULL, result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS journey_collection_unfavorite AFTER DELETE ON Favorite
      BEGIN
        DELETE FROM PublicCollectionItem WHERE place_id=OLD.place_id
          AND collection_id IN (SELECT id FROM PublicCollection WHERE user_id=OLD.user_id);
      END;
      CREATE TRIGGER IF NOT EXISTS journey_favorite_feedback AFTER INSERT ON UserBehaviorEvent
      WHEN NEW.event_type IN ('favorite_add','favorite_remove')
      BEGIN
        INSERT OR IGNORE INTO MapInteraction(id,user_id,session_id,kind,surface,place_id,research_allowed,created_at)
        SELECT NEW.event_id,NEW.user_id,'server_' || NEW.event_id,
          CASE NEW.event_type WHEN 'favorite_add' THEN 'favorite' ELSE 'unfavorite' END,
          'favorites',NEW.place_id,c.research,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.occurred_at/1000.0,'unixepoch')
        FROM MapConsent c WHERE c.user_id=NEW.user_id AND c.feedback=1;
      END;
    `);
    initDiaryRedesignSchema(db);
}
// Compose drafts, public snapshots and place links. Legacy rows stay private:
// a diary is public only while an active JourneyPublication exists.
function initDiaryRedesignSchema(db) {
    const addColumn=(table,definition)=>{
        const columns=db.prepare(`PRAGMA table_info('${table}')`).all().map(c=>c.name);
        if(!columns.includes(definition.split(' ')[0]))db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    };
    addColumn('JourneyJob','compose_draft_id TEXT');
    addColumn('JourneyJob','result_draft_id TEXT');
    addColumn('JourneyDraft','compose_draft_id TEXT');
    // The material revision a review draft was made from; only that exact revision is closed on save.
    addColumn('JourneyDraft','compose_revision INTEGER');
    db.exec(`UPDATE JourneyDraft SET compose_revision=(SELECT json_extract(j.input,'$.compose_revision') FROM JourneyJob j WHERE j.result_draft_id=JourneyDraft.id)
      WHERE compose_draft_id IS NOT NULL AND compose_revision IS NULL`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS JourneyComposeDraft (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', active_job_id TEXT, structured_draft_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journey_compose_owner ON JourneyComposeDraft(user_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS JourneyPublication (
        id TEXT PRIMARY KEY, journey_id TEXT NOT NULL UNIQUE REFERENCES Journey(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        source_revision INTEGER NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
        snapshot TEXT NOT NULL, published_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journey_publication_owner ON JourneyPublication(user_id,status);
      CREATE TABLE IF NOT EXISTS PlaceDiaryExcerpt (
        id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES JourneyPublication(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        stop_id TEXT NOT NULL, stop_index INTEGER NOT NULL,
        place_id INTEGER REFERENCES Place(id) ON DELETE SET NULL,
        record_date TEXT NOT NULL, excerpt TEXT NOT NULL, media_ids TEXT NOT NULL, place_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(publication_id,stop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_place_diary_place ON PlaceDiaryExcerpt(place_id,record_date,publication_id);
      CREATE TABLE IF NOT EXISTS PlaceExternalIdentity (
        provider TEXT NOT NULL, external_id TEXT NOT NULL,
        place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
        PRIMARY KEY(provider,external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_place_external_place ON PlaceExternalIdentity(place_id);
      CREATE TABLE IF NOT EXISTS JourneyCommitRequest (
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, journey_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,request_id)
      );
    `);
}
module.exports = { initJourneySchema };
