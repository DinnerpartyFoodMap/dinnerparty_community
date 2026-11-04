const assert=require('node:assert/strict');
const {encodeTexts,encodeProfile}=require('../../modules/ratings/services/modelEmbeddings');
async function main(){
 const spec={model:'frozen-test-encoder',revision:'revision',dimensions:2,max_length:128,pooling:'last-token-left-padding-l2-f16'},config={url:'http://private.test/v1/embeddings',token:'private-token'};
 let calls=0,bodies=[];const fetchImpl=async(_url,options)=>{calls++;bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({encoder_id:spec.model,revision:spec.revision,max_length:128,pooling:spec.pooling,dimensions:2,vectors:JSON.parse(options.body).texts.map(()=>[.25,.5])}),{headers:{'Content-Type':'application/json'}});};
 assert.deepEqual(await encodeTexts(['text'],spec,{fetchImpl,config}),[[.25,.5]]);
 assert.equal(calls,1);assert.equal(bodies[0].encoder_id,spec.model);
 assert.equal(await encodeTexts(['text'],spec,{config:null}),null,'no unrelated embedding fallback');
 const bad=async()=>new Response(JSON.stringify({encoder_id:spec.model,revision:spec.revision,max_length:256,pooling:spec.pooling,dimensions:2,vectors:[[.25,.5]]}),{headers:{'Content-Type':'application/json'}});
 await assert.rejects(encodeTexts(['text'],spec,{fetchImpl:bad,config}),/Mismatched/);
 const wrongPooling=async()=>new Response(JSON.stringify({encoder_id:spec.model,revision:spec.revision,max_length:128,pooling:'mean-pooling',dimensions:2,vectors:[[.25,.5]]}),{headers:{'Content-Type':'application/json'}});
 await assert.rejects(encodeTexts(['text'],spec,{fetchImpl:wrongPooling,config}),/Mismatched/);
 const input={place:{name:'店',description:'描述'},reviews:[{content:'第一条足够长的真实评论文字，描述具体菜品和味道。'},{content:'第二条足够长的真实评论文字，描述服务和消费体验。'}]};
 assert.deepEqual(await encodeProfile('review',input,spec,{categories:[],price_level:null},{fetchImpl,config}),[.25,.5]);assert.equal(bodies.at(-1).texts.length,2,'per-review encode then mean, not concatenation');
 console.log('Model embedding transport passed: exact encoder/revision/tokenization/pooling, missing service and per-review averaging.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
