'use strict';
const {randomUUID,createHash}=require('node:crypto');
const judge=require('../../ratings/services/ratingContentJudge');
const has=(sql,table)=>!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function initCreatorDescriptions(sql,now=Date.now()){
 sql.exec(`CREATE TABLE IF NOT EXISTS CreatorDescription(
  place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,user_id TEXT REFERENCES User(id) ON DELETE SET NULL,
  comment_id INTEGER REFERENCES Comment(id) ON DELETE SET NULL,place_revision_id TEXT NOT NULL UNIQUE REFERENCES PlaceRevision(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,available_at_ms INTEGER NOT NULL,ownership_at_ms INTEGER NOT NULL);
  CREATE TRIGGER IF NOT EXISTS creator_description_transfer AFTER UPDATE OF creator_id ON Place WHEN OLD.creator_id IS NOT NEW.creator_id BEGIN
   UPDATE ResearchBundle SET status='invalid' WHERE id IN(SELECT bundle_id FROM ResearchBundleMember WHERE user_id=OLD.creator_id OR user_id=NEW.creator_id);
   INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) SELECT bundle_id FROM ResearchBundleMember WHERE user_id=OLD.creator_id OR user_id=NEW.creator_id;
   DELETE FROM RatingEvidenceLink WHERE place_revision_id IN(SELECT place_revision_id FROM CreatorDescription WHERE place_id=NEW.id);
   UPDATE PlaceRevision SET author_id=NEW.creator_id,research_consent_id=NULL WHERE id IN(SELECT place_revision_id FROM CreatorDescription WHERE place_id=NEW.id);
   UPDATE Comment SET user_id=NEW.creator_id,rating=NULL,rating_revision=NULL WHERE id IN(SELECT comment_id FROM CreatorDescription WHERE place_id=NEW.id);
   DELETE FROM RatingTextEvidence WHERE NEW.creator_id IS NULL AND comment_id IN(SELECT comment_id FROM CreatorDescription WHERE place_id=NEW.id);
   UPDATE RatingTextEvidence SET user_id=NEW.creator_id,rating_revision=0,research_consent_id=NULL,available_at_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE NEW.creator_id IS NOT NULL AND comment_id IN(SELECT comment_id FROM CreatorDescription WHERE place_id=NEW.id);
   UPDATE CreatorDescription SET user_id=NEW.creator_id,ownership_at_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE place_id=NEW.id;
  END;`);
 const rows=sql.prepare(`SELECT p.id FROM Place p JOIN User u ON u.id=p.creator_id WHERE TRIM(COALESCE(p.description,''))<>'' AND NOT EXISTS(SELECT 1 FROM CreatorDescription d WHERE d.place_id=p.id)`).all();
 sql.transaction(()=>{for(const p of rows)bindCreatorDescription(sql,p.id,{now,source:'legacy_creator'});}).immediate();
}
function bindCreatorDescription(sql,placeId,{now=Date.now(),source='creator_submission',revisionId=null}={}){
 if(!has(sql,'CreatorDescription')||sql.prepare('SELECT 1 FROM CreatorDescription WHERE place_id=?').get(placeId))return false;
 const place=sql.prepare('SELECT * FROM Place WHERE id=?').get(placeId),body=require('./markdownText').markdownToPlainText(place?.description||'').trim(),text=judge.cleanText(body);if(!place?.creator_id||!text||!sql.prepare('SELECT 1 FROM User WHERE id=?').get(place.creator_id))return false;
 const grant=source==='creator_submission'?sql.prepare("SELECT * FROM ResearchConsentEvent WHERE user_id=? AND recorded_at_ms<=? ORDER BY recorded_at_ms DESC,rowid DESC LIMIT 1").get(place.creator_id,now):null;
 const consent=grant?.allowed&&!grant.revoked_at_ms?grant.id:null;
 if(!revisionId){revisionId=randomUUID();sql.prepare(`INSERT INTO PlaceRevision(id,place_id,author_id,executor_id,path,after_state,changed_fields,recorded_at_ms,available_at_ms,research_consent_id) VALUES(?,?,?,?,? ,?,'["description"]',?,?,?)`).run(revisionId,placeId,place.creator_id,place.creator_id,'creator_description_legacy',JSON.stringify({description:place.description}),now,now,consent);}
 const rating=sql.prepare('SELECT score FROM PlaceRating WHERE place_id=? AND user_id=?').get(placeId,place.creator_id),revision=sql.prepare('SELECT revision FROM RatingStream WHERE place_id=? AND user_id=?').get(placeId,place.creator_id)?.revision||0;
 const commentId=Number(sql.prepare('INSERT INTO Comment(place_id,user_id,content,rating,place_revision_id,rating_revision,time) VALUES(?,?,?,?,?,?,?)').run(placeId,place.creator_id,body,rating?.score??null,revisionId,revision||null,new Date(now).toISOString()).lastInsertRowid);
 sql.prepare('INSERT INTO CreatorDescription VALUES(?,?,?,?,?,?,?)').run(placeId,place.creator_id,commentId,revisionId,source,now,now);
 if(rating&&revision)sql.prepare(`INSERT OR IGNORE INTO RatingTextEvidence(comment_id,user_id,place_id,place_revision_id,rating_revision,content_hash,evidence_text,available_at_ms,expires_at_ms,judge_model,prompt_hash,research_consent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(commentId,place.creator_id,placeId,revisionId,revision,createHash('sha256').update(text).digest('hex'),text,now,now+90*86400000,process.env.RATING_TEXT_LLM_MODEL||process.env.DEEPSEEK_MODEL||'deepseek-flash',judge.PROMPT_HASH,consent);
 return true;
}
function syncCreatorDescriptionRating(sql,placeId){
 if(!has(sql,'CreatorDescription'))return;
 const binding=sql.prepare('SELECT * FROM CreatorDescription WHERE place_id=?').get(placeId);if(!binding?.user_id||!binding.comment_id)return;
 const rating=sql.prepare('SELECT score FROM PlaceRating WHERE place_id=? AND user_id=?').get(placeId,binding.user_id),revision=sql.prepare('SELECT revision FROM RatingStream WHERE place_id=? AND user_id=?').get(placeId,binding.user_id)?.revision||0;
 sql.prepare('UPDATE Comment SET rating=?,rating_revision=? WHERE id=?').run(rating?.score??null,rating?revision:null,binding.comment_id);
 if(rating)sql.prepare('UPDATE RatingTextEvidence SET rating_revision=? WHERE comment_id=? AND user_id=?').run(revision,binding.comment_id,binding.user_id);
}
module.exports={initCreatorDescriptions,bindCreatorDescription,syncCreatorDescriptionRating};
