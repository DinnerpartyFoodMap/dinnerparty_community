const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rating-migration-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',RATING_ESTIMATE_MODE:'shadow',RATING_PREDICTION_MODE:'shadow'});
const {db,init}=require('../../infrastructure/database');
let server;
async function main(){
 if(!process.env.JOURNEY_PRIVATE_SERVICE_DIR){console.log('Migration HTTP integration skipped: JOURNEY_PRIVATE_SERVICE_DIR is unset.');return;}
 server=require(path.resolve(process.env.JOURNEY_PRIVATE_SERVICE_DIR,'src/server.js')).createServer({env:{JOURNEY_ALGORITHM_SERVICE_TOKEN:'migration-test'}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.NUMERIC_ALGORITHM_SERVICE_URL=`http://127.0.0.1:${server.address().port}`;process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN='migration-test';
 init(); for(const id of ['a','b'])db._raw.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
 for(const id of [1,2])db._raw.prepare("INSERT INTO Place(id,name,creator_id,moderation_status) VALUES(?,?,?,'visible')").run(id,'place'+id,'a');
 const {appendRatingRevision}=require('../../modules/ratings/services/ratingHistory');
 for(const [place_id,user_id,score] of [[1,'a',4],[2,'b',2]]){
 db._raw.prepare("INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at,weight) VALUES(?,?,?,'user',?,?,1)").run(place_id,user_id,score,Date.now(),Date.now());
 appendRatingRevision({userId:user_id,placeId:place_id,before:null,after:{score},action:'rate',origin:'active'});
 }
 const adapter=require('../../modules/ratings/services/ratingEstimateAdapter');
 const r=await adapter.ratingViews([1,2],'a');
 assert.equal(r.estimates.length,2);assert.equal(r.estimates[0].evidence_count,1);
 assert.equal(r.estimates[0].active,false);assert.equal(r.predictions.length,2);
 assert.equal(r.predictions.find(x=>x.place_id===1).history_count,0,'own target rating excluded');
 const model=await adapter.configuration();
 const ownTarget=r.predictions.find(x=>x.place_id===1);
 assert.equal(ownTarget.status,'insufficient','own target vote cannot create target evidence');
 if(model){assert.ok(Number.isFinite(ownTarget.average),'internal learned prior may seed an unrated target');assert.equal(r.estimates[0].prior_version,model.config_version);assert.equal(r.estimates[0].risk.active,false);}
 else{assert.equal(ownTarget.average,null);assert.equal(r.estimates.find(x=>x.place_id===1).average,2.875);}
 process.env.RATING_ESTIMATE_MODE='active';process.env.RATING_PREDICTION_MODE='active';
 const active=await adapter.ratingViews([1],'a');
 assert.equal(active.estimates.length,model?1:0,'activation requires a valid frozen model pack');
 if(model){assert.equal(active.estimates[0].active,true);assert.equal(active.estimates[0].risk.active,true);assert.equal(active.predictions[0].active,true);}
 process.env.RATING_ESTIMATE_MODE='off';process.env.RATING_PREDICTION_MODE='off';
 assert.equal((await adapter.ratingViews([1],'a')).estimates.length,0);
 console.log('Migration adapter HTTP tests passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
