const express=require('express');
const {randomUUID,createHash}=require('crypto');
const {requireAuth}=require('../../accounts/middleware/auth');
const {sql,now,fail,string}=require('../../journeys/services/journeyStore');
const router=express.Router();
router.use(requireAuth,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const run=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
const {consent,neighbors}=require('../services/communityPreferences');
router.get('/consent',run((req,res)=>res.json(consent(req.user.id))));
router.put('/consent',run((req,res)=>{
    const old=consent(req.user.id);
    if(req.body.version!==old.version) fail('设置已更新，请重新载入',409);
    const tags=[...new Set((Array.isArray(req.body.tags)?req.body.tags:[]).map(t=>string(t,24)).filter(Boolean))].slice(0,20);
    const feedback=req.body.feedback===true, research=feedback&&req.body.research===true,discovery=req.body.discovery===true;
    sql.transaction(()=>{
        sql.prepare(`INSERT INTO MapConsent(user_id,feedback,research,discovery,tags,version,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET feedback=excluded.feedback,research=excluded.research,discovery=excluded.discovery,tags=excluded.tags,version=excluded.version,updated_at=excluded.updated_at`)
            .run(req.user.id,+feedback,+research,+discovery,JSON.stringify(tags),old.version+1,now());
        const evidence=require('../../ratings/services/ratingEvidence');
        if(req.body.research_choice===true||!research&&old.research)evidence.recordResearchChoice(req.user.id,research);
        if(!feedback) {
            sql.prepare('DELETE FROM MapInteraction WHERE user_id=?').run(req.user.id);
            sql.prepare('DELETE FROM MapDecision WHERE user_id=?').run(req.user.id);
        require('../services/feedbackRetention').clearVisitFeedback(sql,req.user.id);
        } else if(!research) sql.prepare('UPDATE MapInteraction SET research_allowed=0 WHERE user_id=?').run(req.user.id);
    })();
    res.json(consent(req.user.id));
}));
// Places still under moderation appear only to their creator (doc/placeModeration.md in places).
function collection(row,viewerId=null) {
    return {...row,is_public:!!row.is_public,places:sql.prepare(`SELECT p.id,p.name,p.category,p.per_person_cost FROM PublicCollectionItem i JOIN Place p ON p.id=i.place_id WHERE i.collection_id=? AND (p.moderation_status='visible' OR p.creator_id=?)`).all(row.id,viewerId)};
}
router.get('/collections',run((req,res)=>res.json(sql.prepare('SELECT * FROM PublicCollection WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id).map(row=>collection(row,req.user.id)))));
router.post('/collections',run((req,res)=>{
    if(sql.prepare('SELECT COUNT(*) AS n FROM PublicCollection WHERE user_id=?').get(req.user.id).n>=30) fail('最多创建 30 个收藏夹');
    const id=randomUUID();
    sql.prepare('INSERT INTO PublicCollection VALUES(?,?,?,?,?)').run(id,req.user.id,string(req.body.title,80)||'我的收藏夹',0,now());
    res.status(201).json(collection(sql.prepare('SELECT * FROM PublicCollection WHERE id=?').get(id),req.user.id));
}));
router.put('/collections/:id',run((req,res)=>{
    if(!sql.prepare('SELECT id FROM PublicCollection WHERE id=? AND user_id=?').get(req.params.id,req.user.id)) fail('收藏夹不存在',404);
    const ids=[...new Set(Array.isArray(req.body.place_ids)?req.body.place_ids:[])];
    if(ids.length>200) fail('每个收藏夹最多 200 个地点');
    for(const id of ids) if(!Number.isSafeInteger(id)||!sql.prepare('SELECT id FROM Favorite WHERE user_id=? AND place_id=?').get(req.user.id,id)) fail('只能加入自己已经收藏的站内地点');
    sql.transaction(()=>{
        sql.prepare('UPDATE PublicCollection SET title=?,is_public=?,updated_at=? WHERE id=?').run(string(req.body.title,80)||'我的收藏夹',+(req.body.is_public===true),now(),req.params.id);
        sql.prepare('DELETE FROM PublicCollectionItem WHERE collection_id=?').run(req.params.id);
        for(const id of ids) sql.prepare('INSERT INTO PublicCollectionItem VALUES(?,?)').run(req.params.id,id);
    })();
    res.json(collection(sql.prepare('SELECT * FROM PublicCollection WHERE id=?').get(req.params.id),req.user.id));
}));
router.delete('/collections/:id',run((req,res)=>{sql.prepare('DELETE FROM PublicCollection WHERE id=? AND user_id=?').run(req.params.id,req.user.id);res.status(204).end();}));
router.get('/neighbors',run(async(req,res)=>res.json(await neighbors(req.user.id))));
router.get('/users/:id/collections',run((req,res)=>{
    if(!consent(req.params.id).discovery) fail('用户未开启同好发现',404);
    const user=sql.prepare('SELECT id,username FROM User WHERE id=? AND COALESCE(is_banned,0)=0').get(req.params.id);
    if(!user) fail('用户不存在',404);
    res.json({user,collections:sql.prepare('SELECT id,title,is_public,updated_at FROM PublicCollection WHERE user_id=? AND is_public=1').all(user.id).map(row=>collection(row,req.user?.id??null))});
}));
const kinds=new Set(['search','exposure','click','correction','next']);
const surfaces=new Set(['search','map','random','favorites','journey']);
function mapClickViewport(viewport){
    if(!viewport)return null;
    const {minLng,minLat,maxLng,maxLat,zoom}=viewport;
    if(![minLng,minLat,maxLng,maxLat,zoom].every(Number.isFinite))return null;
    if(minLng < -180||maxLng > 180||minLng >= maxLng) return null;
    if(minLat < -90||maxLat > 90||minLat >= maxLat) return null;
    if(zoom < 0||zoom > 30) return null;
    return {minLng,minLat,maxLng,maxLat,zoom};
}
// Which marker set was on the map when the place was clicked (frontend MapView markerQueryMode).
const mapClickModes=new Set(['nearby','search','along','user']);
const filterText=value=>typeof value==='string'&&value.trim()&&value.trim().length<=80?value.trim():null;
const filterTags=value=>{
    if(!Array.isArray(value)||value.length>20)return undefined;
    const tags=value.map(filterText);
    return tags.every(Boolean)?[...new Set(tags)]:undefined;
};
const filterCost=value=>value==null?null:Number.isSafeInteger(value)&&value>=0&&value<=100000?value:undefined;
const filterRegion=value=>value==null?null:filterText(value)??undefined;
// Mirrors frontend places/placeFilter.js normalizePlaceFilter; null = no filter. undefined = invalid.
function mapClickFilter(raw){
    if(raw==null)return null;
    if(typeof raw!=='object'||Array.isArray(raw))return undefined;
    const value={tags:filterTags(raw.tags??[]),excludeTags:filterTags(raw.excludeTags??[]),
        minCost:filterCost(raw.minCost),maxCost:filterCost(raw.maxCost),
        province:filterRegion(raw.province),city:filterRegion(raw.city),district:filterRegion(raw.district)};
    if(Object.values(value).includes(undefined))return undefined;
    if(!value.province&&value.city||!value.city&&value.district)return undefined;
    const active=value.tags.length||value.excludeTags.length||value.minCost!=null||value.maxCost!=null||value.province;
    return active?value:null;
}
function mapClickContext(e){
    const viewport=mapClickViewport(e.viewport);
    if(!viewport)return null;
    const context={viewport};
    const filter=mapClickFilter(e.map_filter);
    // Mode and filter are kept only together, so a stored mode always means a known filter state.
    if(mapClickModes.has(e.map_mode)&&filter!==undefined){context.map_mode=e.map_mode;context.map_filter=filter;}
    return context;
}
router.post('/observations',run((req,res)=>{
    const c=consent(req.user.id);
    if(!c.feedback||req.body.consent_version!==c.version) {res.json({id:null});return;}
    const ids=Array.isArray(req.body.place_ids)?req.body.place_ids:[];
    if(ids.length>200||ids.some(id=>!Number.isSafeInteger(id))) fail('展示快照无效');
    const candidates=ids.map((id,rank)=>({place_id:id,rank})).filter(c=>sql.prepare('SELECT id FROM Place WHERE id=?').get(c.place_id));
    const id=req.body.snapshot_id||randomUUID(),query=req.body.search_session_id||null,render=req.body.render_revision||null;
    const validId=v=>/^[a-zA-Z0-9_-]{16,80}$/.test(v||'');
    if(!validId(id)||(query&&!validId(query))||(render&&!validId(render)))fail('展示快照编号无效');
    const hash=createHash('sha256').update(JSON.stringify({ids,query,render})).digest('hex');
    const old=sql.prepare('SELECT user_id,request_hash FROM MapDecision WHERE id=?').get(id);
    if(old){if(old.user_id!==req.user.id||old.request_hash!==hash)fail('展示快照 ID 冲突',409);res.status(201).json({id});return;}
    if(sql.prepare('SELECT COUNT(*) AS n FROM MapDecision WHERE user_id=? AND created_at>?').get(req.user.id,new Date(Date.now()-60000).toISOString()).n>=60) fail('展示快照过于频繁',429);
    const snapshot={candidates,algorithm:'search-observed-client-v2',propensity:null,surface:'search',search_session_id:query,render_revision:render};
    sql.prepare('INSERT INTO MapDecision(id,user_id,request_hash,snapshot,result,created_at) VALUES(?,?,?,?,?,?)').run(id,req.user.id,hash,JSON.stringify({...snapshot,policy_version:'search-observed-client-v2',feature_snapshot_version:1,display_version:'rating-summary-v1'}),'{}',now());
    res.status(201).json({id});
}));
router.post('/draw',run(async(req,res)=>{
    const c=consent(req.user.id);
    if(!c.feedback||req.body.consent_version!==c.version) fail('交互设置已改变，请重新抽取',409);
    const {draw_id,center}=req.body;
    const radiusKm=require('../../discovery/services/randomRecommendation').randomRadius(req.body.radiusKm);
    const recommendation_session_id=req.body.recommendation_session_id||draw_id,parent_decision_id=req.body.parent_decision_id??null;
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(recommendation_session_id||'')||parent_decision_id!==null&&!/^[a-zA-Z0-9_-]{16,80}$/.test(parent_decision_id))fail('抽取会话无效');
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(draw_id||'')||!center||typeof center.lng!=='number'||typeof center.lat!=='number'||!Number.isFinite(center.lng)||!Number.isFinite(center.lat)||Math.abs(center.lng)>180||Math.abs(center.lat)>90) fail('抽取参数无效');
    const excluded=Array.isArray(req.body.exclude_ids)?req.body.exclude_ids.slice(-2):[];
    if(excluded.some(n=>!Number.isSafeInteger(n)||n<1)) fail('排除地点无效');
    const hash=createHash('sha256').update(JSON.stringify({center,excluded,recommendation_session_id,parent_decision_id,...(req.body.radiusKm===undefined?{}:{radiusKm})})).digest('hex');
    const old=sql.prepare('SELECT * FROM MapDecision WHERE id=?').get(draw_id);
    if(old) {if(old.user_id!==req.user.id||old.request_hash!==hash) fail('抽取 ID 已用于另一请求',409);res.json(JSON.parse(old.result));return;}
    function chainIndex(){
        const latest=sql.prepare("SELECT id,user_id,snapshot FROM MapDecision WHERE json_extract(snapshot,'$.recommendation_session_id')=? ORDER BY json_extract(snapshot,'$.draw_index') DESC LIMIT 1").get(recommendation_session_id);
        if(!latest){if(parent_decision_id)fail('上次抽取不存在',409);return 0;}
        if(latest.user_id!==req.user.id||latest.id!==parent_decision_id)fail('抽取会话已改变，请重新抽取',409);
        const parent=JSON.parse(latest.snapshot);if(parent.surface!=='random'||!Number.isSafeInteger(parent.draw_index))fail('抽取会话无效',409);
        return parent.draw_index+1;
    }
    chainIndex();
    if(sql.prepare('SELECT COUNT(*) AS n FROM MapDecision WHERE user_id=? AND created_at>?').get(req.user.id,new Date(Date.now()-60000).toISOString()).n>=30) fail('请稍后再抽取',429);
    const {drawRecommendation,personalizeCandidates,prepareNearbyRecommendation}=require('../../discovery/services/randomRecommendation');
    const {getUserPreference}=require('../../preferences/services/userPreferenceService');
    const {isVectorSearchAvailable}=require('../../../infrastructure/database');
    let snapshot={candidates:[],eligible_count:0,algorithm:'random-mixture-v1'};
    let preference=null;try{if(isVectorSearchAvailable())preference=await getUserPreference(req.user.id);}catch{}
    const {candidates,personalize}=await prepareNearbyRecommendation(sql,center,req.user.id,candidates=>{
        try { if(preference) return personalizeCandidates(sql,candidates,preference); } catch {}
        return {candidates,personalized:false};
    },radiusKm);
    if(consent(req.user.id).version!==c.version)fail('交互设置已改变，请重新抽取',409);
    const concurrent=sql.prepare('SELECT * FROM MapDecision WHERE id=?').get(draw_id);
    if(concurrent){if(concurrent.user_id!==req.user.id||concurrent.request_hash!==hash)fail('抽取 ID 已用于另一请求',409);res.json(JSON.parse(concurrent.result));return;}
    const draw_index=chainIndex();
    const result=drawRecommendation(candidates,excluded,Math.random,personalize,data=>{snapshot=data;});
    result.decision_id=draw_id;
    Object.assign(result,{recommendation_session_id,parent_decision_id,draw_index});
    // Keep local candidates, probabilities and derived model features; no raw center coordinates.
    sql.prepare('INSERT INTO MapDecision(id,user_id,request_hash,snapshot,result,created_at) VALUES(?,?,?,?,?,?)').run(draw_id,req.user.id,hash,JSON.stringify({...snapshot,surface:'random',recommendation_session_id,parent_decision_id,draw_index,selected_place_id:result.place?.id??null,policy_version:snapshot.algorithm,model_version:snapshot.model_version??(preference&&snapshot.personalized?{model:preference.model,algorithm_version:preference.algorithm_version}:null),feature_snapshot_version:2,display_version:'rating-bootstrap-v1'}),JSON.stringify(result),now());
    res.json(result);
}));
router.post('/feedback',run((req,res)=>{
    const c=consent(req.user.id);
    if(!c.feedback||req.body.consent_version!==c.version) {res.json({accepted:0});return;}
    if(!Array.isArray(req.body.events)||req.body.events.length>50) fail('每批最多 50 个事件');
    const recent=sql.prepare('SELECT COUNT(*) AS n FROM MapInteraction WHERE user_id=? AND created_at>?').get(req.user.id,new Date(Date.now()-60000).toISOString()).n;
    const fresh=req.body.events.filter(e=>!sql.prepare('SELECT id FROM MapInteraction WHERE id=? AND user_id=?').get(e?.id||'',req.user.id)).length;
    if(recent+fresh>300) fail('交互上报过于频繁',429);
    let accepted=0;
    sql.transaction(()=>{
        for(const e of req.body.events) {
            if(!/^[a-zA-Z0-9_-]{16,80}$/.test(e.id||'')||!/^[a-zA-Z0-9_-]{16,80}$/.test(e.session_id||'')||!kinds.has(e.kind)||!surfaces.has(e.surface)) fail('事件格式无效');
            if(e.kind==='correction'&&e.surface==='journey')fail('日记修正须通过保存版本记录');
            const old=sql.prepare('SELECT user_id FROM MapInteraction WHERE id=?').get(e.id);
            if(old) {if(old.user_id!==req.user.id) fail('事件 ID 冲突',409);continue;}
            const placeId=Number.isSafeInteger(e.place_id)?e.place_id:null;
            if(placeId&&!sql.prepare('SELECT id FROM Place WHERE id=?').get(placeId)) continue;
            const decision=e.decision_id?sql.prepare('SELECT snapshot FROM MapDecision WHERE id=? AND user_id=?').get(String(e.decision_id),req.user.id):null;
            if(e.decision_id&&!decision) continue;
            const snapshot=decision?JSON.parse(decision.snapshot):null;
            if(e.surface==='random'&&['click','exposure','next'].includes(e.kind)&&!snapshot)continue;
            if(snapshot&&((snapshot.surface==='search'&&e.surface!=='search')||((snapshot.surface==='random'||snapshot.algorithm==='random-mixture-v1')&&e.surface!=='random')))fail('事件与展示来源不匹配');
            if(snapshot&&placeId&&!snapshot.candidates.some(p=>p.place_id===placeId)) continue;
            if(snapshot?.surface==='random'&&['click','exposure','next'].includes(e.kind)&&placeId!==snapshot.selected_place_id)continue;
            const rank=Number.isInteger(e.rank)&&e.rank>=0&&e.rank<200?e.rank:null;
            if(snapshot?.surface==='search'&&placeId&&!snapshot.candidates.some(p=>p.place_id===placeId&&p.rank===rank))fail('搜索结果顺序不匹配');
            const reason=['wrong_branch','wrong_place','not_visited','privacy','other'].includes(e.reason)?e.reason:null;
            // Null place events only measure funnel activity. They are never training labels.
            sql.prepare('INSERT INTO MapInteraction(id,user_id,session_id,kind,surface,decision_id,place_id,rank,reason,research_allowed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.id,req.user.id,e.session_id,e.kind,e.surface,e.decision_id||null,placeId,rank,reason,+(c.research&&!!placeId),now());accepted++;
            require('../../ratings/services/ratingEvidence').captureEvent('MapInteraction',req.user.id,e.id,{trigger:e.trigger,surface:e.surface,decisionId:e.decision_id||null,impressionId:e.impression_id||null});
            let context=null;
            if(snapshot?.surface==='search'){
                context={search_session_id:snapshot.search_session_id,render_revision:snapshot.render_revision,
                    impression_id:string(e.impression_id,80),
                    impression_status:['threshold_met','clicked_before_threshold'].includes(e.impression_status)?e.impression_status:null};
            }else if(e.kind==='click'&&e.surface==='map'&&placeId){
                context=mapClickContext(e);
            }
            if(context)sql.prepare('INSERT INTO MapInteractionContext(event_id,context) VALUES(?,?)').run(e.id,JSON.stringify(context));
        }
    })();
    res.json({accepted});
    require('../../ratings/services/ratingEvidence').queueEvidence(req.user.id);
}));
router.get('/feedback',run((req,res)=>res.json({retention_days:90,retention_policy_version:'feedback-90d-v2',research_purpose_version:'rating-research-v2-90d',legacy_retention_days:30,counts:sql.prepare('SELECT kind,COUNT(*) AS count FROM MapInteraction WHERE user_id=? GROUP BY kind').all(req.user.id)})));
router.delete('/feedback',run((req,res)=>{
    sql.transaction(()=>{
        require('../../ratings/services/ratingEvidence').invalidateUserBundles(req.user.id);
        sql.prepare('UPDATE AlgorithmEventContext SET research_allowed=0 WHERE user_id=?').run(req.user.id);
        sql.prepare('DELETE FROM MapInteraction WHERE user_id=?').run(req.user.id);
        sql.prepare('DELETE FROM MapDecision WHERE user_id=?').run(req.user.id);
        require('../services/feedbackRetention').clearVisitFeedback(sql,req.user.id);
        sql.prepare('UPDATE MapConsent SET version=version+1,updated_at=? WHERE user_id=?').run(now(),req.user.id);
    })();
    require('../../ratings/services/ratingEvidence').queueEvidence(req.user.id);
    res.json(consent(req.user.id));
}));
router.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.status?err.message:'同好与反馈服务暂不可用',...(err.code==='RANDOM_INPUT_CHANGED'?{code:err.code}:{})}));
module.exports=router;
module.exports.consent=consent;
