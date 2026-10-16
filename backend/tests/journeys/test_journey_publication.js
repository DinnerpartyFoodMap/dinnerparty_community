// Material drafts, generation binding, public commit, map links, withdrawal and public reads
// against an isolated SQLite file and an independent algorithm protocol fixture.
const assert=require('assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {randomUUID}=require('crypto');
const express=require('express');
const jwt=require('jsonwebtoken');
const sharp=require('sharp');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yuyuko-journey-publication-'));
process.env.DB_FILE=path.join(temp,'test.sqlite');
process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
process.env.DEEPSEEK_API_KEY='';process.env.JOURNEY_LLM_API_KEY='';process.env.SILICONFLOW_API_KEY='';process.env.JOURNEY_LLM_VISION='false';
process.env.QQ_BOT_ENABLED='true';process.env.QQ_BOT_NOTIFY_ENABLED='true';process.env.QQ_BOT_NOTIFY_GROUP_IDS='20001,20002';
process.env.AMAP_WEB_SERVICE_KEY='';process.env.AMAP_JOURNAL_STORAGE_ALLOWED='false';process.env.AMAP_EXPORT_ALLOWED='false';
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database');
const sql=db._raw;
const nativeFetch=global.fetch;
const {createJourneyAlgorithmFixture,sealMergeSample}=require('../helpers/journeyAlgorithmFixture');
let server,stopWorker,algorithm;
async function main(){
    algorithm=await createJourneyAlgorithmFixture();
    init();init();
    const user=name=>{const id=randomUUID();sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,name,'unused');return id;};
    const a=user('公开日记甲'),b=user('公开日记乙');
    const place=(name,lng,lat)=>Number(sql.prepare('INSERT INTO Place(name,category,longitude,latitude) VALUES(?,?,?,?)').run(name,'面食',lng,lat).lastInsertRowid);
    const noodle=place('阿明牛肉面',120.1,30.2);
    const tokens=Object.fromEntries([a,b].map(id=>[id,jwt.sign({id},process.env.JWT_SECRET||'yuyuko_secret_key')]));
    const app=express();app.use(express.json({limit:'256kb'}));
    app.use('/api/journeys',require('../../modules/journeys/routes/journeys'));app.use('/api/public/journeys',require('../../modules/journeys/routes/publicJourneys'));app.use('/places',require('../../modules/places/routes/places'));
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const base=`http://127.0.0.1:${server.address().port}`;
    const call=async(method,url,body,who=a,status=200)=>{
        const response=await nativeFetch(base+url,{method,headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${tokens[who]}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
        const data=response.status===204?null:await response.json();assert.equal(response.status,status,`${method} ${url}: ${JSON.stringify(data)}`);return data;
    };
    const upload=async(who=a,color='#f08050')=>{
        const photo=await sharp({create:{width:40,height:30,channels:3,background:color}}).jpeg().toBuffer();
        const form=new FormData();form.append('image',new Blob([photo],{type:'image/jpeg'}),'food.jpg');
        const r=await nativeFetch(base+'/api/journeys/media',{method:'POST',headers:{Authorization:`Bearer ${tokens[who]}`},body:form});assert.equal(r.status,201);return (await r.json()).id;
    };
    const [dish,drink,extra]=[await upload(),await upload(a,'#80a0f0'),await upload(a,'#50c080')];

    // --- Material drafts: optimistic revisions, idempotent retry, isolation and discard. ---
    const composeId=randomUUID();
    const text='中午在阿明牛肉面吃了牛肉面，汤比较清淡。下午去巷口茶铺喝了乌龙奶茶。';
    const payload={text,media_ids:[dish,drink,extra],media_notes:{[dish]:{kind:'dish'}},start_date:'2026-10-01',end_date:'2026-10-01',
        center:{name:'大学城',city:'广州',lng:120.1,lat:30.2,source:'map'},intended_visibility:'public'};
    let compose=await call('PUT',`/api/journeys/compose-drafts/${composeId}`,{revision:0,payload});
    assert.equal(compose.revision,1);assert.equal(compose.payload.center.source,'map');assert.equal(compose.payload.intended_visibility,'public');
    assert.equal((await call('PUT',`/api/journeys/compose-drafts/${composeId}`,{revision:0,payload})).revision,1,'lost-response retry is acknowledged');
    await call('PUT',`/api/journeys/compose-drafts/${composeId}`,{revision:0,payload:{...payload,text:'另一个窗口'}},a,409);
    await call('GET',`/api/journeys/compose-drafts/${composeId}`,undefined,b,404);
    await call('PUT',`/api/journeys/compose-drafts/${composeId}`,{revision:1,payload:{...payload,media_ids:[randomUUID()]}},a,404);
    const legacy=await call('PUT',`/api/journeys/compose-drafts/${randomUUID()}`,{revision:0,payload:{text:'旧记录'}});
    assert.equal(legacy.payload.intended_visibility,'private','records without a visibility choice stay private');
    await call('DELETE',`/api/journeys/media/${extra}`,undefined,a,409);
    await call('DELETE',`/api/journeys/compose-drafts/${legacy.id}`,{revision:0},a,409);
    await call('DELETE',`/api/journeys/compose-drafts/${legacy.id}`,{revision:1},a,204);
    await call('PUT',`/api/journeys/compose-drafts/${legacy.id}`,{revision:1,payload:{text:'迟到的保存'}},a,410);
    assert.equal((await call('GET','/api/journeys/unfinished')).material.length,1);

    // --- Generation: frozen snapshot, request replay, explicit text-only mode, one review draft. ---
    await call('POST',`/api/journeys/compose-drafts/${composeId}/generate`,{compose_revision:1,request_id:randomUUID()},a,503);
    algorithm.setCapabilities({text_ai:true});
    await call('POST',`/api/journeys/compose-drafts/${composeId}/generate`,{compose_revision:1,request_id:randomUUID()},a,503);
    const generatedSample={document:{title:'大学城的一天',summary:'吃面，喝茶。',start_date:'2026-10-01',end_date:'2026-10-01',
        entry_media_ids:[dish,drink,extra],media_meta:{[dish]:{kind:'dish',kind_source:'user'}},source_input:{text,start_date:'2026-10-01',end_date:'2026-10-01',center:payload.center},stops:[
            {id:'generated-noodle',name:'阿明牛肉面',note:'',at:'',mood:'',media_ids:[dish],expenses:[],confirmed:false,visit_status:'visited',lng:null,lat:null,excerpts:[{start:0,end:22,text:'中午在阿明牛肉面吃了牛肉面，汤比较清淡。'}]},
            {id:'generated-tea',name:'待选店',note:'',at:'',mood:'',media_ids:[drink],expenses:[],confirmed:false,visit_status:'visited',lng:null,lat:null,excerpts:[{start:22,end:36,text:'下午去巷口茶铺喝了乌龙奶茶。'}]}
        ]},questions:[],resolution:{status:'needs_input',questions:[]},text_only:true};
    // This is a finished service response; extraction and place matching are private tests.
    generatedSample.document.stops[0].excerpts[0].end=generatedSample.document.stops[0].excerpts[0].text.length;
    generatedSample.document.stops[1].excerpts[0].start=generatedSample.document.stops[0].excerpts[0].end;
    generatedSample.document.stops[1].excerpts[0].end=text.length;
    algorithm.result('reconstruct',generatedSample);
    const requestId=randomUUID();
    const job=await call('POST',`/api/journeys/compose-drafts/${composeId}/generate`,{compose_revision:1,request_id:requestId,text_only:true},a,202);
    assert.equal((await call('POST',`/api/journeys/compose-drafts/${composeId}/generate`,{compose_revision:1,request_id:requestId,text_only:true},a,202)).id,job.id);
    assert.equal((await call('GET','/api/journeys/unfinished')).generating.length,1);
    stopWorker=require('../../modules/journeys/services/journeyAI').startJourneyWorker();
    let ready;
    for(let i=0;i<40;i++){ready=await call('GET',`/api/journeys/jobs/${job.id}`);if(ready.status!=='queued'&&ready.status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    stopWorker();stopWorker=null;global.fetch=nativeFetch;
    assert.equal(ready.status,'ready',JSON.stringify(ready));assert.ok(ready.draft_id);assert.equal(ready.output.draft_id,ready.draft_id);
    assert.deepEqual(algorithm.calls.find(c=>c.operation==='reconstruct').input.images,[],'text-only generation sends no image bytes to the service');
    const generated=await call('GET',`/api/journeys/drafts/${ready.draft_id}`);
    const gdoc=generated.document;
    assert.equal(generated.compose_draft_id,composeId);assert.equal(gdoc.intended_visibility,'public');
    assert.deepEqual(gdoc.entry_media_ids,[dish,drink,extra],'every photo stays with the entry, including unassigned ones');
    assert.equal(gdoc.source_input.text,text);assert.equal(gdoc.source_input.center.name,'大学城');
    assert.equal(gdoc.media_meta[dish].kind,'dish');assert.equal(gdoc.media_meta[dish].kind_source,'user');
    assert.deepEqual(gdoc.stops.map(s=>s.id),['generated-noodle','generated-tea'],'the finished service document is bound to one review draft');
    const pending=await call('GET','/api/journeys/unfinished');
    assert.equal(pending.review.length,1);assert.equal(pending.material.length,0);assert.equal(pending.generating.length,0);

    // --- Review edits, then a public commit that links one marker and creates one. ---
    const review={...gdoc,stops:[
        {...gdoc.stops[0],place_id:noodle,source:'local',lng:120.1,lat:30.2,confirmed:true},
        {...gdoc.stops[1],name:'巷口茶铺',lng:120.1015,lat:30.2012,confirmed:true,category:'饮品',expenses:[{id:randomUUID(),amount:18,note:'奶茶'}],note:'私人备注：排队很久'},
        {id:randomUUID(),name:'想去的甜品店',note:'',at:'',mood:'',media_ids:[],expenses:[],visit_status:'planned',confirmed:false,lng:120.2,lat:30.3,source:'manual'}
    ]};
    const saveDraft=async(id,revision,document,who=a)=>call('PUT',`/api/journeys/drafts/${id}`,{document,draft_revision:revision,base_revision:0},who);
    let draft=await saveDraft(ready.draft_id,1,review);
    let preview=await call('POST',`/api/journeys/drafts/${draft.id}/map-preview`,{draft_revision:draft.revision,visibility:'public'});
    assert.deepEqual([preview.counts.link,preview.counts.create,preview.counts.conflict,preview.counts.public_stops],[1,1,0,2]);
    assert.equal(preview.links[2].action,'none');assert.equal(preview.body.stops.length,2,'planned stops are private by default');
    assert.ok(!JSON.stringify(preview.body).includes('私人备注'));assert.ok(!JSON.stringify(preview.body).includes('amount'));
    await call('POST',`/api/journeys/drafts/${draft.id}/map-preview`,{draft_revision:draft.revision,visibility:'public'},b,404);
    await call('POST',`/api/journeys/drafts/${draft.id}/commit`,{draft_revision:draft.revision,visibility:'public',preview_hash:'stale',request_id:randomUUID()},a,409);
    const commitId=randomUUID();
    const commitBody={draft_revision:draft.revision,visibility:'public',preview_hash:preview.preview_hash,request_id:commitId};
    await call('POST',`/api/journeys/drafts/${draft.id}/commit`,commitBody,b,404);
    const placesBefore=sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
    const committed=await call('POST',`/api/journeys/drafts/${draft.id}/commit`,commitBody);
    assert.equal(committed.visibility,'public');assert.equal(committed.created_place_ids.length,1);assert.equal(committed.linked,2);assert.ok(committed.public_id);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n,placesBefore+1);
    const replay=await call('POST',`/api/journeys/drafts/${draft.id}/commit`,commitBody);
    assert.equal(replay.journey_id,committed.journey_id);assert.equal(replay.replayed,true);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n,placesBefore+1,'a retried save never creates markers twice');
    await call('POST',`/api/journeys/drafts/${draft.id}/commit`,{...commitBody,visibility:'private'},a,409);
    const teaShop=committed.created_place_ids[0];
    const notified=placeId=>sql.prepare("SELECT group_id FROM QQBotNotification WHERE place_id=? AND event_type='place_created' ORDER BY group_id").all(placeId).map(r=>r.group_id);
    const notifications=()=>sql.prepare('SELECT COUNT(*) AS n FROM QQBotNotification').get().n;
    assert.deepEqual(notified(teaShop),['20001','20002'],'a marker created by a public diary notifies every group once');
    assert.deepEqual(notified(noodle),[],'linking an existing marker does not notify');
    assert.equal(notifications(),2,'the replayed commit queued nothing more');
    assert.equal(sql.prepare('SELECT name,creator_id FROM Place WHERE id=?').get(teaShop).name,'巷口茶铺');
    const savedJourney=await call('GET',`/api/journeys/${committed.journey_id}`);
    assert.equal(savedJourney.visibility,'public');assert.equal(savedJourney.document.stops[1].place_id,teaShop,'the saved diary points at the created marker');
    assert.equal(savedJourney.publication.linked_places,2);assert.equal(savedJourney.publication.outdated,false);
    assert.equal((await call('GET',`/api/journeys/compose-drafts/${composeId}`,undefined,a,410)).error.includes('日记'),true,'material draft closes with the save');
    assert.equal((await call('GET','/api/journeys/unfinished')).count,0);

    // --- Public reading: whitelist only, photos gated by the active snapshot. ---
    const pub=await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null);
    const pubText=JSON.stringify(pub);
    assert.equal(pub.title,'大学城的一天');assert.equal(pub.stops.length,2);assert.equal(pub.stops[0].excerpt[0].kind,'quote');
    for(const secret of ['私人备注','大学城"','source_input','expenses','想去的甜品店','"center"'])assert.ok(!pubText.includes(secret),`public payload leaks ${secret}`);
    assert.ok(!pub.media_ids.includes(extra),'unselected entry photos stay private');
    const media=async(id,status)=>{const r=await nativeFetch(`${base}/api/public/journeys/${committed.public_id}/media/${id}`);assert.equal(r.status,status);};
    await media(dish,200);await media(extra,404);
    let diaries=await call('GET',`/places/${noodle}/diaries`,undefined,null);
    assert.equal(diaries.total,1);assert.equal(diaries.items[0].public_id,committed.public_id);assert.equal(diaries.items[0].stops[0].excerpt[0].text,'中午在阿明牛肉面吃了牛肉面，汤比较清淡。');
    assert.equal((await call('GET',`/places/${teaShop}/diaries`,undefined,null)).total,1);
    await call('DELETE',`/api/journeys/media/${dish}`,undefined,a,409);

    // --- Duplicate protection for manual points; acknowledged duplicates create once. ---
    const manualStop={id:randomUUID(),name:'阿明牛肉面（东门店）',note:'',at:'',mood:'',media_ids:[],expenses:[],visit_status:'visited',confirmed:true,lng:120.1008,lat:30.2005,source:'manual',
        excerpts:[],excerpt_edited:'第二次来，换了东门那家。'};
    const second={title:'东门再访',start_date:'2026-10-05',end_date:'2026-10-05',summary:'',stops:[manualStop,{...manualStop,id:randomUUID(),excerpt_edited:'同一天又来了一次。'}],intended_visibility:'public'};
    let draft2=await saveDraft(randomUUID(),0,second);
    preview=await call('POST',`/api/journeys/drafts/${draft2.id}/map-preview`,{draft_revision:draft2.revision,visibility:'public'});
    assert.equal(preview.counts.conflict,2);assert.equal(preview.links[0].duplicates[0].id,noodle);
    await call('POST',`/api/journeys/drafts/${draft2.id}/commit`,{draft_revision:draft2.revision,visibility:'public',preview_hash:preview.preview_hash,request_id:randomUUID()},a,409);
    draft2=await call('PUT',`/api/journeys/drafts/${draft2.id}`,{document:{...second,stops:second.stops.map(s=>({...s,duplicate_ack:[noodle]}))},draft_revision:draft2.revision,base_revision:0});
    preview=await call('POST',`/api/journeys/drafts/${draft2.id}/map-preview`,{draft_revision:draft2.revision,visibility:'public'});
    assert.deepEqual([preview.counts.create,preview.counts.conflict],[1,0],'two visits to one new shop create one marker');
    const second2=await call('POST',`/api/journeys/drafts/${draft2.id}/commit`,{draft_revision:draft2.revision,visibility:'public',preview_hash:preview.preview_hash,request_id:randomUUID()});
    assert.equal(second2.created_place_ids.length,1);
    const eastShop=second2.created_place_ids[0];
    assert.deepEqual(notified(eastShop),['20001','20002']);assert.equal(notifications(),4,'two stops of one new shop notify once');
    diaries=await call('GET',`/places/${eastShop}/diaries`,undefined,null);
    assert.equal(diaries.total,1,'counts distinct diaries');assert.equal(diaries.items[0].stops.length,2);assert.equal(diaries.items[0].stops[0].excerpt[0].kind,'edited');

    // --- Private save: no public object and no marker creation; existing places stay a private association. ---
    const privateDoc={title:'私密的一餐',start_date:'2026-10-06',end_date:'2026-10-06',summary:'',intended_visibility:'private',stops:[
        {...manualStop,id:randomUUID(),name:'私密新店',lng:121,lat:31,duplicate_ack:[]},{...manualStop,id:randomUUID(),name:'阿明牛肉面',place_id:noodle,source:'local',lng:120.1,lat:30.2}]};
    const draft3=await saveDraft(randomUUID(),0,privateDoc);
    preview=await call('POST',`/api/journeys/drafts/${draft3.id}/map-preview`,{draft_revision:draft3.revision,visibility:'private'});
    assert.deepEqual(preview.links.map(l=>l.action),['none','link']);assert.equal(preview.body,null);
    const before3=sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
    const privateSaved=await call('POST',`/api/journeys/drafts/${draft3.id}/commit`,{draft_revision:draft3.revision,visibility:'private',preview_hash:preview.preview_hash,request_id:randomUUID()});
    assert.equal(privateSaved.public_id,null);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n,before3);
    assert.equal(notifications(),4,'private diaries never notify');
    assert.equal((await call('GET',`/places/${noodle}/diaries`,undefined,null)).total,1,'private associations never reach public counts');
    assert.equal((await call('GET',`/api/journeys/places/${noodle}/mine`)).length,2);
    assert.equal((await call('GET',`/api/journeys/places/${noodle}/mine`,undefined,b)).length,0);

    // --- External identities: concurrent choices of one POI reuse a single marker. ---
    process.env.AMAP_JOURNAL_STORAGE_ALLOWED='true';
    const poiStop=()=>({id:randomUUID(),name:'高德上的面馆',note:'',at:'',mood:'',media_ids:[],expenses:[],visit_status:'visited',confirmed:true,lng:118,lat:32,source:'amap',external_id:'amap_B0TEST01'});
    const poiResults=[];
    for(const who of [a,b]){
        const d=await saveDraft(randomUUID(),0,{title:'POI',start_date:'2026-10-07',end_date:'2026-10-07',summary:'',stops:[poiStop()]},who);
        const p=await call('POST',`/api/journeys/drafts/${d.id}/map-preview`,{draft_revision:d.revision,visibility:'public'},who);
        poiResults.push(await call('POST',`/api/journeys/drafts/${d.id}/commit`,{draft_revision:d.revision,visibility:'public',preview_hash:p.preview_hash,request_id:randomUUID()},who));
    }
    assert.equal(poiResults[0].created_place_ids.length,1);assert.equal(poiResults[1].created_place_ids.length,0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM Place WHERE name='高德上的面馆'").get().n,1);
    assert.equal((await call('GET',`/places/${poiResults[0].created_place_ids[0]}/diaries`,undefined,null)).total,2);
    process.env.AMAP_JOURNAL_STORAGE_ALLOWED='false';

    // --- Legacy private edits keep the last public version and flag it as outdated. ---
    const current=await call('GET',`/api/journeys/${committed.journey_id}`);
    await call('PUT',`/api/journeys/${committed.journey_id}`,{document:{...current.document,title:'旧接口改了标题'},base_revision:current.revision});
    const outdated=await call('GET',`/api/journeys/${committed.journey_id}`);
    assert.equal(outdated.publication.outdated,true);assert.equal((await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null)).title,'大学城的一天');
    const month=await call('GET','/api/journeys/calendar?from=2026-10-01&to=2026-10-31');
    assert.equal(month.entries.find(e=>e.id===committed.journey_id).public_outdated,true);
    assert.equal(month.entries.find(e=>e.id===privateSaved.journey_id).visibility,'private');
    await call('GET','/api/journeys/calendar?from=2026-10-31&to=2026-10-01',undefined,a,400);

    // --- Updating public content goes through a fresh preview of the current public version. ---
    const editDraftId=randomUUID();
    const editDraft=await call('PUT',`/api/journeys/drafts/${editDraftId}`,{document:{...outdated.document,intended_visibility:'public'},draft_revision:0,journey_id:committed.journey_id,base_revision:outdated.revision});
    const stalePreview=await call('POST',`/api/journeys/drafts/${editDraftId}/map-preview`,{draft_revision:editDraft.revision,visibility:'public'});

    // --- Withdrawal: version checked, everything public stops immediately, late retries cannot republish. ---
    await call('DELETE',`/api/journeys/${committed.journey_id}/publication`,{version:99},a,409);
    await call('DELETE',`/api/journeys/${committed.journey_id}/publication`,{version:1},b,404);
    const withdrawn=await call('DELETE',`/api/journeys/${committed.journey_id}/publication`,{version:1});
    assert.equal(withdrawn.status,'withdrawn');assert.equal(withdrawn.version,2);
    assert.equal((await call('DELETE',`/api/journeys/${committed.journey_id}/publication`,{version:1})).status,'withdrawn','withdraw is idempotent');
    await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null,404);await media(dish,404);
    assert.equal((await call('GET',`/places/${noodle}/diaries`,undefined,null)).total,0);
    const late=await call('POST',`/api/journeys/drafts/${draft.id}/commit`,commitBody);
    assert.equal(late.replayed,true);assert.equal(late.publication.status,'withdrawn','a late retry reports the current state');
    await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null,404);
    const staleCommit=await call('POST',`/api/journeys/drafts/${editDraftId}/commit`,{draft_revision:editDraft.revision,visibility:'public',preview_hash:stalePreview.preview_hash,request_id:randomUUID()},a,409);
    assert.equal(staleCommit.code,'preview_stale','a window opened before withdrawal cannot republish its old preview');
    const freshPreview=await call('POST',`/api/journeys/drafts/${editDraftId}/map-preview`,{draft_revision:editDraft.revision,visibility:'public'});
    const republished=await call('POST',`/api/journeys/drafts/${editDraftId}/commit`,{draft_revision:editDraft.revision,visibility:'public',preview_hash:freshPreview.preview_hash,request_id:randomUUID()});
    assert.equal(republished.public_id,committed.public_id,'the public link stays stable');assert.equal(republished.publication_version,3);
    assert.equal((await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null)).title,'旧接口改了标题');

    // --- Deleting a marker keeps diaries; deleting a diary removes its public excerpts. ---
    sql.prepare('DELETE FROM Place WHERE id=?').run(teaShop);
    assert.equal((await call('GET',`/places/${teaShop}/diaries`,undefined,null)).total,0);
    const afterDelete=await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null);
    assert.equal(afterDelete.stops[1].place_id,null);assert.equal(afterDelete.stops[1].name,'巷口茶铺');
    const kept=await call('GET',`/api/journeys/${committed.journey_id}`);assert.equal(kept.document.stops[1].name,'巷口茶铺');
    const relink=await saveDraft(randomUUID(),0,{...kept.document,stops:[kept.document.stops[1]],intended_visibility:'public'});
    const relinkPreview=await call('POST',`/api/journeys/drafts/${relink.id}/map-preview`,{draft_revision:relink.revision,visibility:'public'});
    assert.equal(relinkPreview.links[0].reason,'place_removed','a deleted marker is not silently recreated');
    await call('DELETE',`/api/journeys/${committed.journey_id}`,{base_revision:kept.revision},a,204);
    await call('GET',`/api/public/journeys/${committed.public_id}`,undefined,null,404);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM JourneyPublication WHERE id=?').get(committed.public_id).n,0);

    // --- A finished merge result persists its media and stays private. ---
    const store=require('../../modules/journeys/services/journeyStore');
    const m1=store.saveJourney(a,{title:'上午',start_date:'2026-10-08',end_date:'2026-10-08',summary:'',entry_media_ids:[drink],source_input:{text:'早上喝豆浆。'},
        stops:[{id:randomUUID(),name:'豆浆铺',note:'',at:'',mood:'',media_ids:[],expenses:[],excerpts:[{start:0,end:6,text:'早上喝豆浆。'}]}]});
    const m2=store.saveJourney(a,{title:'下午',start_date:'2026-10-08',end_date:'2026-10-08',summary:'',entry_media_ids:[drink,extra],source_input:{text:'下午吃了烧饼。'},
        stops:[{id:randomUUID(),name:'烧饼摊',note:'',at:'',mood:'',media_ids:[],expenses:[],excerpts:[{start:0,end:7,text:'下午吃了烧饼。'}]}]});
    algorithm.result('merge',sealMergeSample({document:{title:'合并样本',start_date:'2026-10-08',end_date:'2026-10-08',summary:'',entry_media_ids:[drink,extra],
        source_input:{text:'早上喝豆浆。\n\n下午吃了烧饼。'},stops:[{...m1.document.stops[0],id:'merged-soymilk'},{...m2.document.stops[0],id:'merged-bread',excerpts:[{start:8,end:15,text:'下午吃了烧饼。'}]}]},
        sources:[{id:m1.id,revision:1},{id:m2.id,revision:1}],conflicts:[],warnings:[],total_minor:0,order_policy:'constraints'}));
    const mp=await call('POST','/api/journeys/merge/preview',{first_id:m1.id,second_id:m2.id,revisions:[1,1]});
    const merged=await call('POST','/api/journeys/merge',{first_id:m1.id,second_id:m2.id,revisions:[1,1],preview_hash:mp.preview_hash},a,201);
    assert.deepEqual(merged.document.entry_media_ids,[drink,extra]);assert.equal(merged.document.source_input.text,'早上喝豆浆。\n\n下午吃了烧饼。');
    assert.deepEqual(merged.document.stops.map(s=>s.excerpts[0].text),['早上喝豆浆。','下午吃了烧饼。']);
    assert.equal((await call('GET',`/api/journeys/${merged.id}`)).visibility,'private','merging never creates public content');

    // Source revisions are checked again after remote planning, outside a write transaction.
    let releaseMerge,enterMerge;
    const mergeGate=new Promise(resolve=>{releaseMerge=resolve;}),mergeEntered=new Promise(resolve=>{enterMerge=resolve;});
    algorithm.handle('merge',async()=>{
        assert.equal(sql.inTransaction,false,'remote computation must not hold a SQLite transaction');
        enterMerge();await mergeGate;return mp;
    });
    const beforeRace=sql.prepare('SELECT COUNT(*) AS n FROM Journey').get().n;
    const staleMerge=call('POST','/api/journeys/merge',{first_id:m1.id,second_id:m2.id,revisions:[1,1],preview_hash:mp.preview_hash,request_id:randomUUID()},a,409);
    await Promise.race([mergeEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('merge protocol request did not arrive')),5000))]);
    store.saveJourney(a,{...m1.document,title:'远程计算期间更新'},m1.id,1);
    releaseMerge();await staleMerge;
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Journey').get().n,beforeRace,'a stale remote plan creates no journey');


    // --- Account deletion removes public content with the account. ---
    const poiPublic=poiResults[1].public_id;
    await call('GET',`/api/public/journeys/${poiPublic}`,undefined,null);
    sql.prepare('DELETE FROM User WHERE id=?').run(b);
    await call('GET',`/api/public/journeys/${poiPublic}`,undefined,null,404);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM PlaceDiaryExcerpt WHERE user_id=?').get(b).n,0);
    // ===== Review regressions (docs/diary-implementation-review.md) =====
    const c2=user('评审回归');tokens[c2]=jwt.sign({id:c2},process.env.JWT_SECRET||'yuyuko_secret_key');
    const photo2=await upload(c2,'#a0c070');
    // #1 Saving a review draft made from material v1 must not close material that was updated to v2 meanwhile.
    const matId=randomUUID();
    const mat1=await call('PUT',`/api/journeys/compose-drafts/${matId}`,{revision:0,payload:{text:'第一版素材',media_ids:[],start_date:'2026-10-02',end_date:'2026-10-02',intended_visibility:'private'}},c2);
    const manual=await call('PUT',`/api/journeys/drafts/${randomUUID()}`,{document:{title:'第一版',start_date:'2026-10-02',end_date:'2026-10-02',summary:'',stops:[],source_input:{text:'第一版素材'}},
        draft_revision:0,base_revision:0,compose_draft_id:matId,compose_revision:mat1.revision},c2);
    await call('PUT',`/api/journeys/compose-drafts/${matId}`,{revision:1,payload:{text:'第二版：另一个窗口补写了文字和照片',media_ids:[photo2],start_date:'2026-10-02',end_date:'2026-10-02',intended_visibility:'private'}},c2);
    let pv=await call('POST',`/api/journeys/drafts/${manual.id}/map-preview`,{draft_revision:manual.revision,visibility:'private'},c2);
    await call('POST',`/api/journeys/drafts/${manual.id}/commit`,{draft_revision:manual.revision,visibility:'private',preview_hash:pv.preview_hash,request_id:randomUUID()},c2);
    const keptMaterial=await call("GET",`/api/journeys/compose-drafts/${matId}`,undefined,c2);
    assert.equal(keptMaterial.payload.text,"第二版：另一个窗口补写了文字和照片","newer material survives");assert.deepEqual(keptMaterial.payload.media_ids,[photo2]);
    const left=await call('GET','/api/journeys/unfinished',undefined,c2);
    assert.equal(left.material.length,1);assert.equal(left.material[0].id,matId);
    // The exact revision still closes normally.
    const matB=randomUUID(),mb=await call('PUT',`/api/journeys/compose-drafts/${matB}`,{revision:0,payload:{text:'只有一版'}},c2);
    const mbDraft=await call('PUT',`/api/journeys/drafts/${randomUUID()}`,{document:{title:'一版',start_date:'2026-10-02',end_date:'2026-10-02',summary:'',stops:[]},draft_revision:0,base_revision:0,compose_draft_id:matB,compose_revision:mb.revision},c2);
    pv=await call('POST',`/api/journeys/drafts/${mbDraft.id}/map-preview`,{draft_revision:1,visibility:'private'},c2);
    await call('POST',`/api/journeys/drafts/${mbDraft.id}/commit`,{draft_revision:1,visibility:'private',preview_hash:pv.preview_hash,request_id:randomUUID()},c2);
    await call('GET',`/api/journeys/compose-drafts/${matB}`,undefined,c2,410);

    // #6 A zero-stop diary can publish author-chosen text and photos; nothing private is copied in automatically.
    const zero={title:'只有图文',start_date:'2026-10-03',end_date:'2026-10-03',summary:'',stops:[],entry_media_ids:[photo2],source_input:{text:'私人原文不应自动公开'},intended_visibility:'public'};
    let zd=await call('PUT',`/api/journeys/drafts/${randomUUID()}`,{document:zero,draft_revision:0,base_revision:0},c2);
    pv=await call('POST',`/api/journeys/drafts/${zd.id}/map-preview`,{draft_revision:zd.revision,visibility:'public'},c2);
    assert.equal(pv.counts.empty_public,true,'an empty public diary is flagged');
    zd=await call('PUT',`/api/journeys/drafts/${zd.id}`,{document:{...zero,public_text:'作者选择公开的一段话',public_media_ids:[photo2]},draft_revision:zd.revision,base_revision:0},c2);
    pv=await call('POST',`/api/journeys/drafts/${zd.id}/map-preview`,{draft_revision:zd.revision,visibility:'public'},c2);
    assert.equal(pv.counts.empty_public,false);assert.equal(pv.counts.public_photos,1);
    const zc=await call('POST',`/api/journeys/drafts/${zd.id}/commit`,{draft_revision:zd.revision,visibility:'public',preview_hash:pv.preview_hash,request_id:randomUUID()},c2);
    const zp=await call('GET',`/api/public/journeys/${zc.public_id}`,undefined,null);
    assert.equal(zp.text,'作者选择公开的一段话');assert.deepEqual(zp.entry_media_ids,[photo2]);assert.ok(!JSON.stringify(zp).includes('私人原文'));
    assert.equal((await nativeFetch(`${base}/api/public/journeys/${zc.public_id}/media/${photo2}`)).status,200);

    // A deleted generation may finish remotely, but can never attach a late review draft.
    const canceledCompose=randomUUID();
    await call('PUT',`/api/journeys/compose-drafts/${canceledCompose}`,{revision:0,payload:{text:'取消中的素材',start_date:'2026-10-09',end_date:'2026-10-09',media_ids:[]}},c2);
    const canceledJob=await call('POST',`/api/journeys/compose-drafts/${canceledCompose}/generate`,{compose_revision:1,request_id:randomUUID()},c2,202);
    let releaseGeneration,enterGeneration;
    const generationGate=new Promise(resolve=>{releaseGeneration=resolve;}),generationEntered=new Promise(resolve=>{enterGeneration=resolve;});
    const finished={document:{title:'远程完成',start_date:'2026-10-09',end_date:'2026-10-09',summary:'',stops:[],entry_media_ids:[]},questions:[],resolution:{status:'ready',questions:[]}};
    algorithm.handle('reconstruct',async()=>{assert.equal(sql.inTransaction,false);enterGeneration();await generationGate;return finished;});
    stopWorker=require('../../modules/journeys/services/journeyAI').startJourneyWorker();
    await Promise.race([generationEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('reconstruct protocol request did not arrive')),5000))]);
    await call('DELETE',`/api/journeys/jobs/${canceledJob.id}`,undefined,c2,204);
    releaseGeneration();algorithm.result('reconstruct',finished);
    const nextJob=await call('POST','/api/journeys/jobs',{request_id:randomUUID(),text:'证明后台已处理迟到结果',start_date:'2026-10-09',media_ids:[]},c2,202);
    let nextReady;
    for(let i=0;i<50;i++){nextReady=await call('GET',`/api/journeys/jobs/${nextJob.id}`,undefined,c2);if(nextReady.status==='ready'||nextReady.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(nextReady.status,'ready',JSON.stringify(nextReady));
    stopWorker();stopWorker=null;
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM JourneyDraft WHERE compose_draft_id=?').get(canceledCompose).n,0);
    assert.equal(sql.prepare('SELECT structured_draft_id FROM JourneyComposeDraft WHERE id=?').get(canceledCompose).structured_draft_id,null);
    await call('GET',`/api/journeys/jobs/${canceledJob.id}`,undefined,c2,404);

    console.log('Journey publication tests passed: material drafts, generation binding, public/private commit, map links, dedupe, withdrawal, public reads, merge and deletion, plus review regressions #1 #6.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{stopWorker?.();global.fetch=nativeFetch;if(server)await new Promise(r=>server.close(r));if(algorithm)await algorithm.close();db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
