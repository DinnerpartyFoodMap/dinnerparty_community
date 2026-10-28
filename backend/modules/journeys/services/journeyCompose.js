const {createHash,randomUUID}=require('crypto');
const {sql,fail,now,date,ownedMedia,normalizeCenter,MEDIA_KINDS}=require('./journeyStore');

// Material drafts hold what the user typed and uploaded before generation.
// Only uploaded media references reach the server; pending blobs stay on the device.
const ID=/^[A-Za-z0-9_-]{16,80}$/;
const MAX_ACTIVE=30;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalizePayload(userId,input) {
    if(!input||typeof input!=='object'||Array.isArray(input))fail('素材格式无效');
    const media_ids=ownedMedia(userId,input.media_ids||[],12,'每次最多 12 张图片');
    const notes=input.media_notes&&typeof input.media_notes==='object'&&!Array.isArray(input.media_notes)?input.media_notes:{};
    const media_notes={};
    for(const id of media_ids)if(MEDIA_KINDS.includes(notes[id]?.kind))media_notes[id]={kind:notes[id].kind};
    // Dates may be incomplete while typing; generation validates them.
    const day=value=>typeof value==='string'?value.slice(0,10):'';
    return {text:typeof input.text==='string'?input.text.slice(0,12000):'',media_ids,media_notes,
        start_date:day(input.start_date),end_date:day(input.end_date),center:normalizeCenter(input.center),
        intended_visibility:input.intended_visibility==='public'?'public':'private'};
}
function composeRow(userId,id) {
    const row=sql.prepare('SELECT * FROM JourneyComposeDraft WHERE id=? AND user_id=?').get(id,userId);
    if(!row)fail('素材草稿不存在',404);
    return row;
}
function jobState(id) {
    const job=id?sql.prepare('SELECT id,status,error,result_draft_id FROM JourneyJob WHERE id=?').get(id):null;
    return job?{id:job.id,status:job.status,error:job.error,draft_id:job.result_draft_id||null}:null;
}
function unpack(row) {
    const structured=row.structured_draft_id?sql.prepare('SELECT id,status,revision FROM JourneyDraft WHERE id=?').get(row.structured_draft_id):null;
    return {id:row.id,revision:row.revision,status:row.status,payload:JSON.parse(row.payload),job:jobState(row.active_job_id),
        structured_draft:structured?{id:structured.id,status:structured.status,revision:structured.revision}:null,created_at:row.created_at,updated_at:row.updated_at};
}
function getCompose(userId,id) {
    const row=composeRow(userId,id);
    if(row.status!=='active')fail(row.status==='closed'?'这份素材已整理成日记，可在日历中查看':'素材草稿已丢弃',410);
    return unpack(row);
}
function putCompose(userId,id,body) {
    if(!ID.test(id)||!Number.isInteger(body.revision)||body.revision<0)fail('素材草稿版本无效');
    const payload=normalizePayload(userId,body.payload),encoded=JSON.stringify(payload),hash=digest(payload);
    return sql.transaction(()=>{
        const old=sql.prepare('SELECT * FROM JourneyComposeDraft WHERE id=?').get(id);
        if(old){
            if(old.user_id!==userId)fail('素材草稿不存在',404);
            if(old.status!=='active')fail('素材草稿已整理成日记或已丢弃',410);
            // Same content retried after a lost response is acknowledged without a new revision.
            if(old.content_hash===hash&&[old.revision,old.revision-1].includes(body.revision))return unpack(old);
            if(old.revision!==body.revision)fail('素材已在其他窗口修改，当前内容仍在本页，可另存或重新载入',409);
            sql.prepare('UPDATE JourneyComposeDraft SET revision=revision+1,payload=?,content_hash=?,updated_at=? WHERE id=?').run(encoded,hash,now(),id);
        }else{
            if(body.revision!==0)fail('素材草稿已不存在，请另存',409);
            if(sql.prepare("SELECT COUNT(*) AS n FROM JourneyComposeDraft WHERE user_id=? AND status='active'").get(userId).n>=MAX_ACTIVE)fail(`最多保留 ${MAX_ACTIVE} 份素材草稿，请先整理`,413);
            const time=now();
            sql.prepare('INSERT INTO JourneyComposeDraft(id,user_id,revision,payload,content_hash,created_at,updated_at) VALUES(?,?,1,?,?,?,?)').run(id,userId,encoded,hash,time,time);
        }
        return unpack(sql.prepare('SELECT * FROM JourneyComposeDraft WHERE id=?').get(id));
    }).immediate();
}
function discardCompose(userId,id,revision) {
    return sql.transaction(()=>{
        const row=composeRow(userId,id);
        if(row.status!=='active')return;
        // A late autosave must not reopen a discarded draft, so the revision is checked.
        if(row.revision!==revision)fail('素材已更新，请重新载入',409);
        sql.prepare("UPDATE JourneyComposeDraft SET status='discarded',payload='{}',updated_at=? WHERE id=?").run(now(),id);
    }).immediate();
}
// Freezes the current material revision into an immutable job input.
async function generate(userId,id,body) {
    const ai=require('./journeyAI');
    const caps=await ai.capabilities();
    if(!caps.text_ai)fail('尚未配置日记 AI，可以手动整理并保存',503);
    const row=composeRow(userId,id);
    if(row.status!=='active')fail('素材草稿已整理成日记或已丢弃',410);
    if(row.revision!==body.compose_revision)fail('素材已更新，请等待同步完成后再生成',409);
    const payload=JSON.parse(row.payload);
    const start=date(payload.start_date),end=date(payload.end_date||payload.start_date);
    if(end<start)fail('结束日期不能早于开始日期');
    const hasPhotos=payload.media_ids.length>0,textOnly=body.text_only===true||!hasPhotos;
    if(hasPhotos&&!textOnly&&!caps.vision_ai)fail('当前模型不支持图片理解，可选择“仅根据描述生成”，照片仍会保存在日记中',503);
    if(!payload.text.trim()&&textOnly)fail(hasPhotos?'仅根据描述生成需要文字；可以补充描述，或直接手动记录':'请输入文字或添加图片');
    const center=payload.center;
    const input={text:payload.text,city:center?.city||'',start_date:start,end_date:end,media_ids:payload.media_ids,
        media_kinds:payload.media_notes,center:center?{lng:center.lng,lat:center.lat,name:center.name,city:center.city,source:center.source}:null,
        text_only:textOnly,compose_draft_id:id,compose_revision:row.revision,intended_visibility:payload.intended_visibility};
    const job=ai.reserveJob(userId,input,body.request_id,jobId=>{
        sql.prepare('UPDATE JourneyJob SET compose_draft_id=? WHERE id=?').run(id,jobId);
        sql.prepare('UPDATE JourneyComposeDraft SET active_job_id=?,updated_at=? WHERE id=?').run(jobId,now(),id);
    });
    return {...job,compose_draft_id:id};
}
// Called by the worker inside the transaction that marks the job ready, so a job yields at most one draft.
function attachGeneratedDraft(job,input,result) {
    const row=sql.prepare('SELECT * FROM JourneyComposeDraft WHERE id=? AND user_id=?').get(input.compose_draft_id,job.user_id);
    if(!row||row.status!=='active')return result;
    const existing=sql.prepare('SELECT result_draft_id FROM JourneyJob WHERE id=?').get(job.id)?.result_draft_id;
    if(existing)return {...result,draft_id:existing};
    if(sql.prepare("SELECT COUNT(*) AS n FROM JourneyDraft WHERE user_id=? AND status='active'").get(job.user_id).n>=30)
        throw Object.assign(new Error('未完成的日记草稿已有 30 份，请先整理后重试'),{status:413,userFacing:true});
    const document={...result.document,intended_visibility:input.intended_visibility==='public'?'public':'private'};
    const draftId=randomUUID(),time=now(),encoded=JSON.stringify(document);
    const hash=createHash('sha256').update(JSON.stringify([null,0,document])).digest('hex');
    sql.prepare('INSERT INTO JourneyDraft(id,user_id,journey_id,base_revision,revision,document,content_hash,compose_draft_id,compose_revision,created_at,updated_at) VALUES(?,?,NULL,0,1,?,?,?,?,?,?)')
        .run(draftId,job.user_id,encoded,hash,row.id,input.compose_revision,time,time);
    sql.prepare('UPDATE JourneyJob SET result_draft_id=? WHERE id=?').run(draftId,job.id);
    sql.prepare('UPDATE JourneyComposeDraft SET structured_draft_id=?,updated_at=? WHERE id=?').run(draftId,time,row.id);
    return {...result,draft_id:draftId};
}
function preview(text) {return Array.from(String(text||'').replace(/\s+/g,' ').trim()).slice(0,40).join('');}
// Material, generating, waiting for review and editing drafts in one list.
function unfinished(userId) {
    const material=[],generating=[],review=[],editing=[];
    const composes=sql.prepare(`SELECT c.*,j.status AS job_status,j.error AS job_error,d.status AS draft_status,d.compose_revision AS draft_compose_revision FROM JourneyComposeDraft c
        LEFT JOIN JourneyJob j ON j.id=c.active_job_id LEFT JOIN JourneyDraft d ON d.id=c.structured_draft_id
        WHERE c.user_id=? AND c.status='active' ORDER BY c.updated_at DESC`).all(userId);
    for(const c of composes){
        const p=JSON.parse(c.payload);
        const item={kind:'material',id:c.id,revision:c.revision,title:preview(p.text)||(p.media_ids.length?`${p.media_ids.length} 张照片`:'空白素材'),
            start_date:p.start_date||'',media_count:p.media_ids.length,cover_media_id:p.media_ids[0]||null,job_id:c.active_job_id,updated_at:c.updated_at};
        if(['queued','running'].includes(c.job_status))generating.push({...item,kind:'generating',job_status:c.job_status});
        else if(c.draft_status==='active'&&c.draft_compose_revision!==c.revision)material.push({...item,newer_than_review:true,failed:false,error:''});
        // Represented by its review draft only while that draft was generated from this exact revision.
        else if(c.draft_status==='active'&&c.draft_compose_revision===c.revision)continue;
        else material.push({...item,failed:c.job_status==='failed',error:c.job_status==='failed'?c.job_error:''});
    }
    const drafts=sql.prepare("SELECT id,journey_id,base_revision,revision,document,compose_draft_id,updated_at FROM JourneyDraft WHERE user_id=? AND status='active' ORDER BY updated_at DESC LIMIT 30").all(userId);
    for(const d of drafts){
        const doc=JSON.parse(d.document);
        const item={id:d.id,revision:d.revision,journey_id:d.journey_id,base_revision:d.base_revision,compose_draft_id:d.compose_draft_id||null,
            title:doc.title||'未命名草稿',start_date:doc.start_date||'',end_date:doc.end_date||'',stop_count:doc.stops?.length||0,
            pending:(doc.stops||[]).filter(s=>!s.confirmed).length,
            cover_media_id:doc.entry_media_ids?.[0]||doc.stops?.find(s=>s.media_ids?.length)?.media_ids[0]||null,updated_at:d.updated_at};
        if(d.compose_draft_id&&!d.journey_id)review.push({...item,kind:'review'});
        else editing.push({...item,kind:'editing'});
    }
    return {material,generating,review,editing,count:material.length+generating.length+review.length+editing.length};
}
function summarize(row) {
    const d=JSON.parse(row.document),stops=d.stops||[];
    const active=row.publication_status==='active';
    return {id:row.id,revision:row.revision,title:d.title,start_date:d.start_date,end_date:d.end_date,stop_count:stops.length,
        places:stops.filter(s=>s.visit_status!=='planned').map(s=>s.name).slice(0,3),
        cover_media_id:d.entry_media_ids?.[0]||stops.find(s=>s.media_ids?.length)?.media_ids[0]||null,
        visibility:active?'public':'private',public_id:active?row.public_id:null,
        public_outdated:active&&row.source_revision!==row.revision,updated_at:row.updated_at};
}
// Summaries only, selected by date-range intersection, so the calendar never downloads full diaries.
function calendar(userId,from,to) {
    date(from);date(to);
    if(to<from)fail('日期范围无效');
    if((Date.parse(to)-Date.parse(from))/86400000>400)fail('一次最多查询 400 天');
    const rows=sql.prepare(`SELECT j.id,j.revision,j.document,j.updated_at,p.id AS public_id,p.status AS publication_status,p.source_revision
        FROM Journey j LEFT JOIN JourneyPublication p ON p.journey_id=j.id
        WHERE j.user_id=? AND json_extract(j.document,'$.start_date')<=? AND json_extract(j.document,'$.end_date')>=?
        ORDER BY json_extract(j.document,'$.start_date') DESC,j.updated_at DESC LIMIT 500`).all(userId,to,from);
    const pending=unfinished(userId);
    // Drafts are shown by their record date but never counted as formal diaries.
    const draft_dates=[...pending.material,...pending.generating,...pending.review,...pending.editing]
        .map(item=>item.start_date).filter(d=>d&&d>=from&&d<=to);
    return {from,to,entries:rows.map(summarize),unfinished_count:pending.count,draft_dates};
}
// Finding a diary again: every word must appear in the title, texts, shop names, addresses, dishes or the search
// center (city). Only the author's own diaries, at most 500 scanned and 100 returned, newest record date first.
function search(userId,{q='',visibility=''}={}) {
    const terms=String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0,5);
    const filter=['public','private'].includes(visibility)?visibility:'';
    if(!terms.length&&!filter)fail('请输入关键词或选择公开状态');
    const rows=sql.prepare(`SELECT j.id,j.revision,j.document,j.updated_at,p.id AS public_id,p.status AS publication_status,p.source_revision
        FROM Journey j LEFT JOIN JourneyPublication p ON p.journey_id=j.id WHERE j.user_id=?
        ORDER BY json_extract(j.document,'$.start_date') DESC,j.updated_at DESC LIMIT 500`).all(userId);
    return rows.filter(row=>{
        const isPublic=row.publication_status==='active';
        if((filter==='public'&&!isPublic)||(filter==='private'&&isPublic))return false;
        if(!terms.length)return true;
        const d=JSON.parse(row.document),center=d.source_input?.center;
        const text=[d.title,d.summary,d.public_text,d.source_input?.text,center?.name,center?.city,
            ...(d.stops||[]).flatMap(s=>[s.name,s.address,s.category,s.note,s.excerpt_edited,...(s.dishes||[]),...(s.excerpts||[]).map(e=>e.text)])]
            .filter(Boolean).join('\n').toLowerCase();
        return terms.every(term=>text.includes(term));
    }).slice(0,100).map(summarize);
}
module.exports={normalizePayload,getCompose,putCompose,discardCompose,generate,attachGeneratedDraft,unfinished,calendar,search,summarize};
