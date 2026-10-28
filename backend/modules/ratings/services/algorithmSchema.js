function initAlgorithmSchema(db){
    const eventColumns=`source_table TEXT NOT NULL,event_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,behavior_id INTEGER REFERENCES UserBehaviorEvent(id) ON DELETE CASCADE,interaction_id TEXT REFERENCES MapInteraction(id) ON DELETE CASCADE,consent_ref TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL,research_allowed INTEGER NOT NULL DEFAULT 0,trigger_kind TEXT NOT NULL DEFAULT 'unknown',surface TEXT,decision_id TEXT,impression_id TEXT,contract_version INTEGER NOT NULL DEFAULT 1,recorded_at_ms INTEGER NOT NULL,PRIMARY KEY(source_table,user_id,event_id),CHECK((behavior_id IS NOT NULL)+(interaction_id IS NOT NULL)=1)`;
    const wasVersioned=db.prepare('PRAGMA table_info(UserPreference)').all().some(x=>x.name==='computed_input_revision');
    const add=(table,column)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column.split(' ')[0]))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);};
    add('UserPreference','input_revision INTEGER NOT NULL DEFAULT 1');add('UserPreference','computed_input_revision INTEGER NOT NULL DEFAULT 0');
    if(!wasVersioned)db.prepare('UPDATE UserPreference SET computed_input_revision=input_revision WHERE dirty=0').run();
    db.exec(`
        CREATE TABLE IF NOT EXISTS AlgorithmClock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO AlgorithmClock VALUES(1,0);
        CREATE TABLE IF NOT EXISTS AlgorithmVectorClock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO AlgorithmVectorClock VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS numeric_vector_insert AFTER INSERT ON Place BEGIN UPDATE AlgorithmVectorClock SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS numeric_vector_update AFTER UPDATE OF has_vector,vector_updated_at ON Place BEGIN UPDATE AlgorithmVectorClock SET revision=revision+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS numeric_vector_delete AFTER DELETE ON Place BEGIN UPDATE AlgorithmVectorClock SET revision=revision+1 WHERE id=1; END;
        CREATE TABLE IF NOT EXISTS PlaceRatingSummary(place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,count INTEGER NOT NULL,average REAL,tier INTEGER,distribution TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS RatingSummaryState(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS RatingStream(user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,place_id));
        CREATE TABLE IF NOT EXISTS RatingRevision(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,revision INTEGER NOT NULL,previous_revision INTEGER,action TEXT NOT NULL,before_state TEXT,after_state TEXT,origin TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,available_at_ms INTEGER NOT NULL,experience_time_ms INTEGER,experience_time_basis TEXT,entry_surface TEXT,rating_scale_version INTEGER NOT NULL DEFAULT 1,UNIQUE(user_id,place_id,revision));
        CREATE TABLE IF NOT EXISTS RatingCommand(user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,place_id INTEGER NOT NULL,action TEXT NOT NULL,committed_revision INTEGER NOT NULL,committed_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
        CREATE TABLE IF NOT EXISTS PlaceRevision(id TEXT PRIMARY KEY,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,parent_revision TEXT,author_id TEXT REFERENCES User(id) ON DELETE SET NULL,executor_id TEXT REFERENCES User(id) ON DELETE SET NULL,path TEXT NOT NULL,before_state TEXT,after_state TEXT NOT NULL,changed_fields TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,available_at_ms INTEGER NOT NULL,request_id TEXT);
        CREATE TABLE IF NOT EXISTS RatingEvidenceLink(user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,rating_revision INTEGER NOT NULL,place_revision_id TEXT NOT NULL REFERENCES PlaceRevision(id) ON DELETE CASCADE,kind TEXT NOT NULL DEFAULT 'place_description',available_at_ms INTEGER NOT NULL,PRIMARY KEY(user_id,place_id,rating_revision,place_revision_id));
        CREATE TABLE IF NOT EXISTS ResearchConsentEvent(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,allowed INTEGER NOT NULL,purpose_version TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ResearchBundle(id TEXT PRIMARY KEY,hash TEXT NOT NULL,path_key TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,input_revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ResearchBundleMember(bundle_id TEXT NOT NULL REFERENCES ResearchBundle(id) ON DELETE CASCADE,user_id TEXT NOT NULL,PRIMARY KEY(bundle_id,user_id));
        CREATE TABLE IF NOT EXISTS ResearchBundlePlace(bundle_id TEXT NOT NULL REFERENCES ResearchBundle(id) ON DELETE CASCADE,place_id INTEGER NOT NULL,PRIMARY KEY(bundle_id,place_id));
        CREATE TABLE IF NOT EXISTS ResearchBundlePurge(bundle_id TEXT PRIMARY KEY REFERENCES ResearchBundle(id) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS AlgorithmEventContext(${eventColumns});
        CREATE TABLE IF NOT EXISTS AlgorithmEvidenceQueue(user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS numeric_profile_dirty AFTER UPDATE OF dirty ON UserPreference WHEN NEW.dirty=1 BEGIN
            UPDATE UserPreference SET input_revision=input_revision+1 WHERE user_id=NEW.user_id;
        END;
    `);
    if(!db.prepare('PRAGMA table_info(AlgorithmEventContext)').all().find(c=>c.name==='user_id').pk)db.transaction(()=>{
        db.exec(`CREATE TABLE AlgorithmEventContextNext(${eventColumns});
            INSERT INTO AlgorithmEventContextNext SELECT * FROM AlgorithmEventContext;
            DROP TABLE AlgorithmEventContext;
            ALTER TABLE AlgorithmEventContextNext RENAME TO AlgorithmEventContext;`);
    }).immediate();
    add('RatingRevision','research_consent_id TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL');
    add('PlaceRevision','research_consent_id TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL');
    add('ResearchConsentEvent','revoked_at_ms INTEGER');
    add('PlaceRequest','submitted_at_ms INTEGER');
    add('PlaceRequest','research_consent_id TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL');
    for(const table of ['User','Place','PlaceRating','Favorite','PlaceRequest','UserPreference'])for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS numeric_clock_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE AlgorithmClock SET revision=revision+1 WHERE id=1; END;`);
    for(const [table,field,membership] of [['User','user_id','ResearchBundleMember'],['Place','place_id','ResearchBundlePlace']])db.exec(`CREATE TRIGGER IF NOT EXISTS numeric_bundle_delete_${table} BEFORE DELETE ON ${table} BEGIN
        UPDATE ResearchBundle SET status='invalid' WHERE id IN(SELECT bundle_id FROM ${membership} WHERE ${field}=OLD.id);
        INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) SELECT bundle_id FROM ${membership} WHERE ${field}=OLD.id;
    END;`);
    // A baseline is a present-time observation, never a synthetic old interaction.
    const now=Date.now();
    db.prepare(`INSERT OR IGNORE INTO RatingStream(user_id,place_id,revision) SELECT user_id,place_id,1 FROM PlaceRating`).run();
    const insert=db.prepare(`INSERT OR IGNORE INTO RatingRevision(event_id,user_id,place_id,revision,action,after_state,origin,recorded_at_ms,available_at_ms) VALUES(?,?,?,1,'baseline_import',?,'unknown',?,?)`);
    for(const row of db.prepare('SELECT * FROM PlaceRating').all())if(!db.prepare('SELECT 1 FROM RatingRevision WHERE user_id=? AND place_id=?').get(row.user_id,row.place_id))insert.run(`baseline:${row.place_id}:${row.user_id}`,row.user_id,row.place_id,JSON.stringify(row),now,now);
}
module.exports={initAlgorithmSchema};
