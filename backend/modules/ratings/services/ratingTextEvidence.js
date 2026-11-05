'use strict';
const {createHash}=require('node:crypto');
const judge=require('./ratingContentJudge');
const POLICY='bounded-text-evidence-v2',DAY=86400000;
const model=()=>process.env.RATING_TEXT_LLM_MODEL||process.env.DEEPSEEK_MODEL||'deepseek-flash';
const mode=()=>['off','shadow'].includes(process.env.RATING_TEXT_EVIDENCE_MODE)?process.env.RATING_TEXT_EVIDENCE_MODE:'active';
const raw=()=>require('../../../infrastructure/database').db._raw;
function initTextEvidenceSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS RatingTextEvidence(
  comment_id INTEGER PRIMARY KEY REFERENCES Comment(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,
  place_revision_id TEXT UNIQUE REFERENCES PlaceRevision(id) ON DELETE CASCADE,rating_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,evidence_text TEXT NOT NULL,available_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',information REAL,confidence REAL,applicable INTEGER,result_json TEXT,research_consent_id TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL,
  judge_model TEXT NOT NULL,prompt_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,judged_at_ms INTEGER);
  CREATE INDEX IF NOT EXISTS rating_text_pending ON RatingTextEvidence(status,next_attempt_ms);
  CREATE INDEX IF NOT EXISTS rating_text_owner ON RatingTextEvidence(user_id,place_id,rating_revision);
  CREATE TABLE IF NOT EXISTS RatingTextJudgment(content_hash TEXT NOT NULL,judge_model TEXT NOT NULL,prompt_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at_ms INTEGER NOT NULL,PRIMARY KEY(content_hash,judge_model,prompt_hash));`);
 db.exec('CREATE TABLE IF NOT EXISTS RatingTextPolicy(id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL)');
 db.prepare('INSERT INTO RatingTextPolicy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active').run(+(mode()==='active'));
 db.exec('CREATE TABLE IF NOT EXISTS RatingTextClock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO RatingTextClock VALUES(1,0)');
 if(!db.prepare('PRAGMA table_info(RatingTextEvidence)').all().some(c=>c.name==='research_consent_id'))db.exec('ALTER TABLE RatingTextEvidence ADD COLUMN research_consent_id TEXT REFERENCES ResearchConsentEvent(id) ON DELETE SET NULL');
 for(const [column,type]of [['place_revision_id','TEXT'],['rating_revision','INTEGER']])if(!db.prepare('PRAGMA table_info(Comment)').all().some(c=>c.name===column))db.exec(`ALTER TABLE Comment ADD COLUMN ${column} ${type}`);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS comment_place_revision ON Comment(place_revision_id) WHERE place_revision_id IS NOT NULL');
 db.exec(`CREATE TABLE IF NOT EXISTS DeletedEditComment(place_revision_id TEXT PRIMARY KEY REFERENCES PlaceRevision(id) ON DELETE CASCADE,deleted_at_ms INTEGER NOT NULL);
 DROP TRIGGER IF EXISTS rating_text_comment_delete;
 CREATE TRIGGER rating_text_comment_delete BEFORE DELETE ON Comment BEGIN
  INSERT OR IGNORE INTO DeletedEditComment(place_revision_id,deleted_at_ms) SELECT OLD.place_revision_id,CAST(strftime('%s','now') AS INTEGER)*1000 WHERE OLD.place_revision_id IS NOT NULL;
  UPDATE ResearchBundle SET status='invalid' WHERE id IN(SELECT bundle_id FROM ResearchBundleMember WHERE user_id=OLD.user_id);
  INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) SELECT bundle_id FROM ResearchBundleMember WHERE user_id=OLD.user_id;
  DELETE FROM RatingTextEvidence WHERE comment_id=OLD.id;
 END;`);
 // Text judgments change quality/list snapshots, not raw vote summaries.
 // Deleting source contributions also invalidates restaurant profile assets.
 for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`DROP TRIGGER IF EXISTS numeric_text_${action}; CREATE TRIGGER numeric_text_${action} AFTER ${action} ON RatingTextEvidence ${action==='UPDATE'?"WHEN OLD.status='ready' OR NEW.status='ready'":''} BEGIN UPDATE RatingTextClock SET revision=revision+1 WHERE id=1; ${action==='DELETE'?'UPDATE AlgorithmClock SET revision=revision+1 WHERE id=1;':''} END;`);
 db.prepare("UPDATE RatingTextEvidence SET prompt_hash=?,judge_model=?,status='pending',information=NULL,confidence=NULL,applicable=NULL,result_json=NULL,attempts=0,next_attempt_ms=0,judged_at_ms=NULL WHERE expires_at_ms>? AND (prompt_hash<>? OR judge_model<>?)").run(judge.PROMPT_HASH,model(),Date.now(),judge.PROMPT_HASH,model());
}
function queueComment({commentId,userId,placeId,placeRevisionId=null,text,now=Date.now(),ratingRevision=null,consentId}){
 const db=raw(),rating=db.prepare('SELECT 1 FROM PlaceRating WHERE user_id=? AND place_id=?').get(userId,placeId);
 const revision=ratingRevision??db.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(userId,placeId)?.revision;
 const cleaned=judge.cleanText(text);if(!rating||!revision||!cleaned)return;
 const consent=consentId!==undefined?consentId:require('./ratingEvidence').researchConsent(userId,now)?.id||null;
 db.prepare(`INSERT OR IGNORE INTO RatingTextEvidence(comment_id,user_id,place_id,place_revision_id,rating_revision,content_hash,evidence_text,available_at_ms,expires_at_ms,judge_model,prompt_hash,research_consent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(commentId,userId,placeId,placeRevisionId,revision,createHash('sha256').update(cleaned).digest('hex'),cleaned,now,now+90*DAY,model(),judge.PROMPT_HASH,consent);
}
function factors(now=Date.now(),database=raw()){
 const result=new Map();if(mode()==='off')return result;
 const rows=database.prepare(`SELECT e.*,r.score FROM RatingTextEvidence e JOIN Comment c ON c.id=e.comment_id JOIN Place p ON p.id=e.place_id JOIN RatingStream s ON s.user_id=e.user_id AND s.place_id=e.place_id JOIN PlaceRating r ON r.user_id=e.user_id AND r.place_id=e.place_id JOIN User u ON u.id=e.user_id WHERE e.status='ready' AND e.available_at_ms<=? AND e.judged_at_ms<=? AND e.expires_at_ms>? AND e.prompt_hash=? AND e.judge_model=? AND e.rating_revision=s.revision AND p.moderation_status='visible' AND u.is_banned=0`).all(now,now,now,judge.PROMPT_HASH,model());
 for(const r of rows){const key=JSON.stringify([r.place_id,r.user_id]),weight=judge.multiplier(JSON.parse(r.result_json),r.score);result.set(key,Math.max(result.get(key)||1,weight));}return result;
}
function cleanup(now=Date.now()){
 const db=raw();db.prepare('DELETE FROM RatingTextEvidence WHERE expires_at_ms<=? OR NOT EXISTS(SELECT 1 FROM Comment c WHERE c.id=comment_id) OR NOT EXISTS(SELECT 1 FROM PlaceRating r WHERE r.user_id=RatingTextEvidence.user_id AND r.place_id=RatingTextEvidence.place_id)').run(now);
 db.prepare('DELETE FROM RatingTextJudgment WHERE expires_at_ms<=?').run(now);
}
async function processPending({now=Date.now(),evaluate=judge.judgeTexts}={}){
 cleanup(now);if(mode()==='off')return {processed:0};
 const db=raw(),rows=db.prepare(`SELECT e.* FROM RatingTextEvidence e JOIN Place p ON p.id=e.place_id JOIN User u ON u.id=e.user_id WHERE p.moderation_status='visible' AND u.is_banned=0 AND e.status='pending' AND e.next_attempt_ms<=? AND e.expires_at_ms>? AND e.prompt_hash=? AND e.judge_model=? ORDER BY e.available_at_ms LIMIT 8`).all(now,now,judge.PROMPT_HASH,model());
 if(!rows.length)return {processed:0};
 const complete=new Map(),missing=[];
 for(const r of rows){const cache=db.prepare('SELECT result_json FROM RatingTextJudgment WHERE content_hash=? AND judge_model=? AND prompt_hash=? AND expires_at_ms>?').get(r.content_hash,r.judge_model,r.prompt_hash,now);if(cache)complete.set(String(r.comment_id),{...JSON.parse(cache.result_json),id:String(r.comment_id)});else missing.push(r);}
 try{if(missing.length){const values=await evaluate(missing.map(r=>({id:String(r.comment_id),text:r.evidence_text})),{model:model()});for(const value of judge.validate({reviews:values},missing.map(r=>({id:String(r.comment_id),text:r.evidence_text}))))complete.set(value.id,value);}}
 catch{db.transaction(()=>{for(const r of missing)db.prepare("UPDATE RatingTextEvidence SET attempts=attempts+1,status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'pending' END,next_attempt_ms=? WHERE comment_id=? AND status='pending'").run(now+Math.min(3600000,60000*2**r.attempts),r.comment_id);})();}
 const judgedAt=Date.now();db.transaction(()=>{for(const r of rows){const value=complete.get(String(r.comment_id));if(!value)continue;
  // Recheck ownership and lifetime after the remote call; removed sources stay removed.
  const saved=db.prepare(`UPDATE RatingTextEvidence SET status='ready',information=?,confidence=?,applicable=?,result_json=?,judged_at_ms=? WHERE comment_id=? AND content_hash=? AND expires_at_ms>? AND EXISTS(SELECT 1 FROM Comment c WHERE c.id=comment_id)`).run(value.information,value.confidence,+value.applicable,JSON.stringify(value),judgedAt,r.comment_id,r.content_hash,judgedAt);
  if(saved.changes)db.prepare('INSERT INTO RatingTextJudgment VALUES(?,?,?,?,?) ON CONFLICT(content_hash,judge_model,prompt_hash) DO UPDATE SET expires_at_ms=MIN(expires_at_ms,excluded.expires_at_ms)').run(r.content_hash,r.judge_model,r.prompt_hash,JSON.stringify(value),r.expires_at_ms);
 }})();return {processed:complete.size};
}
function startTextEvidenceWorker(){let busy=false,stopped=false;const run=async()=>{if(busy||stopped)return;busy=true;try{if(require('../../../infrastructure/aiClients').hasDeepseekConfiguration())await processPending();else cleanup();}catch{/* Bounded durable queue retries on the next tick. */}finally{busy=false;}};const timer=setInterval(run,15000),initial=setTimeout(run,2500);timer.unref?.();initial.unref?.();return ()=>{stopped=true;clearInterval(timer);clearTimeout(initial);};}
module.exports={POLICY,mode,revision:()=>raw().prepare('SELECT revision FROM RatingTextClock WHERE id=1').get()?.revision||0,initTextEvidenceSchema,queueComment,factors,cleanup,processPending,startTextEvidenceWorker};
