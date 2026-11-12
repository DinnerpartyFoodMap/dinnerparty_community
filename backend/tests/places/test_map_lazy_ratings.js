const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'map-lazy-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',MAP_EAGER_RATING_LIMIT:'2'});
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database');let server;
async function main(){
 init();db._raw.prepare("INSERT INTO User(id,username,password) VALUES('owner','owner','unused')").run();
 for(let id=1;id<=3;id++){
  db._raw.prepare("INSERT INTO Place(id,name,category,latitude,longitude,creator_id,moderation_status) VALUES(?,?,'其他',23,?,'owner','visible')").run(id,'synthetic'+id,113+id*.01);
  require('../../modules/ratings/services/placeRatings').insertCreationRating(id,'owner',4,Date.now(),'creation_default');
 }
 const adapter=require('../../modules/ratings/services/ratingEstimateAdapter');let projected=[];
 adapter.ratingViews=async ids=>{projected.push(ids);return {estimates:ids.map(place_id=>({place_id,active:true,average:3.5,evidence_count:1})),predictions:[]};};
 const express=require('express'),app=express();app.use(express.json());app.use('/places',require('../../modules/places/routes/places'));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
 const get=async url=>{const r=await fetch(base+url);assert.equal(r.status,200);return r.json();};
 const many=await get('/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24');
 assert.equal(many.length,3);assert.equal(projected.length,0,'dense marker fetch never calls the model projection');
 assert.ok(many.every(p=>p.rating_count===1&&p.rating_average===4&&p.rating_estimate===null),'legacy/default aggregate votes remain available for every marker');
 const few=await get('/places/nearby?minLng=113&maxLng=113.025&minLat=22&maxLat=24');assert.equal(few.length,2);assert.equal(projected.length,1);assert.equal(few[0].rating_estimate.average,3.5);
 const detail=await get('/places/1');assert.equal(detail.rating_estimate.average,3.5);assert.deepEqual(projected.at(-1),[1],'selected-place details still load model scores');
 process.env.MAP_EAGER_RATING_LIMIT='0';const all=await get('/places');assert.equal(all.length,3);assert.equal(projected.length,2);
 await get('/places/1');assert.equal(projected.length,3,'zero map limit does not defer detail scores');
 process.env.MAP_EAGER_RATING_LIMIT='2';
 const scoped=await get('/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24&viewMinLng=113&viewMaxLng=113.025&viewMinLat=22&viewMaxLat=24');
 assert.equal(scoped.length,3,'prefetch still includes offscreen markers');
 assert.deepEqual([...projected.at(-1)].sort(),[1,2],'only actual visible markers count toward the eager limit');
 assert.equal(scoped.find(p=>p.id===3).rating_deferred,true);
 assert.equal(scoped.find(p=>p.id===1).rating_deferred,false);
 assert.equal(scoped.find(p=>p.id===1).rating_estimate.average,3.5);
 for(const query of ['viewMinLng=113','viewMinLng=114&viewMaxLng=113&viewMinLat=22&viewMaxLat=24','viewMinLng=120&viewMaxLng=121&viewMinLat=22&viewMaxLat=24','viewMinLng=x&viewMaxLng=114&viewMinLat=22&viewMaxLat=24'])assert.equal((await fetch(base+'/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24&'+query)).status,400);
 // 旧版前端缩得很小时视野经度超出 ±180、请求范围已截到 ±180：视野截到请求范围内，不再 400
 const wrapped=await get('/places/nearby?minLng=-180&maxLng=180&minLat=-85.0511&maxLat=85.0511&viewMinLng=-26.13&viewMaxLng=256.69&viewMinLat=-38.27&viewMaxLat=71.55');
 assert.equal(wrapped.length,3);assert.ok(wrapped.every(p=>p.rating_deferred===true),'wrapped world view counts all three markers as visible');
 const clipped=await get('/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24&viewMinLng=113.015&viewMaxLng=115&viewMinLat=22&viewMaxLat=24');
 assert.deepEqual(clipped.filter(p=>p.rating_deferred===false).map(p=>p.id).sort(),[2,3],'view clipped to the query box still scopes eager ratings');
 // 屏蔽创建者后，批量复核把 Ta 的地点全部滤掉
 db._raw.prepare("INSERT INTO User(id,username,password) VALUES('viewer','viewer','unused')").run();
 const viewerToken=require('jsonwebtoken').sign({id:'viewer'},process.env.JWT_SECRET||'yuyuko_secret_key');
 const before=await (await fetch(base+'/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24',{headers:{Authorization:'Bearer '+viewerToken}})).json();
 assert.equal(before.length,3);
 require('../../modules/accounts/services/userRelations').setBlocked('viewer','owner',true);
 const after=await (await fetch(base+'/places/nearby?minLng=113&maxLng=114&minLat=22&maxLat=24',{headers:{Authorization:'Bearer '+viewerToken}})).json();
 assert.equal(after.length,0,'blocked creator places are removed');
 require('../../modules/accounts/services/userRelations').setBlocked('viewer','owner',false);
 const token=require('jsonwebtoken').sign({id:'owner'},process.env.JWT_SECRET||'yuyuko_secret_key');
 const response=await fetch(base+'/places/nearby?minLng=113&maxLng=113.025&minLat=22&maxLat=24',{headers:{Authorization:'Bearer '+token}});
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.ok((await response.json()).every(p=>p.rating_viewer_id==='owner'),'preloaded scores carry their authenticated owner');
 console.log('Map lazy scoring passed: dense/sparse threshold, default rating retention, zero threshold and selected detail projection.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
