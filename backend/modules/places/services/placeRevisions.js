const {db}=require('../../../infrastructure/database');
const {randomUUID}=require('node:crypto');
const FIELDS=['name','description','category','per_person_cost','address','latitude','longitude','exterior_images','menu_images'];
function state(row){return Object.fromEntries(FIELDS.map(key=>[key,row?.[key]??null]));}
function publishRevisionComment(row,{noExperience=false,backfill=false}={}){
    if(db._raw.prepare('SELECT 1 FROM DeletedEditComment WHERE place_revision_id=?').get(row.id))return false;
    if(!row.before_state||!row.author_id||!['owner_edit','admin_edit','request_approved'].includes(row.path)||!db._raw.prepare('SELECT 1 FROM User WHERE id=?').get(row.author_id))return false;
    const diff=require('./placeEditDiff').editDiff(JSON.parse(row.before_state),JSON.parse(row.after_state));if(!diff.comment)return false;
    const historical=db._raw.prepare('SELECT revision,after_state FROM RatingRevision WHERE user_id=? AND place_id=? AND available_at_ms<=? ORDER BY revision DESC LIMIT 1').get(row.author_id,row.place_id,row.available_at_ms);
    const rating=historical?.after_state?JSON.parse(historical.after_state):null,revision=historical?.revision??null;
    const inserted=db._raw.prepare('INSERT OR IGNORE INTO Comment(place_id,user_id,content,rating,place_revision_id,rating_revision,time) VALUES(?,?,?,?,?,?,?)').run(row.place_id,row.author_id,diff.comment,rating?.score??null,row.id,revision,new Date(row.available_at_ms).toISOString());
    // Historical edits establish authorship, not a fresh dining experience or renewed retention.
    if(inserted.changes&&!noExperience&&!backfill)require('../../ratings/services/ratingTextEvidence').queueComment({commentId:Number(inserted.lastInsertRowid),userId:row.author_id,placeId:row.place_id,placeRevisionId:row.id,text:diff.text,now:row.available_at_ms,ratingRevision:revision});
    return !!inserted.changes;
}
function recordPlaceRevision({placeId,authorId,executorId=authorId,path,before=null,after=null,requestId=null,now=Date.now(),recordedAt=now,researchConsentId,noExperience=false}){
    after=after||db._raw.prepare('SELECT * FROM Place WHERE id=?').get(placeId);if(!after)return null;
    const a=state(before),b=state(after),fields=FIELDS.filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key]));if(!fields.length)return null;
    const id=randomUUID(),parent=db._raw.prepare('SELECT id FROM PlaceRevision WHERE place_id=? ORDER BY rowid DESC LIMIT 1').get(placeId)?.id||null;
    const consent=researchConsentId!==undefined?researchConsentId:authorId?require('../../ratings/services/ratingEvidence').researchConsent(authorId,recordedAt)?.id||null:null;
    db._raw.prepare(`INSERT INTO PlaceRevision(id,place_id,parent_revision,author_id,executor_id,path,before_state,after_state,changed_fields,recorded_at_ms,available_at_ms,request_id,research_consent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,placeId,parent,authorId||null,executorId||null,path,before?JSON.stringify(a):null,JSON.stringify(b),JSON.stringify(fields),recordedAt,now,requestId==null?null:String(requestId),consent);
    if(before&&authorId)publishRevisionComment(db._raw.prepare('SELECT * FROM PlaceRevision WHERE id=?').get(id),{noExperience});
    if(authorId&&fields.includes('description')&&String(b.description||'').trim()){
        const revision=db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(authorId,placeId)?.revision;
        if(revision&&db._raw.prepare('SELECT 1 FROM PlaceRating WHERE user_id=? AND place_id=?').get(authorId,placeId))db._raw.prepare('INSERT OR IGNORE INTO RatingEvidenceLink(user_id,place_id,rating_revision,place_revision_id,available_at_ms) VALUES(?,?,?,?,?)').run(authorId,placeId,revision,id,now);
    }
    return id;
}
function backfillEditComments({apply=false,limit=500}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('回填数量无效');
    const rows=db._raw.prepare(`SELECT r.* FROM PlaceRevision r JOIN User u ON u.id=r.author_id JOIN Place p ON p.id=r.place_id WHERE r.before_state IS NOT NULL AND r.path IN('owner_edit','admin_edit','request_approved') AND NOT EXISTS(SELECT 1 FROM DeletedEditComment d WHERE d.place_revision_id=r.id) AND NOT EXISTS(SELECT 1 FROM Comment c WHERE c.place_revision_id=r.id) ORDER BY r.available_at_ms LIMIT ?`).all(limit);
    if(!apply)return {apply:false,candidates:rows.length};
    const inserted=db._raw.transaction(()=>rows.filter(row=>publishRevisionComment(row,{backfill:true})).length).immediate();return {apply:true,candidates:rows.length,inserted};
}
module.exports={recordPlaceRevision,backfillEditComments};
