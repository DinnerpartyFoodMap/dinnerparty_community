const {db}=require('../../../infrastructure/database');
const {randomUUID,createHash}=require('node:crypto');
function commandHash(placeId,score,action,confirm=false){return createHash('sha256').update(JSON.stringify({placeId,score,action,confirm})).digest('hex');}
function appendRatingRevision({userId,placeId,before,after,action,origin,now=Date.now(),eventId=randomUUID(),surface=null}){
    db._raw.prepare('INSERT OR IGNORE INTO RatingStream(user_id,place_id,revision) VALUES(?,?,0)').run(userId,placeId);
    const previous=db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(userId,placeId).revision;
    const revision=previous+1;
    const submission=['rate','change'].includes(action)||action==='create'&&origin==='creation_explicit';
    db._raw.prepare(`INSERT INTO RatingRevision(event_id,user_id,place_id,revision,previous_revision,action,before_state,after_state,origin,recorded_at_ms,available_at_ms,experience_time_ms,experience_time_basis,entry_surface,research_consent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId,userId,placeId,revision,previous||null,action,before?JSON.stringify(before):null,after?JSON.stringify(after):null,origin,now,now,submission?now:null,submission?'submission':null,surface,require('./ratingEvidence').researchConsent(userId,now)?.id||null);
    db._raw.prepare('UPDATE RatingStream SET revision=? WHERE user_id=? AND place_id=?').run(revision,userId,placeId);
    linkExistingDescriptions(userId,placeId,revision,now);return revision;
}
function linkExistingDescriptions(userId,placeId,revision,now){
    db._raw.prepare(`INSERT OR IGNORE INTO RatingEvidenceLink(user_id,place_id,rating_revision,place_revision_id,available_at_ms)
        SELECT ?,?,?,id,available_at_ms FROM PlaceRevision WHERE place_id=? AND author_id=? AND available_at_ms<=? AND changed_fields LIKE '%"description"%' AND TRIM(COALESCE(json_extract(after_state,'$.description'),''))<>''`).run(userId,placeId,revision,placeId,userId,now);
}
module.exports={appendRatingRevision,commandHash,linkExistingDescriptions};
