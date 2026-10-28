const {randomUUID}=require('node:crypto');
const OPERATIONS=new Set(['preference','vectormean','ratingweights','ratingweightspage','ratingsummary','ratingview','personalaverages','ratingsort','evidence']);
const MAX_INPUT=32*1024*1024,MAX_OUTPUT=1024*1024;
function failure(status=503,code='unavailable') {return Object.assign(new Error(status===409?'数据已变化，请重试':'计算服务暂不可用，请稍后重试'),{status,publicMessage:status===409?'数据已变化，请重试':'计算服务暂不可用，请稍后重试',code});}
function configuration(){
    try{const raw=String(process.env.NUMERIC_ALGORITHM_SERVICE_URL||process.env.JOURNEY_ALGORITHM_SERVICE_URL||'').trim(),token=String(process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN||process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN||'');const u=new URL(raw);
        if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!token||token.length>4096||/[\s\x00-\x1f\x7f]/.test(token))throw Error();
        return {url:u.href.replace(/\/+$/,''),token};}catch{return null;}
}
function invalid(){throw failure(502,'invalid_response');}
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function vector(value,width=4){
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))invalid();
    const b=Buffer.from(value,'base64');if(b.length!==1024*width)invalid();
    for(let p=0;p<b.length;p+=width)if(!Number.isFinite(width===4?b.readFloatLE(p):b.readDoubleLE(p)))invalid();
    return b;
}
function validatePreference(r,i){
    if(!r||!['empty','pending','unavailable','ready'].includes(r.status)||r.dimensions!==1024||r.algorithm_version!==2||typeof r.model!=='string'||!integer(r.source_place_count)||!integer(r.vector_place_count)||r.vector_place_count>r.source_place_count||!Number.isFinite(r.total_weight)||r.total_weight<0||!integer(r.updated_at))invalid();
    if(i&&(r.updated_at!==i.as_of_ms||r.input_revision!==i.input_revision||r.model!==i.model))invalid();
    if(r.status==='empty'&&(r.source_place_count!==0||r.vector_place_count!==0||r.total_weight!==0))invalid();
    if(r.status!=='empty'&&r.source_place_count===0)invalid();
    if(r.vector_place_count===0&&r.total_weight!==0||r.vector_place_count>0&&r.total_weight<=0)invalid();
    if(r.status==='unavailable'&&r.vector_place_count!==0)invalid();
    if(r.status==='ready'){const b=vector(r.vector_b64);let sq=0;for(let p=0;p<b.length;p+=4)sq+=b.readFloatLE(p)**2;if(Math.abs(Math.sqrt(sq)-1)>1e-5||!r.vector_place_count)invalid();}else if(r.vector_b64!==null)invalid();
}
function validateSummary(r){
    if(!r||!integer(r.count)||!r.distribution||![1,2,3,4].every(k=>integer(r.distribution[k]))||[1,2,3,4].reduce((n,k)=>n+r.distribution[k],0)!==r.count)invalid();
    if(r.count===0){if(r.average!==null||r.tier!==null)invalid();}else if(!Number.isFinite(r.average)||r.average<1||r.average>4||![1,2,3,4].includes(r.tier))invalid();
}
function unique(rows,key,allowed){if(!Array.isArray(rows))invalid();const ids=rows.map(key);if(new Set(ids).size!==ids.length||allowed&&ids.some(id=>!allowed.has(id)))invalid();return ids;}
function validate(op,r,i={}){
    if(!r||typeof r!=='object')invalid();
    if(op==='preference')validatePreference(r,i);
    if(op==='vectormean'){if(!integer(r.count))invalid();vector(r.sum,8);if(r.count)vector(r.mean,8);else if(r.mean!==null)invalid();}
    if(op==='ratingsummary'){const allowed=i.place_ids?new Set(i.place_ids):null;const ids=unique(r.summaries,x=>x.place_id,allowed);if(allowed&&ids.length!==allowed.size)invalid();r.summaries.forEach(validateSummary);}
    if(op==='ratingview'){
        validateSummary(r.summary);
        if(r.personalized!==null&&(!r.personalized||!Number.isFinite(r.personalized.average)||r.personalized.average<1||r.personalized.average>4||![1,2,3,4].includes(r.personalized.tier)||!integer(r.personalized.matched_raters)||r.personalized.matched_raters<1||!integer(r.personalized.rater_count)||r.personalized.rater_count<2||r.personalized.matched_raters>r.personalized.rater_count))invalid();
        if(r.viewer_preference){if(!i.viewer_input)invalid();validatePreference(r.viewer_preference,i.viewer_input);}
        if(i.viewer_input&&!r.viewer_preference)invalid();
    }
    if(op==='ratingweights'||op==='ratingweightspage'){
        const users=i.users?new Set(i.users.filter(x=>!x.is_banned).map(x=>x.id)):null;
        const ids=unique(r.reputations,x=>x.user_id,users);if(users&&!r.ticket&&ids.length!==users.size)invalid();
        for(const row of r.reputations)for(const key of ['beta','gamma','weight','contribution','evidence','agreement','rating_count'])if(!Number.isFinite(row[key])||row[key]<0)invalid();
        for(const row of r.reputations)if(!(row.beta>0)||!(row.gamma>0)||!(row.weight>0)||!integer(row.rating_count))invalid();
        const keys=i.ratings?new Set(i.ratings.map(x=>`${x.place_id}|${x.user_id}`)):null;
        const weights=unique(r.rating_weights,x=>`${x.place_id}|${x.user_id}`,keys);if(keys&&!r.ticket&&weights.length!==keys.size)invalid();for(const row of r.rating_weights)if(!(row.weight>0)||!Number.isFinite(row.weight))invalid();
        if(r.ticket&&(typeof r.ticket!=='string'||!integer(r.reputation_count)||!integer(r.rating_count)||r.next&&(!integer(r.next.user_offset)||!integer(r.next.rating_offset))))invalid();
    }
    if(op==='personalaverages'){unique(r.averages,x=>x.place_id,new Set((i.ratings||[]).map(x=>x.place_id)));for(const p of r.averages)if(!Number.isFinite(p.average)||p.average<1||p.average>4)invalid();}
    if(op==='ratingsort'){const allowed=new Set((i.places||[]).map(x=>x.id));if(unique(r.ranked,x=>x.place_id,allowed).length!==allowed.size)invalid();for(const row of r.ranked)if(!Number.isFinite(row.score)||row.score<1||row.score>4)invalid();}
    if(op==='evidence'&&![r.accepted,r.excluded,r.deduplicated].every(integer))invalid();
    return r;
}
async function compute(operation,input,{signal,requestId=randomUUID(),timeoutMs=10000}={}){
    if(!OPERATIONS.has(operation))throw failure(400,'invalid_input');const config=configuration();if(!config)throw failure();
    const context={contract_version:1,dataset_id:process.env.ALGORITHM_DATASET_ID||'primary',snapshot_id:randomUUID(),input_revision:0,as_of_ms:Date.now(),purpose:'operation',...input};
    const body=JSON.stringify({request_id:requestId,input:context});if(Buffer.byteLength(body)>(operation==='ratingweights'?128*1024*1024:MAX_INPUT))throw failure(413,'payload_too_large');
    const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)throw failure(503,'aborted');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeoutMs);
    try{
        const response=await fetch(`${config.url}/v1/compute/${operation}`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json',Accept:'application/json'},body});
        if(!/^application\/json\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>MAX_OUTPUT){await response.body?.cancel();invalid();}
        const reader=response.body?.getReader();if(!reader)invalid();const parts=[];let length=0;
        try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_OUTPUT){await reader.cancel();invalid();}parts.push(Buffer.from(value));}}finally{reader.releaseLock();}
        let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{invalid();}
        if(!response.ok)throw failure(response.status===409?409:response.status===429?429:503,data.error?.code||'unavailable');
        if(data.protocol_version!==1||!data.result)invalid();const result=data.result;
        for(const key of ['contract_version','dataset_id','snapshot_id','input_revision','as_of_ms'])if(result[key]!==context[key])invalid();
        return validate(operation,result,context);
    }catch(error){if(error.publicMessage)throw error;throw failure(503,controller.signal.aborted?'timeout':'unavailable');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function computeRatingWeights(input,options={}){
    const context={contract_version:1,dataset_id:process.env.ALGORITHM_DATASET_ID||'primary',snapshot_id:randomUUID(),input_revision:0,as_of_ms:Date.now(),...input};
    const first=await compute('ratingweights',context,options);if(!first.ticket)return first;
    const users=new Set(context.users.filter(x=>!x.is_banned).map(x=>x.id));if(first.reputation_count!==users.size||first.rating_count!==context.ratings.length)invalid();
    const result={...first,reputations:[...first.reputations],rating_weights:[...first.rating_weights]};let cursor=first.next,steps=0;
    while(cursor){if(++steps>100)invalid();const next=await compute('ratingweightspage',{...context,users:undefined,ratings:undefined,places:undefined,profiles:undefined,favorites:undefined,requests:undefined,ticket:first.ticket,...cursor},options);
        if(next.ticket!==first.ticket||next.reputation_count!==first.reputation_count||next.rating_count!==first.rating_count)invalid();
        result.reputations.push(...next.reputations);result.rating_weights.push(...next.rating_weights);if(next.next&&next.next.user_offset<=cursor.user_offset&&next.next.rating_offset<=cursor.rating_offset)invalid();cursor=next.next;
    }
    delete result.ticket;delete result.next;return validate('ratingweights',result,context);
}
module.exports={compute,computeRatingWeights,configuration,validate,failure};
