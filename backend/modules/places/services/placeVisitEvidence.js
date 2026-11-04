const {db}=require('../../../infrastructure/database');
const {randomUUID}=require('node:crypto');
const DAY=86400000;
function fail(message,status=400){throw Object.assign(new Error(message),{status,publicMessage:message});}
function ensureSchema(){db._raw.exec(`
 CREATE TABLE IF NOT EXISTS PlaceVisitView(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,viewed_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS visit_view_user ON PlaceVisitView(user_id,viewed_at_ms);
 CREATE TABLE IF NOT EXISTS PlaceVisitEvidence(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,place_id INTEGER NOT NULL REFERENCES Place(id) ON DELETE CASCADE,view_id TEXT NOT NULL UNIQUE REFERENCES PlaceVisitView(id) ON DELETE CASCADE,first_fix_at INTEGER NOT NULL,last_fix_at INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,summary TEXT NOT NULL,answer TEXT,answered_at_ms INTEGER);
 CREATE INDEX IF NOT EXISTS visit_evidence_user ON PlaceVisitEvidence(user_id,created_at_ms);`);
 if(!db._raw.prepare('PRAGMA table_info(PlaceVisitView)').all().some(r=>r.name==='place_geometry'))db._raw.exec("ALTER TABLE PlaceVisitView ADD COLUMN place_geometry TEXT NOT NULL DEFAULT ''");
}
function allowed(userId,placeId){
 if(!Number.isSafeInteger(Number(placeId))||Number(placeId)<1)fail('无效地点');
 const row=db._raw.prepare("SELECT p.id,p.latitude,p.longitude FROM Place p JOIN User u ON u.id=? WHERE p.id=? AND COALESCE(u.is_banned,0)=0 AND (p.moderation_status='visible' OR p.creator_id=u.id) AND NOT EXISTS(SELECT 1 FROM UserBlock b WHERE b.user_id=u.id AND b.blocked_id=p.creator_id)").get(userId,placeId);
 if(!row)fail('地点不存在',404);
 if(!db._raw.prepare('SELECT feedback FROM MapConsent WHERE user_id=?').get(userId)?.feedback)fail('请先启用交互记录',403);
 return row;
}
function view(userId,placeId,now=Date.now()){
 ensureSchema();const place=allowed(userId,placeId);
 const recent=db._raw.prepare('SELECT id FROM PlaceVisitView WHERE user_id=? AND place_id=? AND viewed_at_ms>? ORDER BY viewed_at_ms DESC LIMIT 1').get(userId,placeId,now-60000);
 if(recent)return recent;
 if(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceVisitView WHERE user_id=? AND viewed_at_ms>?').get(userId,now-60000).n>=30)fail('操作过于频繁',429);
 const id=randomUUID();db._raw.prepare('INSERT INTO PlaceVisitView(id,user_id,place_id,viewed_at_ms,expires_at_ms,place_geometry) VALUES(?,?,?,?,?,?)').run(id,userId,placeId,now,now+90*DAY,JSON.stringify([place.latitude,place.longitude]));return {id};
}
function infer(userId,placeId,p,now=Date.now()){
 ensureSchema();const place=allowed(userId,placeId);
 const viewed=db._raw.prepare('SELECT * FROM PlaceVisitView WHERE id=? AND user_id=? AND place_id=?').get(p.view_id,userId,placeId);
 if(!viewed||viewed.viewed_at_ms<now-DAY)fail('查看记录已失效');
 if(viewed.place_geometry!==JSON.stringify([place.latitude,place.longitude]))fail('地点位置已变化，请重新查看');
 const neighbors=db._raw.prepare('SELECT DISTINCT p.id,p.latitude,p.longitude FROM PlaceVisitView v JOIN Place p ON p.id=v.place_id WHERE v.user_id=? AND v.viewed_at_ms>? AND p.id<>?').all(userId,now-DAY,placeId);
 const rad=Math.PI/180;
 if(Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)&&neighbors.some(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.hypot((p.latitude-place.latitude)*111195,(p.longitude-place.longitude)*111195*Math.cos(place.latitude*rad))<=100))return {prompt:false,ambiguous:true};
 const span=p.last_fix_at-p.first_fix_at;
 if(![p.first_fix_at,p.last_fix_at,p.fix_count,p.max_gap_ms].every(Number.isSafeInteger)||p.first_fix_at<viewed.viewed_at_ms-15000||p.last_fix_at>now+5000||p.last_fix_at<now-90000||span<=600000||span>900000||p.fix_count<11||p.fix_count>100||p.max_gap_ms<=0||p.max_gap_ms>90000||span>(p.fix_count-1)*p.max_gap_ms||p.rule_version!=='visit-50m-10min-v1'||p.distance_band!=='within_50m'||p.accuracy_band!=='within_25m')fail('停留证据不足');
 const old=db._raw.prepare('SELECT id FROM PlaceVisitEvidence WHERE view_id=?').get(p.view_id);if(old)return {...old,prompt:false};
 const throttled=db._raw.prepare('SELECT 1 FROM PlaceVisitEvidence WHERE user_id=? AND (created_at_ms>? OR (place_id=? AND created_at_ms>?)) LIMIT 1').get(userId,now-7*DAY,placeId,now-30*DAY);
 const id=randomUUID(),summary=JSON.stringify({fix_count:p.fix_count,max_gap_ms:p.max_gap_ms,rule_version:p.rule_version,distance_band:p.distance_band,accuracy_band:p.accuracy_band,source:'client_location_inference'});
 db._raw.prepare('INSERT INTO PlaceVisitEvidence(id,user_id,place_id,view_id,first_fix_at,last_fix_at,created_at_ms,expires_at_ms,summary) VALUES(?,?,?,?,?,?,?,?,?)').run(id,userId,placeId,p.view_id,p.first_fix_at,p.last_fix_at,now,p.first_fix_at+90*DAY,summary);
 capture(userId,placeId,id,'visit_inferred',now);
 return {id,prompt:!throttled};
}
function answer(userId,placeId,id,value,now=Date.now()){
 ensureSchema();allowed(userId,placeId);if(!['yes','no','later'].includes(value))fail('无效回答');
 const row=db._raw.prepare('SELECT * FROM PlaceVisitEvidence WHERE id=? AND user_id=? AND place_id=? AND expires_at_ms>?').get(id,userId,placeId,now);
 if(!row)fail('到访记录不存在',404);
 if(row.answer&&row.answer!==value)fail('已记录回答',409);
 const changed=db._raw.prepare('UPDATE PlaceVisitEvidence SET answer=?,answered_at_ms=? WHERE id=? AND answer IS NULL').run(value,now,id).changes;
 if(changed&&value!=='later')capture(userId,placeId,`${id}:${value}`,value==='yes'?'confirm_stop':'visit_denied',now);
 return {answer:value};
}
function capture(userId,placeId,id,kind,now){
 const evidence=require('../../ratings/services/ratingEvidence');
 db._raw.prepare('INSERT OR IGNORE INTO MapInteraction(id,user_id,session_id,kind,surface,place_id,research_allowed,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,userId,`visit:${id}`,kind,'map',placeId,+!!evidence.researchConsent(userId,now),new Date(now).toISOString());
 evidence.captureEvent('MapInteraction',userId,id,{trigger:kind==='visit_inferred'?'programmatic':'user',surface:'map'});
}
module.exports={ensureSchema,view,infer,answer};
