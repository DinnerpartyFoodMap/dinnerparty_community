const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-product-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
for(const name of ['RATING_ESTIMATE_MODE','RATING_PREDICTION_MODE','RATING_LIST_RANK_MODE','RATING_RANDOM_RANK_MODE'])delete process.env[name];
const {db,init}=require('../../infrastructure/database');
const client=require('../../infrastructure/numericAlgorithmClient'),adapter=require('../../modules/ratings/services/ratingEstimateAdapter');
let server;
async function main(){
 if(!process.env.JOURNEY_PRIVATE_SERVICE_DIR){console.log('Bootstrap HTTP integration skipped: private service is unset.');return;}
 server=require(path.resolve(process.env.JOURNEY_PRIVATE_SERVICE_DIR,'src/server.js')).createServer({env:{JOURNEY_ALGORITHM_SERVICE_TOKEN:'bootstrap-product'}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.NUMERIC_ALGORITHM_SERVICE_URL=`http://127.0.0.1:${server.address().port}`;process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN='bootstrap-product';
 const model=await adapter.configuration();if(!model){console.log('Bootstrap product integration skipped: pack unavailable.');return;}
 init();for(const id of ['reviewer','viewer'])db._raw.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
 const {appendRatingRevision}=require('../../modules/ratings/services/ratingHistory'),now=Date.now();
 for(let id=1;id<=6;id++){
  db._raw.prepare("INSERT INTO Place(id,name,category,latitude,longitude,creator_id,moderation_status) VALUES(?,?,'Chinese restaurant',23,113,'reviewer','visible')").run(id,'place'+id);
  db._raw.prepare("INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at) VALUES(?,'reviewer',4,'user',?,?)").run(id,now,now);
  appendRatingRevision({userId:'reviewer',placeId:id,before:null,after:{score:4},action:'rate',origin:'active'});
 }
 const views=await adapter.ratingViews([1,2],'viewer');
 assert.equal(views.estimates[0].active,true);assert.equal(views.estimates[0].risk.active,true);assert.equal(views.estimates[0].risk.status,'ready');
 const context=require('../../modules/ratings/services/ratingSnapshot').context();
 const candidates=Array.from({length:6},(_,n)=>({place_id:n+1,predicted_rating:3}));
 const actual=await adapter.rankCandidates(candidates,'viewer',context,{config:model});
 assert.equal(actual.ranked.filter(r=>r.choice_boost>0).length,5,'exactly five candidates get configured choice bonuses');
 assert.ok(actual.ranked.every(r=>Number.isFinite(r.choice_score)&&r.ranking_score===3+r.choice_boost));
 await assert.rejects(client.compute('listrank',{...context,config_version:model.config_version,model_hash:'0'.repeat(64),candidates,bonuses_by_choice_rank:[]}),e=>e.status===409,'hash mismatch cannot mix models');
 const compute=client.compute;let rankCalls=0;
 client.compute=async(op,input,...options)=>{
  if(op!=='listrank')return compute(op,input,...options);
  rankCalls++;assert.equal(input.candidates.length,6,'first page ranks full filtered candidate set');
  return {config_version:input.config_version,model_hash:input.model_hash,ranked:input.candidates.map(c=>({place_id:c.place_id,ranking_score:c.predicted_rating+c.place_id/100,choice_boost:c.place_id/100})).sort((a,b)=>b.ranking_score-a.ranking_score)};
 };
 try{
  const {listPlaces}=require('../../modules/places/services/placeList');
  const first=await listPlaces({limit:2},'viewer');
  assert.deepEqual(first.items.map(p=>p.id),[6,5],'product uses replacement order');
  const next=await listPlaces({limit:2,offset:2,snapshot:first.snapshot},'viewer');
  assert.deepEqual(next.items.map(p=>p.id),[4,3]);assert.equal(rankCalls,1,'pagination reuses one full ranking');
  assert.equal(first.items[0].rating_estimate.average,first.items[1].rating_estimate.average,'ranking bonuses never change displayed rating');
  assert.equal(first.items[0].rating_risk.active,true);
 }finally{client.compute=compute;}
 const random=require('../../modules/discovery/services/randomRecommendation');
 const pool=candidates.map(c=>({place:{id:c.place_id},weight:c.place_id,distanceKm:1}));
 const personalize=await random.prepareChoicePersonalizer(db._raw,pool,'viewer');
 assert.equal(typeof personalize,'function');const remaining=pool.slice(2),selection=personalize(remaining);
 const total=selection.candidates.reduce((sum,c)=>sum+c.weight,0),base=remaining.reduce((sum,c)=>sum+c.weight,0);
 for(let n=0;n<remaining.length;n++)assert.ok(selection.candidates[n].weight/total+1e-12>=0.2*remaining[n].weight/base,'20% exploration remains after cooldown');
 assert.equal(selection.algorithm,'research-choice-mixture-v1');assert.equal(selection.model_version.model_hash,model.model.model_hash);
 assert.equal(Object.keys(selection.feature_snapshot).length,4);
 for(const [id,score] of [[7,1],[8,2]]){
  db._raw.prepare("INSERT INTO Place(id,name,category,creator_id,moderation_status) VALUES(?,?,'Chinese restaurant','viewer','visible')").run(id,'solo'+id);
  db._raw.prepare("INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at) VALUES(?,'viewer',?,'user',?,?)").run(id,score,now,now);
  appendRatingRevision({userId:'viewer',placeId:id,before:null,after:{score},action:'rate',origin:'active'});
 }
 const calibrated=await adapter.ratingViews([1,7],'viewer');
 assert.equal(calibrated.predictions.find(r=>r.place_id===1).history_count,2,'solo historical ratings calibrate against the independent learned prior');
 assert.equal(calibrated.predictions.find(r=>r.place_id===1).status,'ready');
 assert.equal(calibrated.predictions.find(r=>r.place_id===7).history_count,1,'own target score is excluded from bias calibration');
 assert.equal(calibrated.predictions.find(r=>r.place_id===7).status,'insufficient','own target rating cannot supply public target evidence');
 const independent=(await adapter.ratingViews([7],null)).estimates[0].prior_average;
 assert.ok(Number.isFinite(independent));
 const saved=await require('../../modules/ratings/services/ratingBusiness').ratePlace({id:'viewer'},1,3,{requestId:'bootstrap_rating_save',confirm:true});
 assert.equal(saved.estimate.active,true,'save response keeps the active score in the open panel');assert.equal(saved.risk.active,true);assert.equal(saved.prediction.active,true);
 assert.equal(saved.prediction.history_count,2,'saved target review does not enter its own bias history');
 const rankCandidates=adapter.rankCandidates;
 adapter.rankCandidates=async(...args)=>{
  const scored=await rankCandidates(...args);
  db._raw.prepare("UPDATE Place SET moderation_status='rejected' WHERE id=1").run();
  db._raw.prepare('UPDATE AlgorithmClock SET revision=revision+1 WHERE id=1').run();
  return scored;
 };
 try{await assert.rejects(random.prepareChoicePersonalizer(db._raw,pool,'viewer'),e=>e.status===409,'a hidden place after inference cannot be selected from stale candidates');}finally{adapter.rankCandidates=rankCandidates;}
 const capabilities=client.capabilities;client.capabilities=async()=>null;
 try{assert.equal((await adapter.ratingViews([1],'viewer')).estimates.length,0,'unavailable pack falls back to established display');}finally{client.capabilities=capabilities;}
 process.env.RATING_ESTIMATE_MODE='off';process.env.RATING_PREDICTION_MODE='off';assert.equal((await adapter.ratingViews([1],'viewer')).estimates.length,0);
 console.log('Bootstrap product HTTP passed: default activation, independent risk, pinned models, full-list ranking/pagination, unchanged display, random exploration/features and rollback.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
