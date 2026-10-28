const {db}=require('../../../infrastructure/database');
const client=require('../../../infrastructure/numericAlgorithmClient');
const {context}=require('./ratingSnapshot');
const {decodeVector}=require('../../preferences/services/vectorCodec');
let cache=null,pending=null;
async function placeMeanVector(now=Date.now()){
    if(cache&&now-cache.at<30*60000)return cache.value;
    if(pending)return pending;
    const generation=epoch;
    pending=(async()=>{for(let attempt=0;attempt<2;attempt++){
        const input=db._raw.transaction(()=>({...context(now),input_revision:db._raw.prepare('SELECT revision FROM AlgorithmVectorClock WHERE id=1').get().revision,vectors:db._raw.prepare('SELECT v.embedding FROM place_vectors v JOIN Place p ON p.id=v.place_id WHERE p.has_vector=1').all().filter(r=>decodeVector(r.embedding)).map(r=>({embedding:r.embedding.toString('base64')}))}))();
        let r=null,accumulator=null;
        for(let offset=0;offset<Math.max(1,input.vectors.length);offset+=200){r=await client.compute('vectormean',{...input,vectors:input.vectors.slice(offset,offset+200),accumulator});accumulator={sum:r.sum,count:r.count};}
        if(generation!==epoch)throw client.failure(409,'stale_mean');
        if(db._raw.prepare('SELECT revision FROM AlgorithmVectorClock WHERE id=1').get().revision!==input.input_revision)continue;
        if(r.count!==input.vectors.length)throw client.failure(502,'invalid_response');
        const b=r.mean?Buffer.from(r.mean,'base64'):null,value=b?Float64Array.from({length:1024},(_,i)=>b.readDoubleLE(i*8)):null;
        cache={at:now,value,id:input.snapshot_id};return value;
    }throw client.failure(409,'stale_mean');})().finally(()=>{pending=null;});return pending;
}
let epoch=0;
function resetMeanVectorCache(){epoch++;cache=null;}
module.exports={placeMeanVector,resetMeanVectorCache};
