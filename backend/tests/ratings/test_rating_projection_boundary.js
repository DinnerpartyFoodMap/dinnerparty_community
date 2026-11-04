const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rating-projection-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');init();
const adapter=require('../../modules/ratings/services/ratingEstimateAdapter'),summary=require('../../modules/ratings/services/ratingSummaryAdapter'),snapshot=require('../../modules/ratings/services/ratingSnapshot');
summary.ratingsReadMiddleware=(req,res,next)=>next();
summary.ratingSummarySnapshot=async()=>({input_revision:snapshot.revision(),summary:{count:0,average:null}});
let server;
async function main(){
 db._raw.prepare("INSERT INTO User(id,username,password) VALUES('owner','owner','unused')").run();
 db._raw.prepare("INSERT INTO Place(id,name,creator_id,moderation_status) VALUES(1,'place','owner','visible')").run();
 const views={estimates:[{place_id:1,average:3,active:false}],predictions:[]};
 adapter.ratingViews=async()=>views;
 const business=require('../../modules/ratings/services/ratingBusiness');
 const state=await business.ratingState(1);
 assert.deepEqual(state.estimate,views.estimates[0]);assert.equal(state.prediction,null);
 adapter.ratingViews=async()=>{db._raw.prepare("UPDATE Place SET moderation_status='rejected' WHERE id=1").run();return views;};
 await assert.rejects(business.ratingState(1),e=>e.status===404,'rating state rechecks visibility after awaiting projection');
 require('../../modules/accounts/middleware/auth').attachViewer=(req,res,next)=>{req.viewer=req.headers['x-test-viewer']?{id:'reader'}:null;next();};
 const express=require('express'),app=express();app.use('/places',require('../../modules/places/routes/places'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 for(const endpoint of ['/places/','/places/nearby?minLng=-180&maxLng=180&minLat=-90&maxLat=90','/places/1']){
  db._raw.prepare("UPDATE Place SET moderation_status='visible',latitude=1,longitude=1 WHERE id=1").run();
  const res=await fetch(base+endpoint),body=await res.json();
  if(endpoint==='/places/1')assert.equal(res.status,404);else assert.deepEqual(body,[],endpoint+' excludes a place hidden during the awaited projection');
 }
 db._raw.prepare("INSERT INTO User(id,username,password) VALUES('reader','reader','unused')").run();
 adapter.ratingViews=async()=>{db._raw.prepare("INSERT OR IGNORE INTO UserBlock(user_id,blocked_id) VALUES('reader','owner')").run();return views;};
 for(const endpoint of ['/places/','/places/nearby?minLng=-180&maxLng=180&minLat=-90&maxLat=90','/places/1']){
  db._raw.prepare("UPDATE Place SET moderation_status='visible' WHERE id=1").run();db._raw.prepare('DELETE FROM UserBlock').run();
  const res=await fetch(base+endpoint,{headers:{'x-test-viewer':'reader'}}),body=await res.json();
  if(endpoint==='/places/1')assert.equal(res.status,404);else assert.deepEqual(body,[],endpoint+' rechecks blocks after projection');
 }
 console.log('Rating projection contract and visibility boundary passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
