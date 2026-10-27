const { randomUUID, createHash } = require('node:crypto');
const { sql, now, fail, string, date, ownedMedia, normalizeDocument } = require('./journeyStore');
const algorithms = require('./journeyAlgorithmClient');

// Authorization, durable jobs and persistence stay here. All model credentials
// and calculation implementations belong to the separately deployed service.
async function capabilities() {
    const remote = await algorithms.capabilities();
    return {...remote,
        amap_search: remote.amap_search && process.env.AMAP_JOURNAL_STORAGE_ALLOWED === 'true',
        amap_export: !!process.env.AMAP_WEB_SERVICE_KEY && process.env.AMAP_EXPORT_ALLOWED === 'true'};
}
async function reconstruct(userId, input, options = {}) {
    options.checkActive?.();
    const ids = ownedMedia(userId, input.media_ids || []);
    const images = input.text_only ? [] : ids.map(id => ({id,
        data: sql.prepare('SELECT data FROM JourneyMedia WHERE id=? AND user_id=?').get(id, userId).data.toString('base64')}));
    const result = await algorithms.compute('reconstruct', {input:{...input,media_ids:ids},images,amap_storage_allowed:process.env.AMAP_JOURNAL_STORAGE_ALLOWED==='true'},
        {requestId:options.requestId,signal:options.signal});
    options.checkActive?.();
    if(process.env.AMAP_JOURNAL_STORAGE_ALLOWED!=='true'&&result.document.stops.some(stop=>stop.source==='amap'||stop.candidates?.some(candidate=>candidate.source==='amap')))
        fail('日记算法返回未获允许的地点数据',502);
    // The remote service cannot grant image ownership or invent valid local IDs.
    // Validate ownership and canonical fields without dropping review-only fields
    // such as suggested_id/needs_choice expected by the unchanged frontend.
    normalizeDocument(result.document, userId);
    result.document.ai_assisted = true;
    return result;
}
function searchCandidates(name,city,center) { return algorithms.compute('search',{name,city,center,amap_storage_allowed:process.env.AMAP_JOURNAL_STORAGE_ALLOWED==='true'}); }
function share(input) { return algorithms.compute('share',input); }
async function enqueue(userId,body) {
    const caps=await capabilities();
    if(!caps.text_ai) fail('尚未配置日记 AI，手动编辑仍可使用',503);
    const input={text:string(body.text,12000),city:string(body.city,50),start_date:date(body.start_date),end_date:date(body.end_date||body.start_date),media_ids:ownedMedia(userId,body.media_ids||[]),center:null};
    if(input.end_date<input.start_date) fail('结束日期不能早于开始日期');
    if(!input.text&&!input.media_ids.length) fail('请输入文字或上传图片');
    if(input.media_ids.length&&!caps.vision_ai) fail('当前模型未配置视觉能力',503);
    if(body.center && typeof body.center.lng==='number' && typeof body.center.lat==='number' && Math.abs(body.center.lng)<=180 && Math.abs(body.center.lat)<=90) input.center={lng:body.center.lng,lat:body.center.lat};
    return reserveJob(userId,input,body.request_id);
}
function reserveJob(userId,input,requestId=randomUUID(),onCreate=()=>{}) {
    if(!/^[A-Za-z0-9_-]{16,80}$/.test(requestId))fail('生成请求 ID 无效');
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return sql.transaction(()=>{
        const previous=sql.prepare('SELECT input_hash,job_id FROM JourneyJobRequest WHERE user_id=? AND request_id=?').get(userId,requestId);
        if(previous){
            const job=sql.prepare('SELECT id,status,input FROM JourneyJob WHERE id=? AND user_id=?').get(previous.job_id,userId);
            // Older hashes included the model configuration, which is now private.
            if(previous.input_hash!==hash&&(!job||job.input!==JSON.stringify(input)))fail('同一生成请求不能用于不同输入，请发起新的生成',409);
            if(!job)fail('此生成任务已删除，请发起新的生成；已用额度仍保留',410);
            return {id:job.id,status:job.status,replayed:true};
        }
        const recent=sql.prepare('SELECT COUNT(*) AS n FROM JourneyJobRequest WHERE user_id=? AND created_at>?').get(userId,new Date(Date.now()-3600000).toISOString()).n;
        if(recent>=10)fail('每小时最多生成 10 次；删除任务不会返还额度',429);
        if(sql.prepare("SELECT COUNT(*) AS n FROM JourneyJob WHERE user_id=? AND status IN ('queued','running')").get(userId).n>=2)fail('已有生成任务进行中',429);
        const id=randomUUID(),time=now();
        sql.prepare('INSERT INTO JourneyJob(id,user_id,status,input,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,userId,'queued',JSON.stringify(input),time,time);
        sql.prepare('INSERT INTO JourneyJobRequest VALUES(?,?,?,?,?)').run(userId,requestId,hash,id,time);
        onCreate(id);
        return {id,status:'queued',replayed:false};
    }).immediate();
}
function startJourneyWorker() {
    // A crash may have consumed an upstream request. Do not automatically charge twice.
    sql.prepare("UPDATE JourneyJob SET status='failed',error='服务重启中断了生成，请主动重试',updated_at=? WHERE status='running'").run(now());
    let busy=false, stopped=false;
    let activeController;
    async function tick() {
        if(busy||stopped) return;
        busy=true;
        try {
            const cutoff=new Date(Date.now()-7*86400000).toISOString();
            sql.prepare("DELETE FROM JourneyJob WHERE created_at<? AND status NOT IN ('running','queued')").run(cutoff);
            sql.prepare('DELETE FROM MapInteraction WHERE created_at<?').run(new Date(Date.now()-30*86400000).toISOString());
            sql.prepare('DELETE FROM MapDecision WHERE created_at<?').run(new Date(Date.now()-30*86400000).toISOString());
            const job=sql.prepare("SELECT * FROM JourneyJob WHERE status='queued' ORDER BY created_at LIMIT 1").get();
            if(!job) return;
            if(!sql.prepare("UPDATE JourneyJob SET status='running',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(now(),job.id).changes) return;
            try {
                const checkActive=()=>{
                    const active=sql.prepare("SELECT j.id FROM JourneyJob j JOIN User u ON u.id=j.user_id WHERE j.id=? AND j.status='running' AND COALESCE(u.is_banned,0)=0").get(job.id);
                    if(stopped||!active) fail('任务已停止',409);
                };
                const input=JSON.parse(job.input);
                activeController=new AbortController();
                const options={checkActive,requestId:job.id,signal:activeController.signal};
                const result=input.kind==='clarification'?await require('./journeyResolution').clarify(job.user_id,input,options):await reconstruct(job.user_id,input,options);
                checkActive();
                // Recording the result and creating the review draft happen together, so recovery opens one draft.
                sql.transaction(()=>{
                    const output=input.compose_draft_id?require('./journeyCompose').attachGeneratedDraft(job,input,result):result;
                    sql.prepare("UPDATE JourneyJob SET status='ready',output=?,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify(output),now(),job.id);
                }).immediate();
            } catch (error) {
                const message=error?.userFacing?error.message:'生成失败或上游超时；原始输入仍保留，可重试或手动编辑';
                sql.prepare("UPDATE JourneyJob SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(message,now(),job.id);
            } finally { activeController=undefined; }
        } catch (error) {
            // Do not log private inputs or provider response bodies.
            if(!stopped) console.warn('日记后台任务暂不可用', error?.code || 'unknown');
        } finally { busy=false; }
    }
    const timer=setInterval(tick,1000); timer.unref();
    return ()=>{stopped=true;clearInterval(timer);activeController?.abort();};
}
module.exports={capabilities,searchCandidates,reconstruct,share,enqueue,reserveJob,startJourneyWorker};
