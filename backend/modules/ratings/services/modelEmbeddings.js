const {randomUUID}=require('node:crypto');
function configuration(){
 try{const url=new URL(process.env.MODEL_FEATURE_EMBEDDING_URL||'');const token=process.env.MODEL_FEATURE_EMBEDDING_TOKEN||'';if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!token||/[\s\x00-\x1f]/.test(token))return null;return {url:url.href.replace(/\/+$/,''),token};}catch{return null;}
}
async function encodeTexts(texts,spec,{fetchImpl=fetch,config=configuration()}={}){
 if(!config)return null;
 if(!spec||typeof spec.model!=='string'||typeof spec.revision!=='string'||!Number.isSafeInteger(spec.max_length)||spec.max_length<1||spec.max_length>512)throw Error('Invalid feature encoder contract');
 const output=[];
 for(let start=0;start<texts.length;start+=16){
  const batch=texts.slice(start,start+16);if(batch.some(t=>typeof t!=='string'||!t.trim()||t.length>12000))throw Error('Invalid feature embedding input');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
  try{const response=await fetchImpl(config.url,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),texts:batch,encoder_id:spec.model,revision:spec.revision,max_length:spec.max_length})});
   if(!response.ok||!/^application\/json\b/i.test(response.headers.get('content-type')||''))throw Error('Feature embedding service unavailable');
   const reader=response.body.getReader(),chunks=[];let bytes=0;try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024){await reader.cancel();throw Error('Feature embedding response too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
   const answer=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(answer.encoder_id!==spec.model||answer.revision!==spec.revision||answer.max_length!==spec.max_length||answer.pooling!==spec.pooling||answer.dimensions!==spec.dimensions||!Array.isArray(answer.vectors)||answer.vectors.length!==batch.length||answer.vectors.some(v=>!Array.isArray(v)||v.length!==spec.dimensions||v.some(x=>!Number.isFinite(x))))throw Error('Mismatched feature encoder response');
   output.push(...answer.vectors);
  }finally{clearTimeout(timer);}
 }
 return output;
}
async function encodeProfile(kind,input,spec,assets,options){
 const {place,reviews}=input;
 let texts;
 if(kind==='description'){
  const price=assets.price_level===null?'unknown':'$'.repeat(assets.price_level);
  texts=[`${place.name||''}. Categories: ${(assets.categories||[]).join(', ')}. Price: ${price}. ${place.description||''}`.trim()];
 }else if(kind==='review')texts=reviews.map(r=>r.content.trim()).filter(t=>t.length>=20);
 else throw Error('Unknown feature embedding kind');
 if(!texts.length)return null;
 const vectors=await encodeTexts(texts,spec,options);if(!vectors)return null;
 // Research review features average per-review normalized encodings; they do
 // not re-encode concatenated reviews or substitute the unrelated map vector.
 return vectors[0].map((_,k)=>vectors.reduce((sum,v)=>sum+v[k],0)/vectors.length);
}
module.exports={configuration,encodeTexts,encodeProfile};
