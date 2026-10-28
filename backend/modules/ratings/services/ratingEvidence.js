const {db}=require('../../../infrastructure/database');
const {randomUUID}=require('node:crypto');
const {context}=require('./ratingSnapshot');
const client=require('../../../infrastructure/numericAlgorithmClient');
const PURPOSE_VERSION='rating-research-v1';
function researchConsent(userId,at=Date.now()){
    const settings=db._raw.prepare('SELECT feedback,research FROM MapConsent WHERE user_id=?').get(userId);
    if(!settings?.feedback||!settings.research)return null;
    const event=db._raw.prepare('SELECT * FROM ResearchConsentEvent WHERE user_id=? AND recorded_at_ms<=? ORDER BY recorded_at_ms DESC,rowid DESC LIMIT 1').get(userId,at);
    return event?.allowed&&!event.revoked_at_ms&&event.purpose_version===PURPOSE_VERSION?event:null;
}
function hasResearchBasis(userId,consentId,at=Date.now()){
    if(!consentId||!researchConsent(userId,at))return false;
    return !!db._raw.prepare('SELECT 1 FROM ResearchConsentEvent WHERE id=? AND user_id=? AND allowed=1 AND revoked_at_ms IS NULL AND purpose_version=? AND recorded_at_ms<=?').get(consentId,userId,PURPOSE_VERSION,at);
}
function invalidateUserBundles(userId){
    db._raw.prepare("UPDATE ResearchBundle SET status='invalid' WHERE id IN(SELECT bundle_id FROM ResearchBundleMember WHERE user_id=?)").run(userId);
    db._raw.prepare('INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) SELECT bundle_id FROM ResearchBundleMember WHERE user_id=?').run(userId);
}
function recordResearchChoice(userId,allowed,now=Date.now()){
    if(!allowed){db._raw.prepare('UPDATE ResearchConsentEvent SET revoked_at_ms=? WHERE user_id=? AND allowed=1 AND revoked_at_ms IS NULL').run(now,userId);db._raw.prepare('UPDATE AlgorithmEventContext SET research_allowed=0 WHERE user_id=?').run(userId);}
    const id=randomUUID();db._raw.prepare('INSERT INTO ResearchConsentEvent(id,user_id,allowed,purpose_version,recorded_at_ms) VALUES(?,?,?,?,?)').run(id,userId,+allowed,PURPOSE_VERSION,now);
    if(!allowed)invalidateUserBundles(userId);return id;
}
function captureEvent(source,userId,eventId,{trigger='unknown',surface=null,decisionId=null,impressionId=null}={}){
    const now=Date.now(),consent=researchConsent(userId,now);
    let behavior=null,interaction=null;
    if(source==='UserBehaviorEvent')behavior=db._raw.prepare('SELECT id FROM UserBehaviorEvent WHERE user_id=? AND event_id=?').get(userId,eventId)?.id;
    else interaction=db._raw.prepare('SELECT id FROM MapInteraction WHERE user_id=? AND id=?').get(userId,eventId)?.id;
    if(behavior==null&&interaction==null)return;
    db._raw.prepare(`INSERT OR IGNORE INTO AlgorithmEventContext(source_table,event_id,user_id,behavior_id,interaction_id,consent_ref,research_allowed,trigger_kind,surface,decision_id,impression_id,recorded_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(source,eventId,userId,behavior,interaction,consent?.id||null,+!!consent,['user','programmatic'].includes(trigger)?trigger:'unknown',surface,decisionId,impressionId,now);
}
function buildRatingEvidence({userIds=null,placeIds=null,asOfMs=Date.now(),purpose='research',windowMs=30*86400000}={}){
    const users=userIds?new Set(userIds):null,places=placeIds?new Set(placeIds):null,cutoff=asOfMs-Math.min(windowMs,30*86400000),seen=new Map();let excluded=0,deduplicated=0;
    const allowed=(userId,meta)=>purpose!=='research'||!!(meta?.research_allowed&&hasResearchBasis(userId,meta.consent_ref,asOfMs));
    const push=(row,source)=>{
        if(users&&!users.has(row.user_id)||places&&!places.has(row.place_id))return;
        const at=source==='UserBehaviorEvent'?row.occurred_at:Date.parse(row.created_at);
        if(!Number.isFinite(at)||at<cutoff||at>asOfMs)return;
        const eventId=source==='UserBehaviorEvent'?row.event_id:row.id;
        const meta=db._raw.prepare('SELECT * FROM AlgorithmEventContext WHERE source_table=? AND user_id=? AND event_id=?').get(source,row.user_id,eventId);
        if(!allowed(row.user_id,meta)){excluded++;return;}
        const event={event_id:eventId,event_type:source==='UserBehaviorEvent'?row.event_type:({favorite:'favorite_add',unfavorite:'favorite_remove'}[row.kind]||row.kind),user_key:row.user_id,place_id:row.place_id,occurred_at_ms:at,recorded_at_ms:meta?.recorded_at_ms||at,available_at_ms:meta?.recorded_at_ms||at,source_table:source,source_event_id:source==='UserBehaviorEvent'?row.id:row.id,surface:meta?.surface||row.surface||null,trigger:meta?.trigger_kind||'unknown',decision_id:meta?.decision_id||row.decision_id||null,impression_id:meta?.impression_id||null,contributes:row.contributes??null,consent_ref:meta?.consent_ref||null,contract_version:1};
        const key=`${row.user_id}|${eventId}`;if(seen.has(key)){deduplicated++;if(source==='UserBehaviorEvent')seen.set(key,event);}else seen.set(key,event);
    };
    // Original behavior rows take precedence over the favorites feedback mirror.
    for(const row of db._raw.prepare('SELECT * FROM UserBehaviorEvent WHERE occurred_at>=? AND occurred_at<=? ORDER BY occurred_at,id').all(cutoff,asOfMs))push(row,'UserBehaviorEvent');
    for(const row of db._raw.prepare('SELECT * FROM MapInteraction WHERE created_at>=? AND created_at<=? ORDER BY created_at,id').all(new Date(cutoff).toISOString(),new Date(asOfMs).toISOString())){
        if(seen.has(`${row.user_id}|${row.id}`)){deduplicated++;continue;}push(row,'MapInteraction');
    }
    const events=[...seen.values()].sort((a,b)=>a.occurred_at_ms-b.occurred_at_ms||a.source_table.localeCompare(b.source_table)||String(a.source_event_id).localeCompare(String(b.source_event_id)));
    const states=[];for(const r of db._raw.prepare('SELECT user_id,place_id FROM Favorite').all())if((!users||users.has(r.user_id))&&(!places||places.has(r.place_id))&&(purpose!=='research'||researchConsent(r.user_id,asOfMs)))states.push({...r,kind:'favorite_state',available_at_ms:asOfMs});
    return {...context(asOfMs),purpose,events,states,manifest:{contract_version:1,purpose_version:PURPOSE_VERSION,from_ms:cutoff,to_ms:asOfMs,excluded,deduplicated,count:events.length,state_count:states.length,retention_days:30}};
}
let worker=null;
function queueEvidence(userId){
    db._raw.prepare('INSERT INTO AlgorithmEvidenceQueue(user_id,updated_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at').run(userId,Date.now());
}
async function sendEvidence(userId){
    const queued=db._raw.prepare('SELECT revision FROM AlgorithmEvidenceQueue WHERE user_id=?').get(userId);if(!queued)return;
    const data=buildRatingEvidence({userIds:[userId],purpose:'research'});if(data.events.length)await client.compute('evidence',data);
    db._raw.prepare('DELETE FROM AlgorithmEvidenceQueue WHERE user_id=? AND revision=?').run(userId,queued.revision);
}
function startEvidenceWorker(){let stopped=false,busy=false;const run=async()=>{if(stopped||busy)return;busy=true;try{for(const row of db._raw.prepare('SELECT user_id FROM AlgorithmEvidenceQueue ORDER BY updated_at LIMIT 20').all()){if(stopped)break;try{await sendEvidence(row.user_id);}catch{/* Original source remains available for the next bounded retry. */}}}finally{busy=false;}};const interval=setInterval(run,60000),initial=setTimeout(run,1000);interval.unref?.();initial.unref?.();worker=()=>{stopped=true;clearInterval(interval);clearTimeout(initial);};return worker;}
module.exports={PURPOSE_VERSION,researchConsent,hasResearchBasis,recordResearchChoice,invalidateUserBundles,captureEvent,buildRatingEvidence,queueEvidence,sendEvidence,startEvidenceWorker};
