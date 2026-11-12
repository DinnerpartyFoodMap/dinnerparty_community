const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'random-chain-'));Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');init();const sql=db._raw;
require('../../modules/accounts/middleware/auth').requireAuth=(req,res,next)=>{req.user={id:req.headers['x-user']||'a'};next();};
require('../../modules/preferences/services/userPreferenceService').getUserPreference=async()=>null;
require('../../modules/discovery/services/randomRecommendation').prepareNearbyRecommendation=async(database,center,viewer,fallback,radiusKm)=>{assert.ok([0.5,1,3,5,10].includes(radiusKm));return {candidates:[1,2,3,4,5].map(id=>({place:{id,name:'p'+id},distanceKm:1,weight:1})),personalize:null};};
const app=require('express')();app.use(require('express').json());app.use(require('../../modules/community/routes/community'));let server;
async function main(){
 for(const id of ['a','b'])sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'x');
 for(const id of [1,2,3,4,5])sql.prepare("INSERT INTO Place(id,name,creator_id) VALUES(?,?,'a')").run(id,'p'+id);
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(url,body,user='a')=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','x-user':user},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const first={draw_id:'first_draw_identifier',recommendation_session_id:'recommendation_session',center:{lat:1,lng:1},exclude_ids:[],consent_version:0};
 const a=await call('/draw',first);assert.equal(a.status,200);assert.equal(a.data.draw_index,0);assert.equal(a.data.recommendation_session_id,first.recommendation_session_id);
 assert.deepEqual((await call('/draw',first)).data,a.data,'retry retains draw');
 const second={...first,draw_id:'second_draw_identifier',parent_decision_id:first.draw_id};const b=await call('/draw',second);assert.equal(b.data.draw_index,1);
 assert.equal((await call('/draw',{...second,draw_id:'stolen_parent_draw'},'b')).status,409);
 assert.equal((await call('/draw',{...second,draw_id:'forked_draw_identifier'})).status,409);
 const scoped={...first,draw_id:'scoped_draw_identifier',recommendation_session_id:'scoped_recommendation',radiusKm:0.5};
 assert.equal((await call('/draw',scoped)).status,200);
 assert.equal((await call('/draw',{...scoped,radiusKm:10})).status,409,'same ID cannot replay a different range');
 assert.equal((await call('/draw',{...scoped,draw_id:'invalid_radius_identifier',radiusKm:2})).status,400);
 const unselected=[1,2,3,4,5].find(id=>id!==a.data.place.id);
 const event={id:'unselected_click_event',session_id:'feedback_session_id',kind:'click',surface:'random',place_id:unselected,decision_id:first.draw_id};
 assert.equal((await call('/feedback',{consent_version:0,events:[event]})).data.accepted,0);
 assert.equal((await call('/feedback',{consent_version:0,events:[{...event,id:'unselected_exposure_event',kind:'exposure'}]})).data.accepted,0);
 const snapshot=JSON.parse(sql.prepare('SELECT snapshot FROM MapDecision WHERE id=?').get(first.draw_id).snapshot);assert.equal(snapshot.surface,'random');assert.equal(snapshot.selected_place_id,a.data.place.id);
 snapshot.algorithm='future-random-policy';sql.prepare('UPDATE MapDecision SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),first.draw_id);
 assert.equal((await call('/feedback',{consent_version:0,events:[{...event,id:'wrong_surface_event_id',place_id:a.data.place.id,surface:'map'}]})).status,400,'surface attribution survives algorithm version changes');
 const evidence=require('../../modules/ratings/services/ratingEvidence');evidence.recordResearchChoice('a',true);
 const viewport={minLng:113.1,minLat:22.9,maxLng:113.3,maxLat:23.1,zoom:15.5};
 const selectedEvent={...event,id:'selected_click_event_id',place_id:a.data.place.id,viewport};
 assert.equal((await call('/feedback',{consent_version:0,events:[selectedEvent]})).data.accepted,1);
 const mapClick={id:'map_place_click_event',session_id:event.session_id,kind:'click',surface:'map',place_id:1};
 const mapEvents=[
     {...mapClick,viewport:{...viewport,extra:'discard'}},
     {...mapClick,id:'legacy_map_click_event'},
     {...mapClick,id:'invalid_map_click_event',viewport:{...viewport,maxLng:100}},
     {...mapClick,id:'invalid_zoom_click_event',viewport:{...viewport,zoom:Infinity}}
 ];
 assert.equal((await call('/feedback',{consent_version:0,events:mapEvents})).data.accepted,4);
 assert.equal((await call('/feedback',{consent_version:0,events:[{...mapClick,viewport:{...viewport,zoom:12}}]})).data.accepted,0);
 assert.equal((await call('/feedback',{consent_version:1,events:[{...mapClick,id:'stale_viewport_click_event',viewport}]})).data.accepted,0);
 const savedContexts=sql.prepare('SELECT context FROM MapInteractionContext WHERE event_id=?');
 assert.deepEqual(JSON.parse(savedContexts.get(mapClick.id)?.context??'null'),{viewport});
 for(const e of [...mapEvents.slice(1),selectedEvent])assert.equal(savedContexts.get(e.id),undefined);
 const rows=require('../../modules/community/services/feedbackDataset').buildDataset(sql,{secret:'s'.repeat(32),localDataAllowed:true});
 const exported=rows.find(row=>row.event_id===selectedEvent.id);assert.ok(exported);assert.equal(exported.draw_index,0);assert.equal(exported.decision_surface,'random');assert.equal(exported.parent_decision_id,null);assert.deepEqual(exported.model_version,snapshot.model_version??null);assert.deepEqual(exported.feature_snapshot,snapshot.feature_snapshot??null);assert.ok(exported.recommendation_session_id);
 assert.deepEqual(rows.find(row=>row.event_id===mapClick.id)?.viewport,viewport);
 process.env.RATING_EVIDENCE_ROOT=path.join(temp,'datasets');
 process.env.RATING_EVIDENCE_EXPORT_ENABLED='true';
 const bundle=require('../../modules/ratings/services/ratingResearchBundles').exportBundle({apply:true,secret:'s'.repeat(32)});
 const payload=JSON.parse(fs.readFileSync(path.join(process.env.RATING_EVIDENCE_ROOT,`${bundle.id}.json`),'utf8'));
 assert.deepEqual(payload.events.find(e=>e.event_id===mapClick.id)?.viewport,viewport);
 console.log('Random chain attribution and map click viewport storage and exports passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
