const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'personal-recommendation-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',RATING_ESTIMATE_MODE:'off',RATING_PREDICTION_MODE:'off',RATING_LIST_RANK_MODE:'active',RATING_RANDOM_RANK_MODE:'active'});
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database'),sql=db._raw;
const migration=require('../../modules/ratings/services/ratingEstimateAdapter');
const original={configuration:migration.configuration,rankCandidates:migration.rankCandidates};
let server;
async function main(){
 init();for(const id of ['viewer','peer1','peer2'])sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'x');
 const rate=sql.prepare("INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at) VALUES(?,?,?,'migration',0,0)");
 for(let id=1;id<=10;id++){
  sql.prepare("INSERT INTO Place(id,name,creator_id,latitude,longitude,moderation_status) VALUES(?,?,'peer1',30,120,'visible')").run(id,'店'+id);
  rate.run(id,'peer1',4);rate.run(id,'peer2',4);
 }
 rate.run(1,'viewer',1);rate.run(2,'viewer',2);rate.run(3,'viewer',4);
 migration.configuration=async()=>({model:{model_id:'guard-test'}});
 const rankedInputs=[];let race=null;
 migration.rankCandidates=async candidates=>{
  rankedInputs.push(candidates.map(c=>({...c})));
  race?.();
  return {model:{model_id:'guard-test'},feature_snapshot:Object.fromEntries(candidates.map(c=>[c.place_id,{}])),ranked:candidates.map((c,n)=>({place_id:c.place_id,ranking_score:c.predicted_rating+0.3,choice_boost:0.3,choice_score:100-c.place_id}))};
 };
 const list=require('../../modules/places/services/placeList'),random=require('../../modules/discovery/services/randomRecommendation');
 const mine=await list.listPlaces({limit:30},'viewer');
 assert.deepEqual(mine.items.slice(-2).map(p=>p.id),[2,1],'explicit low ratings follow all other places');
 assert.ok(rankedInputs.at(-1).every(c=>![1,2].includes(c.place_id)),'low-rated places cannot get or consume a first-choice bonus');
 assert.equal(rankedInputs.at(-1).find(c=>c.place_id===3).predicted_rating,4,'an existing actual rating precedes a model prediction');
 assert.equal(mine.items.find(p=>p.id===1).rating_mine.score,1);
 assert.equal(mine.items.find(p=>p.id===1).rating_viewer_id,'viewer');
 const guest=await list.listPlaces({limit:30});assert.ok(rankedInputs.at(-1).some(c=>c.place_id===1));assert.ok(guest.items.every(p=>p.rating_mine===null));
 assert.equal((await list.listPlaces({limit:30},'peer1')).items.find(p=>p.id===1).rating_mine.score,4,'ratings are isolated between accounts');
 const pool=await random.nearbyCandidates(sql,{lat:30,lng:120},'viewer');
 assert.ok(pool.every(c=>![1,2].includes(c.place.id)),'personal negatives are excluded even when the crowd is positive');
 assert.ok((await random.nearbyCandidates(sql,{lat:30,lng:120})).some(c=>c.place.id===1),'a personal dislike does not remove a place for guests');
 sql.prepare("UPDATE PlaceRating SET score=4 WHERE place_id=1 AND user_id='viewer'").run();
 assert.ok((await random.nearbyCandidates(sql,{lat:30,lng:120},'viewer')).some(c=>c.place.id===1),'changing to a positive rating restores eligibility');
 sql.prepare("DELETE FROM PlaceRating WHERE place_id=1 AND user_id='viewer'").run();
 assert.equal((await list.listPlaces({},'viewer')).items.find(p=>p.id===1).rating_mine,null,'withdrawal removes cached own-rating display');

 const bump=()=>sql.prepare('UPDATE AlgorithmClock SET revision=revision+1 WHERE id=1').run();
 let changes=0;race=()=>{if(changes++===0)bump();};rankedInputs.length=0;
 const recovered=await random.prepareNearbyRecommendation(sql,{lat:30,lng:120},'viewer');
 assert.equal(rankedInputs.length,2,'a background input update triggers one complete pool/ranking retry');
 assert.ok(random.drawRecommendation(recovered.candidates,[],()=>0,recovered.personalize).place);
 changes=0;rankedInputs.length=0;race=()=>{if(changes++===0){sql.prepare("UPDATE Place SET moderation_status='rejected' WHERE id=3").run();sql.prepare("UPDATE Place SET category='避雷' WHERE id=4").run();}};
 const sourceChanged=await random.prepareNearbyRecommendation(sql,{lat:30,lng:120},'viewer');
 assert.equal(rankedInputs.length,2);assert.ok(sourceChanged.candidates.every(c=>![2,3,4].includes(c.place.id)),'retry rebuilds the pool, removing personal negatives, hidden and newly avoided places');
 race=bump;rankedInputs.length=0;
 await assert.rejects(random.prepareNearbyRecommendation(sql,{lat:30,lng:120},'viewer'),e=>e.status===409&&e.code==='RANDOM_INPUT_CHANGED');
 assert.equal(rankedInputs.length,3,'persistent churn has a bounded server retry');

 const express=require('express'),app=express();app.use(express.json());
 app.use('/api/community',require('../../modules/community/routes/community'));
 app.use('/places',require('../../modules/places/routes/places'));
 app.use(require('../../http/middleware/requestLogger').errorHandler);
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const token=require('jsonwebtoken').sign({id:'viewer'},process.env.JWT_SECRET||'yuyuko_secret_key'),base=`http://127.0.0.1:${server.address().port}`;
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const payload={draw_id:'guard_draw_identifier',recommendation_session_id:'guard_recommendation_session',center:{lat:30,lng:120},exclude_ids:[],consent_version:0};
 const call=()=>fetch(base+'/api/community/draw',{method:'POST',headers,body:JSON.stringify(payload)});
 let response=await call();assert.equal(response.status,409);assert.equal((await response.json()).code,'RANDOM_INPUT_CHANGED');
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM MapDecision').get().n,0,'failed inference creates no partial draw');
 changes=0;race=()=>{if(changes++===0)bump();};
 response=await call();assert.equal(response.status,200);const saved=await response.json();
 assert.ok(![2,3,4].includes(saved.place.id));assert.equal(saved.decision_id,payload.draw_id);
 assert.deepEqual(await (await call()).json(),saved,'retry of a committed draw retains the same selection and identity');
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM MapDecision').get().n,1);
 const map=await (await fetch(base+'/places/nearby?minLng=119&maxLng=121&minLat=29&maxLat=31',{headers})).json();
 assert.equal(map.find(p=>p.id===2).rating_mine.score,2,'map preloads actual own ratings before the detail request');
 const anonymous=await (await fetch(base+'/places/nearby?minLng=119&maxLng=121&minLat=29&maxLat=31')).json();
 assert.ok(anonymous.every(p=>p.rating_mine===null));
 console.log('Personal recommendation guards passed: actual vote display, account isolation, negative ranking/random constraints, source-refresh retries and draw idempotency.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 Object.assign(migration,original);if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 require('../../modules/preferences/services/userPreferenceService').startUserVectorWorker()();sql.close();fs.rmSync(temp,{recursive:true,force:true});
});
