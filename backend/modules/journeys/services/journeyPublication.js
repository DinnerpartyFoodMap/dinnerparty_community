const {createHash,randomBytes,randomUUID}=require('crypto');
const {sql,fail,now,getJourney,saveJourney}=require('./journeyStore');
const {draftRow,closeDraft}=require('./journeyDrafts');
const links=require('./journeyMapLinks');
const {enqueuePlaceCreatedNotifications}=require('../../places/services/placeNotifications');
const {afterPlacesCreated}=require('../../places/services/placeService');
const {notBlockedSql}=require('../../accounts/services/userRelations');

// Public diary content is an independent snapshot of exactly what the author previewed.
// Private editing, autosave, restore and merge never touch it; only commit and withdraw do.
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const REQUEST=/^[A-Za-z0-9_-]{16,80}$/;
function failWith(message,status,extra) {throw Object.assign(new Error(message),{status,...extra});}
const {stopIsPublic}=links;
// Author edits replace quotes for display; original quotes remain private source material.
function publicExcerpt(stop) {
    if(stop.excerpt_edited)return [{kind:'edited',text:stop.excerpt_edited}];
    return (stop.excerpts||[]).map(e=>({kind:'quote',text:e.text}));
}
function publicBody(document,plan) {
    const byStop=new Map(plan.map(l=>[l.stop_id,l]));
    const stops=document.stops.map((stop,index)=>({stop,index})).filter(({stop})=>stopIsPublic(stop)).map(({stop,index})=>{
        const link=byStop.get(stop.id);
        const mapped=link&&['link','create'].includes(link.action);
        return {id:stop.id,index,name:stop.name,visit_status:stop.visit_status,at:stop.at||'',excerpt:publicExcerpt(stop),media_ids:[...stop.media_ids],
            place_id:mapped&&link.action==='link'?link.place_id:null,map_action:mapped?link.action:'none',
            // Coordinates are published only for stops that appear on the map.
            lng:mapped?stop.lng:null,lat:mapped?stop.lat:null,address:mapped?stop.address||'':'',
            // Readers are told when the author never picked the place; only set then, so other snapshots stay unchanged.
            ...(stop.confirmed?{}:{unverified:true})};
    });
    const entryPhotos=(document.public_media_ids||[]).filter(id=>(document.entry_media_ids||[]).includes(id));
    // ai_assisted only when set, so snapshots and preview hashes of other diaries stay unchanged.
    return {title:document.title,start_date:document.start_date,end_date:document.end_date,summary:document.summary||'',
        text:document.public_text||'',entry_media_ids:entryPhotos,stops,
        media_ids:[...new Set([...entryPhotos,...stops.flatMap(s=>s.media_ids)])],
        ...(document.ai_assisted?{ai_assisted:true}:{})};
}
function publicationOf(journeyId) {
    return journeyId?sql.prepare('SELECT id,status,version,source_revision FROM JourneyPublication WHERE journey_id=?').get(journeyId)||null:null;
}
function buildPreview(document,context,visibility) {
    const plan=links.planLinks(document,visibility);
    const publication=publicationOf(context.journey_id);
    const body=visibility==='public'?publicBody(document,plan):null;
    const count=action=>plan.filter(l=>l.action===action).length;
    const counts={link:count('link'),create:plan.filter(l=>l.action==='create'&&!l.same_as).length,conflict:count('conflict'),
        public_stops:body?.stops.length||0,public_photos:body?.media_ids.length||0,private_photos:(document.entry_media_ids||[]).filter(id=>!body?.media_ids.includes(id)).length,
        // Nothing but a title and dates would be published; the page asks the author to add text or photos.
        empty_public:!!body&&!body.summary&&!body.text&&!body.media_ids.length&&!body.stops.some(s=>s.excerpt.length)};
    const hash=digest({draft:context.draft_id,revision:context.draft_revision,journey:context.journey_id||null,base:context.base_revision||0,
        publication:publication?[publication.status,publication.version]:null,visibility,
        plan:plan.map(l=>[l.stop_id,l.action,l.place_id||null,l.external_id||'',l.same_as||'',(l.duplicates||[]).map(d=>d.id)]),body});
    return {preview_id:hash,preview_hash:hash,visibility,links:plan,body,counts,
        publication:publication?{public_id:publication.id,status:publication.status,version:publication.version}:null};
}
function draftContext(userId,draftId,revision) {
    const row=draftRow(userId,draftId);
    if(row.status!=='active')fail(row.status==='published'?'草稿已保存，请从日历重新打开':'草稿已丢弃',410);
    if(row.revision!==revision)fail('草稿已更新，请等待同步后再预览',409);
    return {row,document:JSON.parse(row.document)};
}
function visibilityOf(value) {
    if(!['public','private'].includes(value))fail('请选择公开或私密');
    return value;
}
function mapPreview(userId,draftId,body) {
    const {row,document}=draftContext(userId,draftId,body.draft_revision);
    const asCopy=body.as_copy===true;
    return buildPreview(document,{draft_id:row.id,draft_revision:row.revision,journey_id:asCopy?null:row.journey_id,base_revision:asCopy?0:row.base_revision},visibilityOf(body.visibility));
}
function writePublication(userId,journey,plan) {
    const body=publicBody(journey.document,plan);
    const previous=publicationOf(journey.id),time=now();
    const snapshot=JSON.stringify(body);
    let id;
    if(previous){
        id=previous.id;
        sql.prepare("UPDATE JourneyPublication SET status='active',snapshot=?,source_revision=?,version=version+1,published_at=COALESCE(published_at,?),updated_at=? WHERE id=?").run(snapshot,journey.revision,time,time,id);
    }else{
        // Stable, unguessable public id; it does not reveal the private diary id.
        id=randomBytes(16).toString('base64url');
        sql.prepare("INSERT INTO JourneyPublication(id,journey_id,user_id,source_revision,version,status,snapshot,published_at,updated_at) VALUES(?,?,?,?,1,'active',?,?,?)").run(id,journey.id,userId,journey.revision,snapshot,time,time);
    }
    sql.prepare('DELETE FROM PlaceDiaryExcerpt WHERE publication_id=?').run(id);
    const insert=sql.prepare('INSERT INTO PlaceDiaryExcerpt(id,publication_id,user_id,stop_id,stop_index,place_id,record_date,excerpt,media_ids,place_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(const stop of body.stops){
        if(!stop.place_id)continue;
        insert.run(randomUUID(),id,userId,stop.id,stop.index,stop.place_id,(stop.at||'').slice(0,10)||journey.document.start_date,
            JSON.stringify(stop.excerpt),JSON.stringify(stop.media_ids),JSON.stringify({name:stop.name,address:stop.address,lng:stop.lng,lat:stop.lat}),time);
    }
    const row=sql.prepare('SELECT id,status,version FROM JourneyPublication WHERE id=?').get(id);
    return {public_id:row.id,status:row.status,version:row.version};
}
// Withdrawal clears the snapshot and excerpts at once and bumps the version, so older editor windows cannot republish.
function withdrawPublication(journeyId) {
    const publication=publicationOf(journeyId);
    if(!publication)return null;
    if(publication.status==='active'){
        sql.prepare("UPDATE JourneyPublication SET status='withdrawn',snapshot='{}',version=version+1,updated_at=? WHERE id=?").run(now(),publication.id);
        sql.prepare('DELETE FROM PlaceDiaryExcerpt WHERE publication_id=?').run(publication.id);
    }
    const row=sql.prepare('SELECT id,status,version FROM JourneyPublication WHERE id=?').get(publication.id);
    return {public_id:row.id,status:row.status,version:row.version};
}
function currentState(userId,journeyId) {
    const exists=sql.prepare('SELECT id FROM Journey WHERE id=? AND user_id=?').get(journeyId,userId);
    const publication=publicationOf(journeyId);
    return {journey:exists?getJourney(userId,journeyId):null,publication:publication?{public_id:publication.id,status:publication.status,version:publication.version}:null};
}
function commit(userId,draftId,body) {
    const requestId=body.request_id;
    if(!REQUEST.test(requestId||''))fail('保存请求 ID 无效');
    const visibility=visibilityOf(body.visibility),asCopy=body.as_copy===true;
    const payloadHash=digest({draftId,revision:body.draft_revision,visibility,preview:body.preview_hash,asCopy});
    const result=sql.transaction(()=>{
        const previous=sql.prepare('SELECT payload_hash,journey_id,result FROM JourneyCommitRequest WHERE user_id=? AND request_id=?').get(userId,requestId);
        if(previous){
            if(previous.payload_hash!==payloadHash)fail('同一保存请求不能用于不同内容，请重新保存',409);
            // A late retry reports what happened and the current state; it never re-activates withdrawn content.
            return {...JSON.parse(previous.result),...currentState(userId,previous.journey_id),replayed:true};
        }
        const {row,document}=draftContext(userId,draftId,body.draft_revision);
        const journeyId=asCopy?null:row.journey_id,baseRevision=asCopy?null:row.base_revision;
        const preview=buildPreview(document,{draft_id:row.id,draft_revision:row.revision,journey_id:journeyId,base_revision:baseRevision||0},visibility);
        if(preview.preview_hash!==body.preview_hash)failWith('公开内容或地图操作有变化，请查看更新后的预览再保存',409,{code:'preview_stale'});
        if(preview.counts.conflict)failWith('有地点与附近已有标记相似，请先确认是否为同一家',409,{code:'duplicate_conflict',details:preview.links.filter(l=>l.action==='conflict')});
        const created=[],byKey=new Map();
        for(const link of preview.links){
            if(!['link','create'].includes(link.action))continue;
            const stop=document.stops.find(s=>s.id===link.stop_id);
            let placeId=link.place_id;
            if(link.action==='create'){
                if(byKey.has(link.creation_key))placeId=byKey.get(link.creation_key);
                else{
                    // Duplicates are checked again inside the transaction; a new nearby marker sends the author back.
                    const fresh=links.findDuplicates(stop).filter(d=>!(stop.duplicate_ack||[]).includes(d.id)&&![...byKey.values()].includes(d.id));
                    if(fresh.length)failWith('附近刚出现名称相似的标记，请确认是否为同一家',409,{code:'duplicate_conflict',details:[{stop_id:stop.id,duplicates:fresh}]});
                    const made=links.createPlace(userId,stop,link);
                    placeId=made.place_id;byKey.set(link.creation_key,placeId);
                    if(made.created)created.push(placeId);
                }
            }
            stop.place_id=placeId;stop.source='local';
            link.place_id=placeId;link.action='link';
        }
        delete document.intended_visibility;
        const saved=saveJourney(userId,document,journeyId,baseRevision);
        const publication=visibility==='public'?writePublication(userId,saved,preview.links):withdrawPublication(saved.id);
        closeDraft(row,saved.id);
        const outcome={journey_id:saved.id,revision:saved.revision,visibility,linked:new Set(preview.links.filter(l=>l.action==='link'&&l.place_id).map(l=>l.place_id)).size,
            created_place_ids:created,public_id:publication?.status==='active'?publication.public_id:null,publication_version:publication?.version||0};
        // Only markers that survived external-POI de-duplication are announced; a rollback drops these rows too.
        enqueuePlaceCreatedNotifications(created,{source:'diary'});
        sql.prepare('INSERT INTO JourneyCommitRequest(user_id,request_id,payload_hash,journey_id,result,created_at) VALUES(?,?,?,?,?,?)').run(userId,requestId,payloadHash,saved.id,JSON.stringify(outcome),now());
        return {...outcome,journey:saved,publication};
    }).immediate();
    // Marker vectors and group notifications run after commit as retryable tasks; failure leaves no partial public state.
    if(!result.replayed&&result.created_place_ids.length)afterPlacesCreated(result.created_place_ids);
    return result;
}
function withdraw(userId,journeyId,body) {
    return sql.transaction(()=>{
        getJourney(userId,journeyId);
        const publication=publicationOf(journeyId);
        if(!publication||publication.status!=='active')return {public_id:publication?.id||null,status:publication?.status||'none',version:publication?.version||0};
        if(body.version!==undefined&&body.version!==publication.version)fail('公开内容已在其他窗口更新，请重新载入后再操作',409);
        return withdrawPublication(journeyId);
    }).immediate();
}
function publicationSummary(journey) {
    const publication=publicationOf(journey.id);
    if(!publication)return {visibility:'private',publication:null};
    const active=publication.status==='active';
    const linked=active?sql.prepare('SELECT COUNT(DISTINCT place_id) AS n FROM PlaceDiaryExcerpt WHERE publication_id=? AND place_id IS NOT NULL').get(publication.id).n:0;
    return {visibility:active?'public':'private',publication:{public_id:publication.id,status:publication.status,version:publication.version,
        source_revision:publication.source_revision,outdated:active&&publication.source_revision!==journey.revision,linked_places:linked}};
}
function author(row) {return {id:row.user_id,username:row.username,has_avatar:!!row.has_avatar};}
function publicJourney(publicId) {
    const row=sql.prepare("SELECT p.*,u.username,(u.avatar_blob IS NOT NULL) AS has_avatar FROM JourneyPublication p JOIN User u ON u.id=p.user_id WHERE p.id=? AND p.status='active'").get(String(publicId));
    if(!row)fail('这篇日记不存在，或作者已设为私密',404);
    const body=JSON.parse(row.snapshot);
    // A marker deleted after publication keeps the stop text but loses its map link.
    const stops=body.stops.map(s=>({...s,place_id:s.place_id&&sql.prepare('SELECT id FROM Place WHERE id=?').get(s.place_id)?s.place_id:null}));
    return {public_id:row.id,version:row.version,author:author(row),title:body.title,start_date:body.start_date,end_date:body.end_date,
        summary:body.summary,text:body.text||'',entry_media_ids:body.entry_media_ids||[],stops,media_ids:body.media_ids,published_at:row.published_at,updated_at:row.updated_at,
        ai_assisted:!!body.ai_assisted};
}
function publicMedia(publicId,mediaId) {
    const row=sql.prepare("SELECT user_id,snapshot FROM JourneyPublication WHERE id=? AND status='active'").get(String(publicId));
    if(!row||!JSON.parse(row.snapshot).media_ids?.includes(String(mediaId)))fail('图片不存在',404);
    const media=sql.prepare('SELECT data FROM JourneyMedia WHERE id=? AND user_id=?').get(String(mediaId),row.user_id);
    if(!media)fail('图片不存在',404);
    return media.data;
}
const encodeCursor=(date,id)=>Buffer.from(JSON.stringify([date,id])).toString('base64url');
function decodeCursor(value) {
    if(!value)return null;
    try{const [date,id]=JSON.parse(Buffer.from(String(value),'base64url').toString());if(typeof date==='string'&&typeof id==='string')return [date,id];}catch{}
    fail('分页参数无效');
}
// One card per public diary; several visits of one diary to the place are merged into that card.
// viewerId: diaries by residents the viewer blocked are left out (accounts/services/userRelations.js).
function placeDiaries(placeId,{cursor,limit,viewerId=null}={}) {
    const id=Number(placeId);
    if(!Number.isSafeInteger(id)||id<=0)fail('地点无效');
    const size=Math.max(1,Math.min(20,Number(limit)||3));
    const after=decodeCursor(cursor);
    const base=`FROM PlaceDiaryExcerpt e JOIN JourneyPublication p ON p.id=e.publication_id AND p.status='active' WHERE e.place_id=? AND ${notBlockedSql('p.user_id')}`;
    const viewer=viewerId==null?null:String(viewerId);
    const total=sql.prepare(`SELECT COUNT(DISTINCT e.publication_id) AS n ${base}`).get(id,viewer).n;
    const groups=sql.prepare(`SELECT e.publication_id AS publication_id,MAX(e.record_date) AS record_date ${base} GROUP BY e.publication_id
        ${after?'HAVING (MAX(e.record_date),e.publication_id)<(?,?)':''} ORDER BY record_date DESC,publication_id DESC LIMIT ?`).all(...(after?[id,viewer,...after,size+1]:[id,viewer,size+1]));
    const page=groups.slice(0,size);
    const items=page.map(g=>{
        const pub=sql.prepare('SELECT p.id,p.user_id,p.snapshot,u.username,(u.avatar_blob IS NOT NULL) AS has_avatar FROM JourneyPublication p JOIN User u ON u.id=p.user_id WHERE p.id=?').get(g.publication_id);
        const snapshot=JSON.parse(pub.snapshot);
        // record_date falls back to the first day for ordering. A multi-day diary whose stop has no date reports '' so
        // readers see the whole range instead of a made-up first-day visit.
        const multiDay=snapshot.start_date!==snapshot.end_date,atOf=new Map((snapshot.stops||[]).map(s=>[s.id,s.at||'']));
        const known=e=>!multiDay||!!atOf.get(e.stop_id);
        const excerpts=sql.prepare('SELECT stop_id,stop_index,record_date,excerpt,media_ids FROM PlaceDiaryExcerpt WHERE publication_id=? AND place_id=? ORDER BY stop_index').all(g.publication_id,id)
            .map(e=>({stop_id:e.stop_id,record_date:known(e)?e.record_date:'',excerpt:JSON.parse(e.excerpt),media_ids:JSON.parse(e.media_ids)}));
        const recordDate=excerpts.map(e=>e.record_date).filter(Boolean).sort().pop()||'';
        return {public_id:pub.id,title:snapshot.title,start_date:snapshot.start_date,end_date:snapshot.end_date,record_date:recordDate,author:author(pub),
            stops:excerpts,media_ids:[...new Set(excerpts.flatMap(e=>e.media_ids))].slice(0,3)};
    });
    const last=page.at(-1);
    return {total,items,next_cursor:groups.length>size&&last?encodeCursor(last.record_date,last.publication_id):null};
}
// The author's own private associations; never part of public counts.
function myPlaceRecords(userId,placeId) {
    const id=Number(placeId);
    if(!Number.isSafeInteger(id))fail('地点无效');
    return sql.prepare(`SELECT j.id,j.document,p.status AS publication_status FROM Journey j LEFT JOIN JourneyPublication p ON p.journey_id=j.id
        WHERE j.user_id=? AND EXISTS(SELECT 1 FROM json_each(j.document,'$.stops') s WHERE json_extract(s.value,'$.place_id')=?)
        ORDER BY json_extract(j.document,'$.start_date') DESC LIMIT 50`).all(userId,id)
        .map(r=>{const d=JSON.parse(r.document);return {id:r.id,title:d.title,start_date:d.start_date,end_date:d.end_date,visibility:r.publication_status==='active'?'public':'private'};});
}
module.exports={stopIsPublic,publicExcerpt,publicBody,buildPreview,mapPreview,commit,withdraw,withdrawPublication,publicationSummary,publicJourney,publicMedia,placeDiaries,myPlaceRecords};
