const {db}=require('../../../infrastructure/database');
const {randomUUID}=require('node:crypto');
const FIELDS=['name','description','category','per_person_cost','address','latitude','longitude','exterior_images','menu_images'];
function state(row){return Object.fromEntries(FIELDS.map(key=>[key,row?.[key]??null]));}
function recordPlaceRevision({placeId,authorId,executorId=authorId,path,before=null,after=null,requestId=null,now=Date.now(),recordedAt=now,researchConsentId}){
    after=after||db._raw.prepare('SELECT * FROM Place WHERE id=?').get(placeId);if(!after)return null;
    const a=state(before),b=state(after),fields=FIELDS.filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key]));if(!fields.length)return null;
    const id=randomUUID(),parent=db._raw.prepare('SELECT id FROM PlaceRevision WHERE place_id=? ORDER BY rowid DESC LIMIT 1').get(placeId)?.id||null;
    const consent=researchConsentId!==undefined?researchConsentId:authorId?require('../../ratings/services/ratingEvidence').researchConsent(authorId,recordedAt)?.id||null:null;
    db._raw.prepare(`INSERT INTO PlaceRevision(id,place_id,parent_revision,author_id,executor_id,path,before_state,after_state,changed_fields,recorded_at_ms,available_at_ms,request_id,research_consent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,placeId,parent,authorId||null,executorId||null,path,before?JSON.stringify(a):null,JSON.stringify(b),JSON.stringify(fields),recordedAt,now,requestId==null?null:String(requestId),consent);
    if(authorId&&fields.includes('description')&&String(b.description||'').trim()){
        const revision=db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(authorId,placeId)?.revision;
        if(revision&&db._raw.prepare('SELECT 1 FROM PlaceRating WHERE user_id=? AND place_id=?').get(authorId,placeId))db._raw.prepare('INSERT OR IGNORE INTO RatingEvidenceLink(user_id,place_id,rating_revision,place_revision_id,available_at_ms) VALUES(?,?,?,?,?)').run(authorId,placeId,revision,id,now);
    }
    return id;
}
module.exports={recordPlaceRevision};
