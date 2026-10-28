const {db,isVectorSearchAvailable}=require('../../../infrastructure/database');
const {EMBEDDING_MODEL,EMBEDDING_DIMENSIONS}=require('../../../infrastructure/aiClients');
const client=require('../../../infrastructure/numericAlgorithmClient');
const {decodeVector}=require('./vectorCodec');
const {randomUUID}=require('node:crypto');
const ALGORITHM_VERSION=2,REFRESH_MS=6*3600000;
const pending=new Map(),queued=new Map();
function publicPreference(row){if(!row)return null;const vector=decodeVector(row.vector);return {
    status:row.status,vector:vector?Array.from(vector):null,model:row.model,dimensions:row.dimensions,algorithm_version:row.algorithm_version,
    source_place_count:row.source_place_count,vector_place_count:row.vector_place_count,total_weight:row.total_weight,updated_at:row.updated_at};}
function collectPreferenceInput(userId,now=Date.now(),mutation=null){return db._raw.transaction(()=>{
    if(!db._raw.prepare('SELECT id FROM User WHERE id=?').get(userId))return null;
    const row=db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get(userId);
    const favorites=db._raw.prepare('SELECT f.place_id FROM Favorite f JOIN Place p ON p.id=f.place_id WHERE f.user_id=?').all(userId).map(x=>x.place_id);
    let ratings=db._raw.prepare('SELECT r.place_id,r.score FROM PlaceRating r JOIN Place p ON p.id=r.place_id WHERE r.user_id=?').all(userId);
    if(mutation){ratings=ratings.filter(x=>x.place_id!==mutation.place_id);if(mutation.score!==null)ratings.push({place_id:mutation.place_id,score:mutation.score});ratings.sort((a,b)=>a.place_id-b.place_id);}
    const behaviors=db._raw.prepare(`SELECT e.place_id,e.event_type,e.occurred_at,e.contributes FROM UserBehaviorEvent e JOIN Place p ON p.id=e.place_id WHERE e.user_id=? AND e.occurred_at>=? AND e.occurred_at<=? AND e.contributes=1`).all(userId,now-180*86400000,now);
    const ids=new Set([...favorites,...ratings.map(x=>x.place_id),...behaviors.map(x=>x.place_id)]),vectors=[];
    const available=isVectorSearchAvailable();if(available){const read=db._raw.prepare('SELECT v.embedding FROM place_vectors v JOIN Place p ON p.id=v.place_id WHERE v.place_id=? AND p.has_vector=1');for(const id of ids){const b=read.get(BigInt(id))?.embedding;if(decodeVector(b))vectors.push({place_id:id,embedding:b.toString('base64')});}}
    return {contract_version:1,dataset_id:process.env.ALGORITHM_DATASET_ID||'primary',snapshot_id:randomUUID(),input_revision:row?.input_revision||0,as_of_ms:now,
        user_id:userId,model:EMBEDDING_MODEL,dimensions:EMBEDDING_DIMENSIONS,algorithm_version:ALGORITHM_VERSION,available,favorites,ratings,behaviors,vectors};
})();}
function persistPreference(userId,result,expectedRevision){
    const row=db._raw.prepare('SELECT input_revision FROM UserPreference WHERE user_id=?').get(userId);
    if((row?.input_revision||0)!==expectedRevision||!db._raw.prepare('SELECT id FROM User WHERE id=?').get(userId))return false;
    if(result.model!==EMBEDDING_MODEL||result.algorithm_version!==ALGORITHM_VERSION)return false;
    const vector=result.vector_b64===null?null:Buffer.from(result.vector_b64,'base64');
    db._raw.prepare(`INSERT INTO UserPreference(user_id,vector,model,dimensions,algorithm_version,status,source_place_count,vector_place_count,total_weight,updated_at,dirty,input_revision,computed_input_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET vector=excluded.vector,model=excluded.model,dimensions=excluded.dimensions,algorithm_version=excluded.algorithm_version,status=excluded.status,source_place_count=excluded.source_place_count,vector_place_count=excluded.vector_place_count,total_weight=excluded.total_weight,updated_at=excluded.updated_at,dirty=0,computed_input_revision=excluded.computed_input_revision`)
        .run(userId,vector,result.model,result.dimensions,result.algorithm_version,result.status,result.source_place_count,result.vector_place_count,result.total_weight,result.updated_at,row?.input_revision||1,row?.input_revision||1);
    return true;
}
async function rebuild(userId,signal){
    for(let attempt=0;attempt<2;attempt++){
        if(signal.aborted)throw client.failure(503,'aborted');
        const input=collectPreferenceInput(userId);if(!input)return null;
        const result=await client.compute('preference',input,{signal});
        if(signal.aborted)throw client.failure(503,'aborted');
        const saved=db._raw.transaction(()=>persistPreference(userId,result,input.input_revision)).immediate();
        if(saved)return publicPreference(db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get(userId));
    }
    throw client.failure(409,'stale_input');
}
async function getUserPreference(userId){
    const row=db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get(userId),now=Date.now();
    if(isFreshPreference(row,now))return publicPreference(row);
    if(pending.has(userId))return pending.get(userId).promise;
    const controller=new AbortController(),entry={controller,promise:null};
    entry.promise=rebuild(userId,controller.signal).finally(()=>{if(pending.get(userId)===entry)pending.delete(userId);});pending.set(userId,entry);return entry.promise;
}
function isFreshPreference(row,now=Date.now()){
    return !!row&&!row.dirty&&row.input_revision===row.computed_input_revision&&row.model===EMBEDDING_MODEL&&row.dimensions===EMBEDDING_DIMENSIONS&&row.algorithm_version===ALGORITHM_VERSION&&now-row.updated_at<REFRESH_MS;
}
function queueUserVectorRefresh(userId){
    if(queued.has(userId))return;
    queued.set(userId,setImmediate(()=>{queued.delete(userId);getUserPreference(userId).catch(()=>console.warn('User vector refresh unavailable'));}));
}
function refreshUserVectorBatch(limit=20){
    const users=db._raw.prepare(`SELECT user_id FROM UserPreference WHERE dirty=1 OR input_revision<>computed_input_revision OR updated_at IS NULL OR updated_at<=? OR model<>? OR algorithm_version<>? ORDER BY dirty DESC,COALESCE(updated_at,0),user_id LIMIT ?`).all(Date.now()-REFRESH_MS,EMBEDDING_MODEL,ALGORITHM_VERSION,limit);
    for(const {user_id}of users)queueUserVectorRefresh(user_id);return users.length;
}
function startUserVectorWorker(){const run=()=>{try{refreshUserVectorBatch();}catch{console.warn('User vector worker unavailable');}};const initial=setTimeout(run,1000),interval=setInterval(run,60000);initial.unref?.();interval.unref?.();return()=>{clearTimeout(initial);clearInterval(interval);for(const h of queued.values())clearImmediate(h);queued.clear();for(const e of pending.values())e.controller.abort();};}
module.exports={getUserPreference,collectPreferenceInput,persistPreference,publicPreference,isFreshPreference,queueUserVectorRefresh,refreshUserVectorBatch,startUserVectorWorker,ALGORITHM_VERSION,REFRESH_MS};
