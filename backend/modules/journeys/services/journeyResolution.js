const {sql,fail,string,now}=require('./journeyStore');
const {getDraft}=require('./journeyDrafts');
const located=s=>Number.isFinite(s.lng)&&Number.isFinite(s.lat)&&Math.abs(s.lng)<=180&&Math.abs(s.lat)<=90;
function locationBasis(document) {
    return JSON.stringify(document.stops.map(s=>[s.id,s.name,s.lng??null,s.lat??null,!!s.confirmed,s.visit_status,s.location_resolution||'pending',
        (s.candidates||[]).map(c=>[c.id,c.name,c.lng??null,c.lat??null,c.source,c.place_id??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]));
}
function resolutionState(document) {
    const relevant=document.stops.filter(s=>s.visit_status!=='planned');
    const pending=relevant.filter(s=>!s.confirmed&&s.location_resolution!=='deferred');
    return {status:pending.length?'needs_input':relevant.some(s=>!located(s)||s.location_resolution==='deferred')?'partial':'ready',
        questions:pending.slice(0,2).map(s=>({stop_id:s.id,prompt:located(s)?`请核对“${s.name}”的位置与经历状态。`:`“${s.name}”在哪个城市、商场或街道？可补充线索，也可保留为待定位。`}))};
}
async function rankedPatch(document,replacements={}) {
    const result=await require('./journeyAlgorithmClient').compute('rank',{document,replacements});
    if(result.basis!==locationBasis(document))fail('日记算法返回的位置版本无效',502);
    const eligible=new Set(document.stops.filter(s=>!s.confirmed&&s.visit_status!=='planned'&&s.location_resolution!=='deferred').map(s=>s.id));
    if(result.patches.some(p=>!eligible.has(p.stop_id)))fail('日记算法返回的位置补丁无效',502);
    return result;
}
async function rankDraft(userId,id,revision) {
    const draft=getDraft(userId,id);if(draft.revision!==revision)fail('草稿已更新，请重新评估候选',409);
    const result=await rankedPatch(draft.document);
    if(getDraft(userId,id).revision!==revision)fail('草稿已更新，请重新评估候选',409);
    return {...result,draft_id:id,draft_revision:revision};
}
async function enqueueClarification(userId,body) {
    const ai=require('./journeyAI');
    if(!(await ai.capabilities()).text_ai)fail('管理员尚未配置日记 AI，请直接选店或在地图上标记',503);
    const previous=body.request_id?sql.prepare('SELECT j.id,j.status,j.input FROM JourneyJobRequest r LEFT JOIN JourneyJob j ON j.id=r.job_id WHERE r.user_id=? AND r.request_id=?').get(userId,body.request_id):null;
    if(previous){
        if(!previous.id)fail('此线索任务已删除，请发起新的请求',410);
        const input=JSON.parse(previous.input);
        if(input.kind!=='clarification'||input.draft_id!==body.draft_id||input.draft_revision!==body.draft_revision||input.stop_id!==body.stop_id||input.answer!==string(body.answer,1000)||input.city!==string(body.city,50))fail('同一请求编号不能用于不同线索',409);
        return {id:previous.id,status:previous.status,replayed:true};
    }
    const draft=getDraft(userId,body.draft_id);
    if(draft.revision!==body.draft_revision)fail('草稿已更新，请重新提交线索',409);
    const stop=draft.document.stops.find(s=>s.id===body.stop_id);
    if(!stop||stop.confirmed||stop.location_resolution==='deferred'||stop.visit_status==='planned')fail('请选择尚未确认的历史地点');
    const answer=string(body.answer,1000),city=string(body.city,50);
    if(!answer)fail('请补充城市、分店或地址线索');
    const input={kind:'clarification',draft_id:draft.id,draft_revision:draft.revision,document:draft.document,stop_id:stop.id,answer,city,media_ids:[]};
    return ai.reserveJob(userId,input,body.request_id,id=>{
        if(sql.prepare('SELECT COUNT(*) AS n FROM JourneyClarificationRequest WHERE user_id=? AND draft_id=?').get(userId,draft.id).n>=4)fail('此草稿已用完 4 次线索检索，请直接选店或在地图上标记',429);
        sql.prepare('INSERT INTO JourneyClarificationRequest VALUES(?,?,?,?)').run(id,userId,draft.id,now());
    });
}
async function clarify(userId,input,options={}) {
    const check=()=>{options.checkActive?.();getDraft(userId,input.draft_id);};
    check();
    const stop=input.document.stops.find(s=>s.id===input.stop_id);
    if(!stop||stop.confirmed)fail('地点已确认',409);
    const result=await require('./journeyAlgorithmClient').compute('clarify',{input,amap_storage_allowed:process.env.AMAP_JOURNAL_STORAGE_ALLOWED==='true'},{requestId:options.requestId,signal:options.signal});
    check();
    if(result.draft_id!==input.draft_id||result.draft_revision!==input.draft_revision||result.basis!==locationBasis(input.document)
        ||result.answer.stop_id!==input.stop_id||result.patches.some(p=>!input.document.stops.some(s=>s.id===p.stop_id&&!s.confirmed&&s.visit_status!=='planned'&&s.location_resolution!=='deferred')))
        fail('日记算法返回的线索补丁无效',502);
    return result;
}
module.exports={locationBasis,resolutionState,rankedPatch,rankDraft,enqueueClarification,clarify};
