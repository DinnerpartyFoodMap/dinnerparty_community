const {db,isVectorSearchAvailable}=require('../../../infrastructure/database');
const {EMBEDDING_MODEL}=require('../../../infrastructure/aiClients');
const client=require('../../../infrastructure/numericAlgorithmClient');
const preferences=require('../../preferences/services/userPreferenceService');
const vectorAdapter=require('../../preferences/services/userVectorAdapter');
const summaryAdapter=require('./ratingSummaryAdapter');
const {context,same,profileRows}=require('./ratingSnapshot');
const {placeMeanVector,resetMeanVectorCache}=require('./meanVectorAdapter');
const {userRatingWeight,encodeMean}=require('./ratingReputation');
const {appendRatingRevision,commandHash}=require('./ratingHistory');
const RATING_SCORES=Object.freeze([1,2,3,4]),AVOID_BELOW_AVERAGE=2.5,OFFSET=8*3600000,DAY=86400000;
function fail(status,message){throw Object.assign(new Error(message),{status,publicMessage:message});}
function isValidScore(n){return Number.isInteger(n)&&RATING_SCORES.includes(n);}
function ratingTier(n){return n==null||!Number.isFinite(Number(n))?null:Math.max(1,Math.min(4,Math.floor(Number(n)+0.5)));}
function defaultCreationScore(category){return (Array.isArray(category)?category:[category]).some(x=>String(x||'').includes('避雷'))?1:4;}
function isAvoidedPlace(p){return p?Number(p.rating_count)>0?Number(p.rating_average)<AVOID_BELOW_AVERAGE:String(p.category||'').includes('避雷'):false;}
function dailyLimit(){const n=parseInt(process.env.PLACE_RATING_DAILY_LIMIT,10);return Number.isSafeInteger(n)&&n>=1&&n<=1000?n:10;}
function quotaDay(now=Date.now()){return new Date(now+OFFSET).toISOString().slice(0,10);}
function quotaResetsAt(now=Date.now()){return (Math.floor((now+OFFSET)/DAY)+1)*DAY-OFFSET;}
function ratingQuota(userId,placeId=null,now=Date.now()){
    const rows=db._raw.prepare("SELECT DISTINCT place_id FROM PlaceRatingEvent WHERE user_id=? AND quota_day=? AND action='rate'").all(userId,quotaDay(now)),limit=dailyLimit();
    return {limit,used:rows.length,remaining:Math.max(0,limit-rows.length),place_counted:placeId!==null&&rows.some(x=>x.place_id===placeId),resets_at:quotaResetsAt(now)};
}
function requirePlace(id,viewerId=null){if(!/^[1-9]\d*$/.test(String(id))||!Number.isSafeInteger(Number(id)))fail(400,'无效的地点');id=Number(id);if(!db._raw.prepare("SELECT id FROM Place WHERE id=? AND (moderation_status='visible' OR creator_id=?)").get(id,viewerId))fail(404,'地点不存在');return id;}
function ownRating(id,userId){const r=db._raw.prepare('SELECT score,source,updated_at FROM PlaceRating WHERE place_id=? AND user_id=?').get(id,userId);return r||null;}
function insertCreationRating(placeId,userId,score,now=Date.now(),origin='unknown'){
    if(!userId||!isValidScore(score))return;
    const result=db._raw.prepare(`INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at,weight) SELECT ?,id,?,'create',?,?,? FROM User WHERE id=? ON CONFLICT(place_id,user_id) DO NOTHING`).run(placeId,score,now,now,userRatingWeight(userId),userId);
    if(result.changes)appendRatingRevision({userId,placeId,before:null,after:db._raw.prepare('SELECT * FROM PlaceRating WHERE place_id=? AND user_id=?').get(placeId,userId),action:'create',origin,now});
}
async function tasteInput(viewerId,placeId=null,readViewerPreference=preferences.getUserPreference){
    for(let attempt=0;attempt<2;attempt++){
        const snapshot=context();
        const viewer=await readViewerPreference(viewerId);
        const mean=isVectorSearchAvailable()?encodeMean(await placeMeanVector()):null;
        const input=db._raw.transaction(()=>{
            if(!same(snapshot.input_revision))return null;
            return {...snapshot,viewer_id:viewerId,viewer,mean,model:EMBEDDING_MODEL,profiles:profileRows(),ratings:summaryAdapter.readRatings().filter(r=>placeId==null||r.place_id===placeId),...(placeId==null?{}:{place_id:placeId})};
        })();
        if(input)return input;
    }
    throw client.failure(409,'stale_input');
}
async function personalizedSummarySnapshot(placeId,viewerId,{readViewerPreference=preferences.getUserPreference}={}){
    for(let n=0;n<2;n++){const input=await tasteInput(viewerId,placeId,readViewerPreference),r=await client.compute('ratingview',input);if(same(input.input_revision))return {input_revision:input.input_revision,personalized:r.personalized};}throw client.failure(409,'stale_input');
}
async function personalizedSummary(placeId,viewerId,options){return (await personalizedSummarySnapshot(placeId,viewerId,options)).personalized;}
async function personalizedAveragesSnapshot(viewerId,{readViewerPreference=preferences.getUserPreference}={}){
    for(let n=0;n<2;n++){const input=await tasteInput(viewerId,null,readViewerPreference),r=await client.compute('personalaverages',input);if(same(input.input_revision))return {input_revision:input.input_revision,averages:new Map(r.averages.map(x=>[x.place_id,x.average]))};}throw client.failure(409,'stale_input');
}
async function personalizedAverages(viewerId,options){return (await personalizedAveragesSnapshot(viewerId,options)).averages;}
async function ratingState(placeId,viewer=null){
    const id=requirePlace(placeId,viewer?.id);
    for(let attempt=0;attempt<2;attempt++){
        let personal=null;
        if(viewer)try{personal=await personalizedSummarySnapshot(id,viewer.id);}catch(e){if(e.status===409)continue;console.warn('Personalized rating unavailable');}
        let publicResult;
        try{publicResult=await summaryAdapter.ratingSummarySnapshot(id);}catch(e){if(e.status===409)continue;throw e;}
        if(!same(publicResult.input_revision)||personal&&personal.input_revision!==publicResult.input_revision)continue;
        requirePlace(id,viewer?.id);
        return {place_id:id,summary:publicResult.summary,mine:viewer?ownRating(id,viewer.id):null,personalized:personal?.personalized??null,quota:viewer?ratingQuota(viewer.id,id):null};
    }
    throw client.failure(409,'stale_input');
}
function priorCommand(userId,requestId,hash){if(!requestId)return null;const r=db._raw.prepare('SELECT * FROM RatingCommand WHERE user_id=? AND request_id=?').get(userId,requestId);if(r&&r.input_hash!==hash)fail(409,'请求编号已用于其他评价');return r;}
async function replay(user,id,command){
    try{return await ratingState(id,user);}catch(e){if(e.status===404)throw e;throw Object.assign(new Error('评价已保存，最新汇总暂不可用，请刷新'),{status:503,publicMessage:'评价已保存，最新汇总暂不可用，请刷新',committed:true,request_id:command.request_id});}
}
async function mutate(user,placeId,score,options={}){
    const id=requirePlace(placeId,user.id),withdraw=score===null;
    if(!withdraw&&!isValidScore(score))fail(400,'请选择一个评价');
    const requestId=options.requestId;if(requestId!==undefined&&(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)))fail(400,'请求编号无效');
    if(options.confirm&&!requestId)fail(400,'确认评价需要请求编号');
    const hash=commandHash(id,score,withdraw?'withdraw':'rate',!withdraw&&options.confirm===true),oldCommand=priorCommand(user.id,requestId,hash);if(oldCommand)return replay(user,id,oldCommand);
    for(let attempt=0;attempt<2;attempt++){
        const now=Date.now();let mean=null;if(isVectorSearchAvailable())mean=encodeMean(await placeMeanVector(now));
        const input=db._raw.transaction(()=>{
            require('../../accounts/services/userAccess').requireWritableUser(user.id);
            requirePlace(id,user.id);const before=db._raw.prepare('SELECT * FROM PlaceRating WHERE user_id=? AND place_id=?').get(user.id,id)||null;
            const changed=withdraw?!!before:!before||before.score!==score;
            if(changed&&!withdraw){const q=ratingQuota(user.id,id,now);if(!q.place_counted&&q.used>=q.limit)fail(429,`今天已经评价了 ${q.limit} 家店，明天再来吧`);}
            const after=withdraw?null:changed?{place_id:id,user_id:user.id,score,source:'user',created_at:before?.created_at??now,updated_at:now,weight:userRatingWeight(user.id)}:before;
            const ratings=summaryAdapter.readRatings().filter(r=>r.place_id===id&&r.user_id!==user.id);if(after)ratings.push({...after,is_banned:0});
            const stored=db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get(user.id);
            const viewer= !changed&&vectorAdapter.isFreshPreference(stored,now)?vectorAdapter.publicPreference(stored):null;
            return {...context(now),place_id:id,viewer_id:user.id,model:EMBEDDING_MODEL,mean,ratings,profiles:profileRows(),...(viewer?{viewer}:{viewer_input:vectorAdapter.collectPreferenceInput(user.id,now,changed?{place_id:id,score}:null)}),before,after,changed};
        })();
        const result=await client.compute('ratingview',input);
        const committed=db._raw.transaction(()=>{
            const already=priorCommand(user.id,requestId,hash);if(already)return {already};
            require('../../accounts/services/userAccess').requireWritableUser(user.id);
            if(!same(input.input_revision))return null;requirePlace(id,user.id);
            const q=ratingQuota(user.id,id,now);if(input.changed&&!withdraw&&!q.place_counted&&q.used>=q.limit)fail(429,`今天已经评价了 ${q.limit} 家店，明天再来吧`);
            if(input.changed){
                if(withdraw)db._raw.prepare('DELETE FROM PlaceRating WHERE user_id=? AND place_id=?').run(user.id,id);
                else db._raw.prepare(`INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at,weight) VALUES(@place_id,@user_id,@score,@source,@created_at,@updated_at,@weight) ON CONFLICT(place_id,user_id) DO UPDATE SET score=excluded.score,source=excluded.source,updated_at=excluded.updated_at,weight=excluded.weight`).run(input.after);
                db._raw.prepare('INSERT INTO PlaceRatingEvent(user_id,place_id,action,score,quota_day,occurred_at) VALUES(?,?,?,?,?,?)').run(user.id,id,withdraw?'withdraw':'rate',score,quotaDay(now),now);
            }
            let revision=db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?').get(user.id,id)?.revision||0;
            if(input.changed||!withdraw&&options.confirm)revision=appendRatingRevision({userId:user.id,placeId:id,before:input.before,after:input.after,action:withdraw?'withdraw':input.changed?input.before?'change':'rate':'confirm',origin:input.changed?'active':'confirmed',now,surface:options.surface||null});
            if(result.viewer_preference){
                const row=db._raw.prepare('SELECT input_revision FROM UserPreference WHERE user_id=?').get(user.id);
                if(!vectorAdapter.persistPreference(user.id,result.viewer_preference,row?.input_revision||0))throw client.failure(409,'stale_input');
            }
            summaryAdapter.writeSummary(id,result.summary);
            if(requestId)db._raw.prepare('INSERT INTO RatingCommand(user_id,request_id,input_hash,place_id,action,committed_revision,committed_at) VALUES(?,?,?,?,?,?,?)').run(user.id,requestId,hash,id,withdraw?'withdraw':'rate',revision,now);
            return {state:{place_id:id,summary:result.summary,mine:ownRating(id,user.id),personalized:result.personalized,quota:ratingQuota(user.id,id,now)}};
        }).immediate();
        if(committed?.already)return replay(user,id,committed.already);if(committed)return committed.state;
    }
    throw client.failure(409,'stale_input');
}
async function ratePlace(user,id,score,options){if(!isValidScore(score)){requirePlace(id,user.id);fail(400,'请选择一个评价');}return mutate(user,id,score,options);}
async function withdrawRating(user,id,options){return mutate(user,id,null,options);}
module.exports={RATING_SCORES,AVOID_BELOW_AVERAGE,RATING_COLUMNS_SQL:summaryAdapter.RATING_COLUMNS_SQL,isValidScore,ratingTier,isAvoidedPlace,defaultCreationScore,insertCreationRating,quotaDay,quotaResetsAt,ratingQuota,dailyLimit,ratingState,ratePlace,withdrawRating,ratingSummary:summaryAdapter.ratingSummary,personalizedSummary,personalizedAverages,personalizedAveragesSnapshot,resetMeanVectorCache};
