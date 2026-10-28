const {db}=require('../../../infrastructure/database');
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash,createHmac}=require('node:crypto');
const evidence=require('./ratingEvidence');
function root(){return path.resolve(process.env.RATING_EVIDENCE_ROOT||path.join(__dirname,'../../../../.private/journey-algorithm-service/datasets'));}
function filename(key){if(!/^[a-f0-9-]{36}\.json$/.test(key))throw new Error('非法受控路径');const result=path.resolve(root(),key);if(path.dirname(result)!==root())throw new Error('非法受控路径');return result;}
function bundleStatus(id,now=Date.now()){
    const r=db._raw.prepare('SELECT * FROM ResearchBundle WHERE id=?').get(id);if(!r)return {id,valid:false};
    const members=db._raw.prepare('SELECT user_id FROM ResearchBundleMember WHERE bundle_id=?').all(id);
    const missingPlace=db._raw.prepare('SELECT 1 FROM ResearchBundlePlace bp LEFT JOIN Place p ON p.id=bp.place_id WHERE bp.bundle_id=? AND p.id IS NULL LIMIT 1').get(id);
    const valid=r.status==='valid'&&r.expires_at>now&&!missingPlace&&members.every(x=>evidence.researchConsent(x.user_id,now));
    return {id,valid,hash:r.hash,expires_at:r.expires_at};
}
function state(value){if(!value)return null;const r=JSON.parse(value);return Object.fromEntries(['score','source','created_at','updated_at'].map(k=>[k,r[k]??null]));}
function descriptionContribution(row){
    const before=String(row.before_state?JSON.parse(row.before_state).description||'':''),after=String(JSON.parse(row.after_state).description||'');
    if(!before)return {after_description:after,contribution_text:after,text_basis:'submitted_new_text'};
    if(after.startsWith(before))return {after_description:null,contribution_text:after.slice(before.length),text_basis:'appended_text'};
    if(after.endsWith(before))return {after_description:null,contribution_text:after.slice(0,after.length-before.length),text_basis:'prepended_text'};
    // Arbitrary edits can retain another author's words. Keep the revision metadata
    // for provenance, without treating its entire replacement as this author's prose.
    return {after_description:null,contribution_text:null,text_basis:'mixed_or_replaced_unresolved'};
}
function decisionSnapshots(data,now){
    const decisions=new Map(),places=new Set(db._raw.prepare('SELECT id FROM Place').all().map(p=>p.id));
    for(const event of data.events){
        if(!event.decision_id||decisions.has(event.decision_id))continue;
        const row=db._raw.prepare('SELECT * FROM MapDecision WHERE id=? AND user_id=?').get(event.decision_id,event.user_key);
        const at=Date.parse(row?.created_at),grant=db._raw.prepare('SELECT recorded_at_ms FROM ResearchConsentEvent WHERE id=?').get(event.consent_ref);
        if(!row||!Number.isFinite(at)||at<data.manifest.from_ms||at>now||!grant||grant.recorded_at_ms>at)continue;
        const source=JSON.parse(row.snapshot),result=JSON.parse(row.result);
        if(!Array.isArray(source.candidates)||source.candidates.some(p=>!places.has(p.place_id)))continue;
        decisions.set(row.id,{id:row.id,user_id:row.user_id,created_at_ms:at,algorithm:source.algorithm||null,policy_version:source.policy_version||null,feature_snapshot_version:source.feature_snapshot_version??null,display_version:source.display_version||null,surface:source.surface||null,personalized:source.personalized??null,selected_place_id:Number.isSafeInteger(result.place?.id)?result.place.id:null,selected_probability:Number.isFinite(source.selected_probability)?source.selected_probability:null,candidates:source.candidates.map(p=>({place_id:p.place_id,rank:Number.isSafeInteger(p.rank)?p.rank:null,probability:Number.isFinite(p.probability)?p.probability:null}))});
    }
    return [...decisions.values()];
}
function exportBundle({apply=false,secret=process.env.FEEDBACK_EXPORT_SECRET,output=root(),now=Date.now()}={}){
    if(path.resolve(output)!==root())throw new Error('研究包仅允许写入受控 datasets 目录');
    if(typeof secret!=='string'||secret.length<32)throw new Error('导出假名密钥须至少32字符');
    const key=id=>createHmac('sha256',secret).update(id).digest('hex').slice(0,32);
    const raw=db._raw.transaction(()=>{
        const data=evidence.buildRatingEvidence({purpose:'research',asOfMs:now}),cutoff=data.manifest.from_ms;
        const eligible=(user,ref)=>evidence.hasResearchBasis(user,ref,now);
        const ratings=db._raw.prepare('SELECT * FROM RatingRevision WHERE available_at_ms>=? AND available_at_ms<=? ORDER BY available_at_ms,rowid').all(cutoff,now).filter(r=>eligible(r.user_id,r.research_consent_id));
        const descriptions=db._raw.prepare('SELECT * FROM PlaceRevision WHERE available_at_ms>=? AND available_at_ms<=? ORDER BY available_at_ms,rowid').all(cutoff,now).filter(r=>r.author_id&&JSON.parse(r.changed_fields).includes('description')&&String(JSON.parse(r.after_state).description||'').trim()&&eligible(r.author_id,r.research_consent_id));
        const ratingKeys=new Set(ratings.map(r=>`${r.user_id}|${r.place_id}|${r.revision}`)),descriptionIds=new Set(descriptions.map(r=>r.id));
        const reasonLinks=db._raw.prepare('SELECT * FROM RatingEvidenceLink WHERE available_at_ms>=? AND available_at_ms<=?').all(cutoff,now).filter(r=>ratingKeys.has(`${r.user_id}|${r.place_id}|${r.rating_revision}`)&&descriptionIds.has(r.place_revision_id));
        const decisions=decisionSnapshots(data,now);
        const users=new Set([...data.events.map(x=>x.user_key),...data.states.map(x=>x.user_id),...ratings.map(x=>x.user_id),...descriptions.map(x=>x.author_id)]);
        const places=new Set([...data.events.map(x=>x.place_id),...data.states.map(x=>x.place_id),...ratings.map(x=>x.place_id),...descriptions.map(x=>x.place_id),...decisions.flatMap(d=>d.candidates.map(p=>p.place_id))].filter(x=>x!=null));
        const times=[...data.events.map(x=>x.recorded_at_ms),...ratings.map(x=>x.available_at_ms),...descriptions.map(x=>x.available_at_ms),...decisions.map(d=>d.created_at_ms)];
        return {data,ratings,descriptions,reasonLinks,decisions,users:[...users],places:[...places],expires_at:times.reduce((expiry,t)=>Math.min(expiry,t+30*86400000),now+30*86400000)};
    })();
    if(!apply)return {applied:false,event_count:raw.data.events.length,rating_count:raw.ratings.length,description_count:raw.descriptions.length,user_count:raw.users.length,excluded:raw.data.manifest.excluded};
    if(process.env.RATING_EVIDENCE_EXPORT_ENABLED!=='true')throw new Error('研究导出尚未启用');
    if(!raw.users.length||raw.expires_at<=now)throw new Error('没有符合用途和期限的研究样本');
    const id=randomUUID();
    const payload={schema_version:1,id,manifest:{...raw.data.manifest,input_revision:raw.data.input_revision,expires_at:raw.expires_at,pseudonymization:'HMAC-SHA256'},
        events:raw.data.events.map(e=>({...e,user_key:key(e.user_key)})),
        states:raw.data.states.map(({user_id,...r})=>({...r,user_key:key(user_id)})),
        rating_revisions:raw.ratings.map(r=>({event_id:r.event_id,user_key:key(r.user_id),place_id:r.place_id,revision:r.revision,previous_revision:r.previous_revision,action:r.action,origin:r.origin,before:state(r.before_state),after:state(r.after_state),recorded_at_ms:r.recorded_at_ms,available_at_ms:r.available_at_ms,experience_time_ms:r.experience_time_ms,experience_time_basis:r.experience_time_basis,entry_surface:r.entry_surface,rating_scale_version:r.rating_scale_version,consent_ref:r.research_consent_id})),
        reason_links:raw.reasonLinks.map(({user_id,...r})=>({...r,user_key:key(user_id)})),
        decisions:raw.decisions.map(({user_id,...r})=>({...r,user_key:key(user_id)})),
        description_revisions:raw.descriptions.map(r=>({id:r.id,place_id:r.place_id,parent_revision:r.parent_revision,author_key:key(r.author_id),before_description:null,before_text_basis:'not_exported',...descriptionContribution(r),changed_fields:['description'],recorded_at_ms:r.recorded_at_ms,available_at_ms:r.available_at_ms,consent_ref:r.research_consent_id}))};
    const bytes=JSON.stringify(payload),hash=createHash('sha256').update(bytes).digest('hex'),file=filename(`${id}.json`);
    if(Buffer.byteLength(bytes)>32*1024*1024)throw new Error('研究包超过32MiB，请缩小导出窗口或分批');
    db._raw.transaction(()=>{
        if(!raw.users.every(user=>evidence.researchConsent(user)))throw new Error('研究设置已变化');
        db._raw.prepare('INSERT INTO ResearchBundle(id,hash,path_key,status,expires_at,input_revision) VALUES(?,?,?,?,?,?)').run(id,hash,`${id}.json`,'pending',raw.expires_at,raw.data.input_revision);
        for(const user of raw.users)db._raw.prepare('INSERT INTO ResearchBundleMember(bundle_id,user_id) VALUES(?,?)').run(id,user);
        for(const place of raw.places)db._raw.prepare('INSERT INTO ResearchBundlePlace(bundle_id,place_id) VALUES(?,?)').run(id,place);
    }).immediate();
    try{
        fs.mkdirSync(root(),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
        db._raw.transaction(()=>{if(!raw.users.every(user=>evidence.researchConsent(user))||!raw.places.every(place=>db._raw.prepare('SELECT id FROM Place WHERE id=?').get(place)))throw new Error('研究输入已失效');db._raw.prepare("UPDATE ResearchBundle SET status='valid' WHERE id=? AND status='pending'").run(id);}).immediate();
    }catch(e){db._raw.prepare("UPDATE ResearchBundle SET status='invalid' WHERE id=?").run(id);db._raw.prepare('INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) VALUES(?)').run(id);throw e;}
    return {applied:true,id,hash,expires_at:raw.expires_at,event_count:payload.events.length};
}
function purgeBundles(now=Date.now()){
    db._raw.transaction(()=>{db._raw.prepare("UPDATE ResearchBundle SET status='invalid' WHERE expires_at<=?").run(now);db._raw.prepare("INSERT OR IGNORE INTO ResearchBundlePurge(bundle_id) SELECT id FROM ResearchBundle WHERE status='invalid'").run();})();
    let deleted=0,failed=0;
    for(const r of db._raw.prepare('SELECT b.* FROM ResearchBundlePurge p JOIN ResearchBundle b ON b.id=p.bundle_id').all()){
        try{fs.rmSync(filename(r.path_key),{force:true});db._raw.transaction(()=>{db._raw.prepare('DELETE FROM ResearchBundlePurge WHERE bundle_id=?').run(r.id);db._raw.prepare("UPDATE ResearchBundle SET status='deleted' WHERE id=?").run(r.id);})();deleted++;}
        catch{db._raw.prepare('UPDATE ResearchBundlePurge SET attempts=attempts+1 WHERE bundle_id=?').run(r.id);failed++;}
    }
    return {deleted,failed};
}
function startBundleWorker(){const tick=()=>{try{purgeBundles();}catch{console.warn('Research bundle cleanup unavailable');}};const interval=setInterval(tick,60000);interval.unref?.();return()=>clearInterval(interval);}
module.exports={root,exportBundle,bundleStatus,purgeBundles,startBundleWorker};
