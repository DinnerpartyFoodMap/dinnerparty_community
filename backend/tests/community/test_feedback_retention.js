const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'retention-'));process.env.DB_FILE=path.join(temp,'db.sqlite');process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
const {db,init}=require('../../infrastructure/database'),retention=require('../../modules/community/services/feedbackRetention');
try{
 init();const sql=db._raw,day=retention.DAY_MS,now=Date.now(),effective=now-100*day;
 sql.prepare('UPDATE FeedbackRetentionPolicy SET effective_at_ms=?').run(effective);
 retention.initRetention(sql,now);assert.equal(sql.prepare('SELECT effective_at_ms FROM FeedbackRetentionPolicy').get().effective_at_ms,effective,'restart must not move migration date');
 assert.equal(retention.isRetained(sql,now-89*day,now),true);
 assert.equal(retention.isRetained(sql,now-90*day,now),false);
 assert.equal(retention.isRetained(sql,now+1,now),false);
 assert.equal(retention.isRetained(sql,now-31*day,now,retention.LEGACY_PURPOSE_VERSION),false,'old grants do not acquire new retention');
 assert.equal(retention.isRetained(sql,now-31*day,now,retention.RESEARCH_PURPOSE_VERSION),true);
 sql.prepare("INSERT INTO User(id,username,password) VALUES('u','retention-user','unused')").run();
 const place=Number(sql.prepare("INSERT INTO Place(name) VALUES('retention')").run().lastInsertRowid);
 for(const age of [89,90,91]){
  const at=now-age*day,id=`event-${age}`;
  sql.prepare("INSERT INTO UserBehaviorEvent(user_id,place_id,event_id,event_type,channel,occurred_at) VALUES('u',?,?,'navigation','amap',?)").run(place,id,at);
 }
 sql.exec('CREATE TABLE PlaceVisitView(id TEXT PRIMARY KEY,expires_at_ms INTEGER); CREATE TABLE PlaceVisitEvidence(id TEXT PRIMARY KEY,expires_at_ms INTEGER)');
 sql.prepare('INSERT INTO PlaceVisitView VALUES(?,?)').run('expired',now);
 sql.prepare('INSERT INTO PlaceVisitEvidence VALUES(?,?)').run('expired',now);
 retention.cleanupFeedback(sql,now);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceVisitView').get().n,0);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceVisitEvidence').get().n,0);
 assert.deepEqual(sql.prepare('SELECT event_id FROM UserBehaviorEvent').all().map(x=>x.event_id),['event-89']);
 assert.equal(retention.sourceExpiry(sql,now-89*day),now+day,'expiry is event-relative');
 console.log('Retention migration clock, new/legacy grants, 89/90/91-day cleanup and future exclusion passed.');
}finally{db._raw.close();fs.rmSync(temp,{recursive:true,force:true});}
