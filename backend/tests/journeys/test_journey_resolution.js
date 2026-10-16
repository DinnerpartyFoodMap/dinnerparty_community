const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {randomUUID}=require('crypto'),express=require('express'),jwt=require('jsonwebtoken');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yuyuko-resolution-'));
process.env.DB_FILE=path.join(temp,'test.sqlite');process.env.LOG_TO_FILE='false';process.env.LOG_TO_CONSOLE='false';
process.env.JOURNEY_LLM_API_KEY='';
process.env.AMAP_WEB_SERVICE_KEY='';process.env.AMAP_JOURNAL_STORAGE_ALLOWED='false';
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database'),store=require('../../modules/journeys/services/journeyStore'),ai=require('../../modules/journeys/services/journeyAI'),resolution=require('../../modules/journeys/services/journeyResolution');
const {createJourneyAlgorithmFixture}=require('../helpers/journeyAlgorithmFixture');
const sql=db._raw,nativeFetch=global.fetch;let server,stopWorker,algorithm;
async function main(){
    algorithm=await createJourneyAlgorithmFixture({capabilities:{text_ai:true}});
    init();init();
    const users=[randomUUID(),randomUUID()];for(const [i,id] of users.entries())sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,'澄清测试'+i,'unused');
    const tokens=users.map(id=>jwt.sign({id},process.env.JWT_SECRET||'yuyuko_secret_key'));
    const place=(name,lng)=>Number(sql.prepare('INSERT INTO Place(name,longitude,latitude) VALUES(?,?,30)').run(name,lng).lastInsertRowid);
    const far=place('同名面馆',80),near=place('同名面馆',120),other=place('新面馆',120.03);
    const candidate=(id,lng)=>({id:`local_${id}`,place_id:id,name:'同名面馆',lng,lat:30,source:'local',score:3});
    let document=store.normalizeDocument({title:'锚点案例',start_date:'2026-09-16',end_date:'2026-09-16',summary:'私人总结',stops:[
        {id:randomUUID(),name:'同名面馆',lng:null,lat:null,candidates:[candidate(far,80),candidate(near,120)],visit_status:'visited',confirmed:false,note:'不可上传的私人备注',expenses:[{id:randomUUID(),amount:39,note:'秘密账目'}]},
        {id:randomUUID(),name:'手动锚点',lng:120.02,lat:30,confirmed:false,visit_status:'visited',at:'2026-09-16T18:00'}
    ]},users[0]);
    require('node:module').register(require('url').pathToFileURL(path.resolve(__dirname, '../../../frontend/scripts/support/json-hooks.mjs')));
    const client=await import(require('url').pathToFileURL(path.resolve(__dirname, '../../../frontend/src/journey/resolution.mjs')).href);
    assert.equal(client.locationBasis(document),resolution.locationBasis(document));
    document.stops[1].confirmed=true;
    const rankSample={basis:resolution.locationBasis(document),patches:[{stop_id:document.stops[0].id,candidate_basis:'named',
        candidates:[{...candidate(near,120),suggested:true},{...candidate(far,80),suggested:false}],suggested_id:`local_${near}`}],
        resolution:{status:'needs_input',questions:[]},algorithm_version:'fixture-v1'};
    algorithm.result('rank',rankSample);
    const ranked=await resolution.rankedPatch(document);
    assert.deepEqual(ranked,rankSample,'the public adapter returns the remote patch');
    const edited=structuredClone(document);edited.stops[0].note='等待时补写';edited.stops[0].expenses[0].amount=99;edited.stops[0].at='2026-09-16T13:00';
    const applied=client.applyResolutionPatch(edited,ranked);
    assert.equal(applied.stops[0].note,'等待时补写');assert.equal(applied.stops[0].expenses[0].amount,99);assert.equal(applied.stops[0].at,'2026-09-16T13:00');assert.deepEqual(applied.stops[1],document.stops[1]);
    assert.throws(()=>client.applyResolutionPatch({...document,stops:[...document.stops].reverse()},ranked));
    const confirmed=structuredClone(document);confirmed.stops[0].confirmed=true;assert.throws(()=>client.applyResolutionPatch(confirmed,ranked));
    const deferred=structuredClone(document);deferred.stops[0].location_resolution='deferred';assert.equal(resolution.resolutionState(deferred).status,'partial');assert.equal(resolution.resolutionState(document).status,'needs_input');
    const ready=structuredClone(document);Object.assign(ready.stops[0],{lng:120,lat:30,confirmed:true});assert.equal(resolution.resolutionState(ready).status,'ready');
    const app=express();app.use(express.json({limit:'256kb'}));app.use('/api/journeys',require('../../modules/journeys/routes/journeys'));
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
    const call=async(method,url,body,status=200,who=0)=>{const r=await nativeFetch(base+'/api/journeys'+url,{method,headers:{Authorization:`Bearer ${tokens[who]}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=r.status===204?null:await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
    const draftId=randomUUID();let draft=await call('PUT',`/drafts/${draftId}`,{document,draft_revision:0,base_revision:0});
    await call('POST',`/drafts/${draftId}/rank`,{draft_revision:0},409);
    await call('POST',`/drafts/${draftId}/rank`,{draft_revision:1},404,1);
    assert.equal((await call('POST',`/drafts/${draftId}/rank`,{draft_revision:1})).patches[0].suggested_id,`local_${near}`);
    let clarificationCalls=0;
    algorithm.handle('clarify',({input})=>{
        clarificationCalls++;
        const patch=structuredClone(rankSample);
        patch.basis=resolution.locationBasis(input.document);
        if(clarificationCalls===2)patch.patches[0]={stop_id:input.stop_id,candidate_basis:'clue',candidates:[{...candidate(other,120.03),name:'新面馆',suggested:true}],suggested_id:`local_${other}`};
        return {...patch,kind:'clarification',draft_id:input.draft_id,draft_revision:input.draft_revision,answer:{stop_id:input.stop_id,text:input.answer,city:'杭州'}};
    });
    const input={draft_id:draftId,draft_revision:1,stop_id:document.stops[0].id,answer:'在杭州，靠近锚点',city:'杭州',request_id:randomUUID()};
    const job=await call('POST','/clarifications',input,202);assert.equal((await call('POST','/clarifications',input,202)).id,job.id);
    await call('POST','/clarifications',{...input,answer:'不同的线索'},409);
    await call('GET',`/jobs/${job.id}`,undefined,404,1);
    stopWorker=ai.startJourneyWorker();
    const awaitJob=async id=>{for(let i=0;i<50;i++){const j=await call('GET',`/jobs/${id}`);if(j.status==='ready')return j;if(j.status==='failed')throw Error(j.error);await new Promise(r=>setTimeout(r,100));}throw Error('worker timeout');};
    const first=await awaitJob(job.id);assert.equal(first.kind,'clarification');assert.equal(first.output.patches[0].suggested_id,`local_${near}`);assert.equal(first.output.resolution.status,'needs_input');assert.equal(first.output.answer.city,'杭州');
    document=client.applyResolutionPatch(document,first.output);document.stops[0].clarification_text='其实是新面馆';
    draft=await call('PUT',`/drafts/${draftId}`,{document,draft_revision:1,base_revision:0});
    const second=await call('POST','/clarifications',{...input,draft_revision:draft.revision,answer:'其实是新面馆',request_id:randomUUID()},202);
    const secondResult=await awaitJob(second.id);assert.equal(secondResult.output.patches[0].candidates[0].place_id,other);assert.equal(clarificationCalls,2);
    assert.equal(document.stops[0].name,'同名面馆','a model query must not rewrite the place name');
    stopWorker();stopWorker=null;
    for(let i=0;i<2;i++){const j=await call('POST','/clarifications',{...input,draft_revision:2,request_id:randomUUID()},202);await call('DELETE',`/jobs/${j.id}`,undefined,204);}
    await call('POST','/clarifications',{...input,draft_revision:2,request_id:randomUUID()},429);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM JourneyJobRequest WHERE user_id=?').get(users[0]).n,4,'rejected clarification rolls back its global quota entry');
    await call('DELETE',`/drafts/${draftId}`,{draft_revision:2},204);
    const beforeClosed=algorithm.calls.length;
    await assert.rejects(()=>resolution.clarify(users[0],{...first.input}),e=>e.status===410);
    assert.equal(algorithm.calls.length,beforeClosed,'a closed draft never reaches the service');
    console.log('Resolution tests passed: remote patches, protected edits, stale results, ownership, two clarification rounds, task replay, durable limits, and closed drafts.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    global.fetch=nativeFetch;if(stopWorker)stopWorker();if(server)await new Promise(r=>server.close(r));if(algorithm)await algorithm.close();sql.close();
    const resolved=path.resolve(temp);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('yuyuko-resolution-'))fs.rmSync(resolved,{recursive:true,force:true});
});
