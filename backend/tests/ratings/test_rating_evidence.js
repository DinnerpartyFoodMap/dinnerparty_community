const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rating-evidence-'));process.env.DB_FILE=path.join(temp,'test.sqlite');process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
const {db,init}=require('../../infrastructure/database');
try{
    init();let evidence;assert.doesNotThrow(()=>{evidence=require('../../modules/ratings/services/ratingEvidence');});
    db._raw.prepare("INSERT INTO User(id,username,password) VALUES('u','evidence-user','unused')").run();
    const id=Number(db._raw.prepare("INSERT INTO Place(name) VALUES('test')").run().lastInsertRowid);
    const prefs=require('../../modules/preferences/services/userPreferenceService');
    prefs.changeFavorite('u',id,true);
    assert.equal(evidence.buildRatingEvidence({userIds:['u'],purpose:'research'}).events.length,0,'default research switch is not consent evidence');
    evidence.recordResearchChoice('u',true);
    prefs.changeFavorite('u',id,false);prefs.changeFavorite('u',id,true);
    const data=evidence.buildRatingEvidence({userIds:['u'],purpose:'research'});
    assert.equal(data.events.length,2,'favorite mirrors must not become extra events');
    assert.deepEqual(data.events.map(x=>x.event_type),['favorite_remove','favorite_add']);
    assert.ok(data.events.every(x=>x.consent_ref));
    evidence.recordResearchChoice('u',false);
    assert.equal(evidence.buildRatingEvidence({userIds:['u'],purpose:'research'}).events.length,0);
    evidence.recordResearchChoice('u',true);
    assert.equal(evidence.buildRatingEvidence({userIds:['u'],purpose:'research'}).events.length,0,'re-enabling does not resurrect previously revoked event samples');
    const originalContext=db._raw.prepare("SELECT sql FROM sqlite_master WHERE name='AlgorithmEventContext'").get().sql;
    const preserved=db._raw.prepare('SELECT COUNT(*) AS n FROM AlgorithmEventContext').get().n;
    db._raw.exec('ALTER TABLE AlgorithmEventContext RENAME TO OldEventContext');
    db._raw.exec(originalContext.replace('PRIMARY KEY(source_table,user_id,event_id)','PRIMARY KEY(source_table,event_id)'));
    db._raw.exec('INSERT INTO AlgorithmEventContext SELECT * FROM OldEventContext; DROP TABLE OldEventContext;');
    const schema=require('../../modules/ratings/services/algorithmSchema');schema.initAlgorithmSchema(db._raw);schema.initAlgorithmSchema(db._raw);
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM AlgorithmEventContext').get().n,preserved,'event-key upgrade is repeatable and preserves existing metadata');
    db._raw.prepare("INSERT INTO User(id,username,password) VALUES('v','second-user','unused')").run();evidence.recordResearchChoice('v',true);
    const sharedId='cross-user-event-12345';
    for(const user of ['u','v']){
        db._raw.prepare("INSERT INTO UserBehaviorEvent(user_id,place_id,event_id,event_type,channel,occurred_at) VALUES(?,?,?,'navigation','amap',?)").run(user,id,sharedId,Date.now());
        evidence.captureEvent('UserBehaviorEvent',user,sharedId,{trigger:'user',surface:user});
    }
    const cross=evidence.buildRatingEvidence().events.filter(e=>e.event_id===sharedId);
    assert.equal(cross.length,2,'event IDs are unique per user, not globally');
    for(const event of cross)assert.equal(event.surface,event.user_key,'context cannot cross account boundaries');
    console.log('Evidence consent, source merging and favorite mirror dedup passed.');
}finally{require('../../modules/preferences/services/userPreferenceService').startUserVectorWorker()();db._raw.close();fs.rmSync(temp,{recursive:true,force:true});}
