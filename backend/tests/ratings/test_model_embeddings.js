const assert=require('node:assert/strict');
const {MODEL,RECIPE,encodeTexts,encodeProfile}=require('../../modules/ratings/services/modelEmbeddings');
async function main(){
 const spec={model:MODEL,revision:RECIPE,dimensions:1024,transport:'backend-embedding-api',pooling:'provider-l2-f32',max_characters:12000};
 const config={model:MODEL,dimensions:1024};let calls=[];
 const vector=(a,b)=>[a,b,...new Array(1022).fill(0)];
 const createEmbeddings=async(texts,options)=>{calls.push({texts,options});return texts.map(()=>vector(3,4));};
 const result=await encodeTexts(['text'],spec,{createEmbeddings,config});
 assert.deepEqual(result[0],vector(Math.fround(.6),Math.fround(.8)));
 assert.deepEqual(calls[0].options,{expectedModel:MODEL,requireModel:true});
 assert.equal(await encodeTexts(['text'],spec,{config:null}),null);
 for(const change of [{model:'Qwen/Qwen3-Embedding-0.6B'},{revision:'wrong'},{dimensions:256},{pooling:'last-token-left-padding-l2-f16'},{transport:'private-worker'}])
  await assert.rejects(encodeTexts(['text'],{...spec,...change},{createEmbeddings,config}),/Incompatible/);
 await assert.rejects(encodeTexts(['text'],spec,{createEmbeddings,config:{model:'wrong',dimensions:1024}}),/Configured/);
 await assert.rejects(encodeTexts(['text'],spec,{config,createEmbeddings:async()=>[vector(0,0)]}),/Zero/);
 await assert.rejects(encodeTexts(['text'],spec,{config,createEmbeddings:async()=>[[NaN]]}),/Malformed/);
 await assert.rejects(encodeTexts(['text'],spec,{config,createEmbeddings:async()=>[]}),/count/);
 calls=[];await encodeTexts(new Array(33).fill('t'.repeat(12010)),spec,{createEmbeddings,config});
 assert.deepEqual(calls.map(c=>c.texts.length),[16,16,1]);assert.equal(calls[0].texts[0].length,12000);
 calls=[];await encodeTexts(['😀'.repeat(12001)],spec,{createEmbeddings,config});
 assert.equal(Array.from(calls[0].texts[0]).length,12000,'match Python code-point limits without splitting surrogate pairs');
 const input={place:{name:'店',description:'描述'},reviews:[{content:'第一条足够长的真实评论文字，描述具体菜品和味道。'},{content:'第二条足够长的真实评论文字，描述服务和消费体验。'}]};
 const assets={categories:['Chinese restaurant'],price_level:2};calls=[];
 await encodeProfile('description',input,spec,assets,{createEmbeddings,config});
 assert.equal(calls[0].texts[0],'店. Categories: Chinese restaurant. Price: $$. 描述');
 const review=await encodeProfile('review',input,spec,assets,{config,createEmbeddings:async(texts)=>{assert.equal(texts.length,2);return [vector(1,0),vector(0,1)];}});
 assert.deepEqual(review,vector(.5,.5),'normalize per review then average; do not normalize the mean');
 calls=[];await encodeProfile('review',{...input,reviews:[{content:'😀'.repeat(301)}]},spec,assets,{createEmbeddings,config});
 assert.equal(Array.from(calls[0].texts[0]).length,300);
 console.log('Shared 4B feature embeddings passed: model contract, batching, float32 normalization, templates and per-review mean.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
