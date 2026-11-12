// A slow real HTTP profile response must outlive the search timeout; an encoder
// failure must not discard paid LLM output or repeat a successful description.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'profile-retry-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
let server,db,logger,originalWarn;
async function main(){
 let generated=0,descriptions=0,reviews=0;const warnings=[];
 server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const payload=JSON.parse(raw);
  if(req.url==='/v1/chat/completions'){
   generated++;setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({ds:[7],rv:[4],categories:['Restaurant'],flags:[null],price_level:2})}}]}));}},80);return;
  }
  const review=payload.input[0].startsWith('This synthetic review');if(review)reviews++;else descriptions++;
  if(review&&reviews===1){res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'SECRET credential and private review must never appear in profile warnings'}}));return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:payload.model,data:payload.input.map((_,index)=>({index,embedding:[1,...new Array(1023).fill(0)]}))}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 Object.assign(process.env,{DEEPSEEK_BASE_URL:url,DEEPSEEK_API_KEY:'test-key',SILICONFLOW_BASE_URL:url,SILICONFLOW_API_KEY:'test-key',EMBEDDING_MODEL:'Qwen/Qwen3-Embedding-4B',DEEPSEEK_EXPANSION_TIMEOUT_MS:'25'});
 const database=require('../../infrastructure/database');db=database.db;database.init();
 const ai=require('../../infrastructure/aiClients'),profiles=require('../../modules/ratings/services/modelProfiles'),emb=require('../../modules/ratings/services/modelEmbeddings');
 logger=require('../../infrastructure/logger');originalWarn=logger.warn;logger.warn=(message,fields)=>warnings.push({message,fields});
 await assert.rejects(ai.completeDeepseekJson({system:'synthetic',user:'synthetic'}),e=>e.code==='upstream_timeout'&&e.timeoutMs===25);
 const sql=db._raw;sql.prepare("INSERT INTO User(id,username,password) VALUES('owner','owner','unused')").run();
 sql.prepare("INSERT INTO Place(id,name,category,description,creator_id,moderation_status) VALUES(1,'Synthetic shop','其他','Noodles','owner','visible')").run();
 sql.prepare("INSERT INTO Comment(place_id,user_id,content) VALUES(1,'owner','This synthetic review describes fresh noodles and friendly service.')").run();
 const spec={model:emb.MODEL,revision:emb.RECIPE,dimensions:1024,transport:'backend-embedding-api',pooling:'provider-l2-f32',max_characters:12000};
 const transform={mean:new Array(1024).fill(0),components:[[1,...new Array(1023).fill(0)]],sd:[1]};
 const contract={profiles:{ds:{properties:['quality']},rv:{properties:['spicy']}},categories:['Restaurant'],flags:['Family'],encoders:{description:spec,review:spec},transforms:{description:transform,review:transform,risk_description:transform}},model={model_hash:'a'.repeat(64)};
 assert.equal(await profiles.processProfiles(model,contract,{now:1000,limit:1}),1);
 const initialGenerationCount=generated;assert.ok(generated>=1,'profile response survives 80ms despite the independent 25ms search deadline');
 const first=sql.prepare('SELECT * FROM PlaceModelProfile').get();assert.equal(first.status,'ready');assert.equal(first.attempts,1);assert.equal(first.retry_at,121000);
 const assets=JSON.parse(first.assets);assert.equal(assets.ds[0],7);assert.ok(!('description_embedding' in assets)&&!('review_embedding' in assets),'vectors are stored outside the JSON');
 assert.equal(first.description_embedding.length,4096);assert.equal(first.description_embedding.readFloatLE(0),1);assert.equal(first.review_embedding,null);
 assert.equal(warnings.length,1);assert.equal(warnings[0].fields.stage,'review_embedding');assert.equal(warnings[0].fields.code,'upstream_http_error');assert.equal(warnings[0].fields.http_status,429);
 assert.match(warnings[0].message,/stage=review_embedding.*http_status=429/);
 assert.ok(!JSON.stringify(warnings).includes('SECRET')&&!JSON.stringify(warnings).includes('This synthetic review'),'never log provider text, credentials or review content');
 assert.equal(await profiles.processProfiles(model,contract,{now:120000,limit:1}),0,'backoff is honored');
 assert.equal(await profiles.processProfiles(model,contract,{now:121001,limit:1}),1);
 assert.equal(generated,initialGenerationCount,'encoder retry reuses validated LLM output');assert.equal(descriptions,1,'successful description is reused');assert.equal(reviews,2);
 const ready=profiles.readProfiles([{id:1}],model).get(1);assert.equal(ready.review_projected[0],1);
 assert.equal(sql.prepare('SELECT attempts FROM PlaceModelProfile').get().attempts,0);
 assert.equal(sql.prepare('SELECT count(*) AS n FROM PlaceRating').get().n,0,'no votes are synthesized');
 const revision=sql.prepare('SELECT revision FROM AlgorithmClock').get().revision;
 const failingModel={model_hash:'b'.repeat(64)},fail=async()=>{throw Object.assign(new Error('SECRET'),{code:'upstream_timeout',timeoutMs:60000});};
 for(let k=0;k<2;k++)await assert.rejects(profiles.syncProfile(1,failingModel,contract,{complete:fail}),/SECRET/);
 assert.equal(sql.prepare('SELECT revision FROM AlgorithmClock').get().revision,revision,'failed inserts and retry bookkeeping do not invalidate global map/list score caches');
 sql.prepare('UPDATE PlaceModelProfile SET attempts=attempts+1,retry_at=retry_at+1000 WHERE model_hash=?').run(model.model_hash);
 assert.equal(sql.prepare('SELECT revision FROM AlgorithmClock').get().revision,revision,'ready-profile retry metadata does not invalidate scores');
 sql.prepare("UPDATE PlaceModelProfile SET assets=json_set(assets,'$.ds[0]',8) WHERE model_hash=?").run(model.model_hash);
 assert.ok(sql.prepare('SELECT revision FROM AlgorithmClock').get().revision>revision,'actual model input changes still invalidate scores');
 console.log('Profile HTTP retry passed: independent deadline, safe stage/status logs, partial cache, backoff and no repeated LLM/description calls.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(logger)logger.warn=originalWarn;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(db)db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
