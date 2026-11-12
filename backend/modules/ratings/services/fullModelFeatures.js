// P85/P87/P91/P92/P93 numeric feature definitions, with all chain fields removed.
// Values use the research five-star axis internally; product inputs remain four levels.
const DAY=86400000;
const star=y=>1+4*(y-1)/3;
const mean=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:null;
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const norm=x=>Math.sqrt(dot(x,x));
const unit=x=>{const n=norm(x);return x.map(v=>v/Math.max(n,1e-9));};
const cosine=(a,b)=>a&&b&&a.length===b.length?dot(a,b)/Math.max(norm(a)*norm(b),1e-9):null;
const dist=(a,b)=>a&&b?Math.sqrt(a.reduce((s,v,i)=>s+(v-b[i])**2,0)):null;
// Stored embeddings are Float32Array; always return a plain (float64) array so
// differences are not rounded back to float32.
const sub=(a,b)=>Array.from(a,(x,i)=>x-b[i]);
const vmean=(vectors,n)=>vectors.length?Array.from({length:n},(_,i)=>vectors.reduce((s,v)=>s+v[i],0)/vectors.length):null;
function standard(values,spec){if(!values||!spec||values.length!==spec.mean?.length)return null;const excluded=new Set(spec.excluded_indices||[]);return values.map((v,i)=>excluded.has(i)?0:Number.isFinite(v)?(v-spec.mean[i])/(spec.sd?.[i]>0?spec.sd[i]:1):0);}
function project(vector,spec){
 if(!vector||!spec||vector.length!==spec.mean?.length||!Array.isArray(spec.components))return null;
 const centered=sub(vector,spec.mean);return spec.components.map((c,i)=>dot(c,centered)/(spec.sd?.[i]>0?spec.sd[i]:1));
}
function timestamp(r){const t=Number(r.created_at??r.updated_at);return Number.isFinite(t)?t:0;}
function categories(place,profile){return profile?.categories||place.categories||String(place.category||'').split(/[,，|]/).map(x=>x.trim()).filter(Boolean);}
function covisitGraph(ratings){
 const users=new Map();for(const r of ratings){if(!users.has(r.user_id))users.set(r.user_id,[]);users.get(r.user_id).push(r);}
 const diag=new Map(),pairs=new Map();
 for(const rs of users.values()){
  const ids=[...new Set(rs.sort((a,b)=>timestamp(b)-timestamp(a)||b.place_id-a.place_id).slice(0,100).map(r=>r.place_id))],w=1/Math.log2(2+ids.length);
  for(const a of ids){diag.set(a,(diag.get(a)||0)+w);if(!pairs.has(a))pairs.set(a,new Map());for(const b of ids)if(a!==b)pairs.get(a).set(b,(pairs.get(a).get(b)||0)+w);}
 }
 return (a,b)=>(pairs.get(a)?.get(b)||0)/Math.sqrt((diag.get(a)||1)*(diag.get(b)||1));
}
function raterEventFeatures(ratings,mu){
 const rows=ratings.filter(r=>timestamp(r)>0).sort((a,b)=>timestamp(a)-timestamp(b)||a.place_id-b.place_id||String(a.user_id).localeCompare(String(b.user_id))),users=new Map(),shops=new Map(),result=new Map();
 for(let i=0;i<rows.length;){let j=i;while(j<rows.length&&timestamp(rows[j])===timestamp(rows[i]))j++;const updates=[];
  for(let k=i;k<j;k++){const r=rows[k],y=star(r.score),u=users.get(r.user_id)||{sum:0,n:0,dev:0,known:0},s=shops.get(r.place_id)||{sum:0,n:0};
   result.set(r,{bias:u.dev/(u.known+3),known:u.known>0?1:0,residual:y-(u.sum+3*mu)/(u.n+3)});
   updates.push({r,y,dev:s.n>=3?y-s.sum/s.n:null});shops.set(r.place_id,{sum:s.sum+y,n:s.n+1});
  }
  for(const {r,y,dev}of updates){const u=users.get(r.user_id)||{sum:0,n:0,dev:0,known:0};u.sum+=y;u.n++;if(dev!==null){u.dev+=dev;u.known++;}users.set(r.user_id,u);}i=j;
 }return result;
}
function categoryLift(places,profiles,byUser,vocab){
 const index=new Map(vocab.map((v,i)=>[v,i])),C=Array.from({length:vocab.length},()=>new Float64Array(vocab.length)),marg=new Float64Array(vocab.length);let n=0;
 for(const history of byUser.values()){
  if(history.length<2)continue;const counts=new Float64Array(vocab.length);
  for(const r of history)for(const cat of categories(places.get(r.place_id)||{},profiles.get(r.place_id))){const k=index.get(cat);if(k!==undefined)counts[k]++;}
  const total=counts.reduce((a,b)=>a+b,0);if(!total)continue;n++;
  const active=[];counts.forEach((v,i)=>{if(v){const p=v/total;active.push([i,p]);marg[i]+=p;}});
  for(const [i,p]of active)for(const [j,q]of active)C[i][j]+=p*q;
 }
 return C.map((row,i)=>Array.from(row,(v,j)=>i===j?0:Math.max(-3,Math.min(3,Math.log((v+1)/(marg[i]*marg[j]/Math.max(n,1)+1))))));
}
function buildFullFeatures({places,ratings,profiles=new Map(),viewerId=null,asOf=Date.now(),contract={},candidateCount=1,covisit=null}){
 const byId=new Map(places.map(p=>[p.id,p]));ratings=ratings.filter(r=>timestamp(r)<=asOf&&byId.has(r.place_id));
 const byPlace=new Map(),byUser=new Map();for(const r of ratings){if(!byPlace.has(r.place_id))byPlace.set(r.place_id,[]);byPlace.get(r.place_id).push(r);if(!byUser.has(r.user_id))byUser.set(r.user_id,[]);byUser.get(r.user_id).push(r);}
 const ys=ratings.map(r=>star(r.score)),mu=mean(ys)??contract.global_mean??4,gv=ys.length>1?ys.reduce((s,y)=>s+(y-mu)**2,0)/(ys.length-1):0;
 const g5=ys.length?ys.filter(y=>y===5).length/ys.length:0,g2=ys.length?ys.filter(y=>y<=2).length/ys.length:0;
 const vocab=contract.categories||contract.vocab?.categories||[],flags=contract.flags||contract.vocab?.flags||[],catIndex=new Map(vocab.map((s,i)=>[s,i]));
 const active=[...byPlace.keys()],df=new Float64Array(vocab.length);
 const rawCats=new Map(places.map(p=>[p.id,categories(p,profiles.get(p.id))]));
 for(const id of active)for(const c of new Set(rawCats.get(id))){const k=catIndex.get(c);if(k!==undefined)df[k]++;}
 const catVector=id=>{const x=new Array(vocab.length).fill(0);for(const c of rawCats.get(id)||[]){const i=catIndex.get(c);if(i!==undefined)x[i]=Math.log((1+active.length)/(1+df[i]));}return x;};
 const catVectors=new Map(places.map(p=>[p.id,catVector(p.id)])),L=categoryLift(byId,profiles,byUser,vocab),cf=covisit||covisitGraph(ratings);
 const eventFeatures=raterEventFeatures(ratings,mu);
 const price=id=>{const x=profiles.get(id)?.price_level;return Number.isInteger(x)&&x>=1&&x<=4?Math.log(x):null;};
 const style=id=>byId.get(id)?.style||profiles.get(id)?.primary_style||(rawCats.get(id)||[])[0]||null;
 // No city exists for many product markers. Missing city remains missing rather
 // than silently merging unrelated cities into one global category prior.
 const city=id=>byId.get(id)?.city||String(byId.get(id)?.address||'').match(/[^省区县市\s,，]+市/)?.[0]||null;
 const shopMean=id=>{const rs=byPlace.get(id)||[];return(rs.reduce((s,r)=>s+star(r.score),0)+10*mu)/(rs.length+10);};
 const shopSince=id=>{const rs=byPlace.get(id)||[];return rs.length?Math.log1p(Math.max(0,Math.floor((asOf-Math.max(...rs.map(timestamp)))/DAY))):null;};
 const transforms=contract.transforms||{},spaces={ds:new Map(),rv:new Map(),em:new Map(),desc:new Map()};
 const meanImpute=String(contract.missing_profiles||'').includes('mean imputation');
 for(const p of places){const a=profiles.get(p.id);spaces.ds.set(p.id,standard(a?.ds,contract.profiles?.ds)||(meanImpute?new Array(contract.profiles?.ds?.mean?.length||0).fill(0):null));spaces.rv.set(p.id,standard(a?.rv,contract.profiles?.rv)||(meanImpute?new Array(contract.profiles?.rv?.mean?.length||0).fill(0):null));spaces.em.set(p.id,a?.review_projected||project(a?.review_embedding,transforms.review)||(meanImpute?new Array(transforms.review?.components?.length||0).fill(0):null));spaces.desc.set(p.id,a?.description_embedding||null);}
 const centers={};for(const [s,map]of Object.entries(spaces)){const vectors=active.map(id=>map.get(id)).filter(Boolean);centers[s]=vectors.length?vmean(vectors,vectors[0].length):null;}
 const flagMean=flags.map((_,k)=>{const known=places.map(p=>profiles.get(p.id)?.flags?.[k]).filter(v=>v===0||v===1);return mean(known);});
 const allHistory=(byUser.get(viewerId)||[]).slice().sort((a,b)=>timestamp(a)-timestamp(b)||a.place_id-b.place_id);
 const owned=new Set(allHistory.map(r=>r.place_id)),histories=new Map(),preferences=new WeakMap();
 function historyPreference(history){
  let cached=preferences.get(history);if(cached)return cached;
  const U=new Array(vocab.length).fill(0),rawU=new Array(vocab.length).fill(0);
  for(const r of history){const v=catVectors.get(r.place_id);v.forEach((x,k)=>U[k]+=x);for(const cat of rawCats.get(r.place_id)||[]){const k=catIndex.get(cat);if(k!==undefined)rawU[k]++;}}
  const totalCats=rawU.reduce((a,b)=>a+b,0),lift=new Array(vocab.length).fill(0);if(totalCats)for(let i=0;i<vocab.length;i++)if(rawU[i])for(let j=0;j<vocab.length;j++)lift[j]+=rawU[i]/totalCats*L[i][j];
  const hu=flags.map((_,k)=>{const vs=history.map(r=>profiles.get(r.place_id)?.flags?.[k]??flagMean[k]).filter(v=>v!==null);return mean(vs);});
  cached={U,lift,hu};preferences.set(history,cached);return cached;
 }
 function featureFor(placeId,{excludeViewer=false,asOf:featureTime=asOf,scope='all'}={}){
  let history=allHistory;if(owned.has(placeId)){history=histories.get(placeId);if(!history){history=allHistory.filter(r=>r.place_id!==placeId);histories.set(placeId,history);}}
  const target=byId.get(placeId)||{},profile=profiles.get(placeId),votes=(byPlace.get(placeId)||[]).filter(r=>!excludeViewer||r.user_id!==viewerId),recent=history.slice(-50),n=history.length;
  const hidden=excludeViewer?(byPlace.get(placeId)||[]).filter(r=>r.user_id===viewerId):[],hiddenSet=new Set(hidden),safeRatings=hidden.length?ratings.filter(r=>!hiddenSet.has(r)):ratings,localYs=hidden.length?safeRatings.map(r=>star(r.score)):ys;
  const localMu=hidden.length?(mean(localYs)??contract.global_mean??4):mu,localGv=hidden.length?(localYs.length>1?localYs.reduce((sum,y)=>sum+(y-localMu)**2,0)/(localYs.length-1):0):gv;
  const localShopMean=id=>{const rs=(byPlace.get(id)||[]).filter(r=>!hiddenSet.has(r));return(rs.reduce((sum,r)=>sum+star(r.score),0)+10*localMu)/(rs.length+10);};
  const voteValues=votes.map(r=>star(r.score)),nVotes=votes.length;
  const knownVoteTimes=votes.every(r=>timestamp(r)>0);
  const f={p_logn:Math.log1p(nVotes),p_mean:nVotes?(voteValues.reduce((a,b)=>a+b,0)+10*localMu)/(nVotes+10):null,p_since:votes.length&&knownVoteTimes?Math.log1p(Math.max(0,Math.floor((featureTime-Math.max(...votes.map(timestamp)))/DAY))):null,p_flavor:nVotes?0:null,p_env:nVotes?0:null,p_service:nVotes?0:null,p_cellsize:Math.log1p(candidateCount),p_cost:price(placeId),p_cost_n:price(placeId)===null?0:1};
  for(const d of [30,90,365])f['p_n'+d]=knownVoteTimes?Math.log1p(votes.filter(r=>timestamp(r)>featureTime-d*DAY).length):null;
  const c=city(placeId),s=style(placeId),cityReviews=nVotes&&c&&s?safeRatings.filter(r=>timestamp(r)>featureTime-365*DAY&&city(r.place_id)===c):[],styleReviews=cityReviews.filter(r=>style(r.place_id)===s);
  f.p_style_share=nVotes&&c&&s?styleReviews.length/Math.max(cityReviews.length,1):null;f.p_style_mean=nVotes&&c&&s?(styleReviews.reduce((sum,r)=>sum+star(r.score),0)+10*localMu)/(styleReviews.length+10):null;
  const av=profile?.flags;flags.forEach((_,k)=>f['a_f'+String(k).padStart(2,'0')]=av?.[k]??null);
  // Public/personal rating and risk trees do not consume choice-only preference,
  // co-visit or multi-interest columns. Keep their identical scalar calculation.
  if(scope!=='estimate'){
  const styleHistory=s?history.filter(r=>style(r.place_id)===s):[];
  f.u_style_share=n&&f.p_style_share!==null?(styleHistory.length+5*f.p_style_share)/(n+5):null;
  f.u_style_lift=f.u_style_share!==null?Math.log((f.u_style_share+1e-4)/(f.p_style_share+1e-4)):null;
  f.u_style_count=n?Math.log1p(styleHistory.length):null;f.u_style_resid=n?styleHistory.reduce((sum,r)=>sum+star(r.score)-localShopMean(r.place_id),0)/(styleHistory.length+5):null;f.u_logn=Math.log1p(n);
  const hp=history.map(r=>price(r.place_id)).filter(v=>v!==null),hm=history.map(r=>localShopMean(r.place_id)),hpop=history.map(r=>Math.log1p((byPlace.get(r.place_id)||[]).length));
  f.u_price_mean=mean(hp);f.u_price_gap=f.p_cost!==null&&hp.length?f.p_cost-f.u_price_mean:null;f.u_price_absgap=f.u_price_gap===null?null:Math.abs(f.u_price_gap);
  f.u_mean_gap=n&&f.p_mean!==null?f.p_mean-mean(hm):null;f.u_pop_gap2=n?f.p_logn-mean(hpop):null;
  const styleCounts=new Map();for(const r of history){const k=style(r.place_id);styleCounts.set(k,(styleCounts.get(k)||0)+1);}f.u_style_entropy=n?-[...styleCounts.values()].reduce((sum,k)=>sum+(k/n)*Math.log(k/n),0):null;
  const Cv=catVectors.get(placeId)||[],{U,lift,hu}=historyPreference(history);
  f.u_cat_cos=n?dot(unit(Cv),unit(U)):null;f.u_cat_n=Math.log1p(n);
  const wanted=(rawCats.get(placeId)||[]).map(x=>catIndex.get(x)).filter(x=>x!==undefined);f.u_cat_lift=n&&wanted.length?mean(wanted.map(k=>lift[k])):null;f.u_cat_lift_max=n&&wanted.length?Math.max(...wanted.map(k=>lift[k])):null;
  if(av&&hu.every(x=>x!==null)&&flagMean.every(x=>x!==null)){const ac=av.map((v,k)=>v??flagMean[k]);f.u_attr_cos=n?cosine(sub(ac,flagMean),sub(hu,flagMean)):null;f.u_attr_dist=n?dist(ac,hu):null;}else{f.u_attr_cos=null;f.u_attr_dist=null;}
  const co=recent.map(r=>cf(r.place_id,placeId));f.cf_sum=co.reduce((a,b)=>a+b,0);f.cf_max=co.length?Math.max(...co):0;f.cf_mean=mean(co)??0;f.cf_nz=co.length?co.filter(x=>x>0).length/co.length:0;f.cf_recent=co.slice(-10).reduce((a,b)=>a+b,0);
  }
  const cp=profile?.description_projected||project(profile?.description_embedding,transforms.description);for(let k=0;k<8;k++)f['d_pc'+k]=cp?.[k]??null;
  if(scope!=='estimate'){
  for(const [space,prefix,width]of [['ds','dsp',contract.profiles?.ds?.mean?.length||0],['rv','rvp',contract.profiles?.rv?.mean?.length||0],['em','em',transforms.review?.components?.length||0]]){
   const map=spaces[space],candidate=map.get(placeId),vectors=recent.map(r=>map.get(r.place_id)).filter(Boolean),u=vmean(vectors,width),center=centers[space];
   const excluded=new Set(contract.profiles?.[space]?.excluded_indices||[]);
   for(let k=0;k<width;k++){if(excluded.has(k))continue;f[prefix+String(k).padStart(2,'0')]=candidate?.[k]??null;if(space!=='em')f[space+'g'+String(k).padStart(2,'0')]=candidate&&u?candidate[k]-u[k]:null;}
   const a=candidate&&center?sub(candidate,center):null,b=u&&center?sub(u,center):null;f[space+'_cos']=cosine(a,b);f[space+'_dist']=candidate&&u?dist(candidate,u):null;
   const sims=recent.map(r=>{const v=map.get(r.place_id);return v&&candidate&&center?{r,sim:cosine(unit(sub(candidate,center)),unit(sub(v,center)))}:null;}).filter(Boolean);
   f[space+'_mi_max']=sims.length?Math.max(...sims.map(x=>x.sim)):null;f[space+'_mi_top3']=mean(sims.map(x=>x.sim).sort((a,b)=>b-a).slice(0,3));f[space+'_mi_recent']=mean(sims.slice(-10).map(x=>x.sim));f[space+'_mi_like']=sims.some(x=>star(x.r.score)>=4)?Math.max(...sims.filter(x=>star(x.r.score)>=4).map(x=>x.sim)):null;
   if(space==='rv')for(const [label,mask]of [['like',r=>star(r.score)>=4],['dislike',r=>star(r.score)<=2]]){const v=vmean(recent.filter(mask).map(r=>map.get(r.place_id)).filter(Boolean),width);f['rv_cos_'+label]=a&&v&&center?cosine(a,sub(v,center)):null;}
  }
  const desc=profile?.description_embedding,dv=recent.map(r=>spaces.desc.get(r.place_id)).filter(Boolean),du=dv.length?unit(dv.reduce((sum,v)=>sum.map((x,k)=>x+v[k]),new Array(dv[0].length).fill(0))):null;
  f.u_desc_cos=desc&&du?cosine(desc,du):null;f.u_desc_max=desc&&dv.length?Math.max(...dv.map(v=>cosine(desc,v))):null;
  }
  const hy=history.map(r=>star(r.score)),um=mean(hy),res=history.map(r=>star(r.score)-localShopMean(r.place_id));f.l_len=res.reduce((a,b)=>a+b,0)/(n+5);f.l_sd=Math.sqrt((hy.reduce((sum,y)=>sum+(y-(um??localMu))**2,0)+5*localGv)/(n-1+5));f.l_hi=(hy.filter(y=>y===5).length+5*(hidden.length?(localYs.length?localYs.filter(y=>y===5).length/localYs.length:0):g5))/(n+5);f.l_lo=(hy.filter(y=>y<=2).length+5*(hidden.length?(localYs.length?localYs.filter(y=>y<=2).length/localYs.length:0):g2))/(n+5);f.l_logn=Math.log1p(n);
  const riskN=votes.length>=5?5:votes.length>=3?3:votes.length?1:0,early=votes.slice().sort((a,b)=>timestamp(a)-timestamp(b)||String(a.user_id).localeCompare(String(b.user_id))).slice(0,riskN),ey=early.map(r=>star(r.score));
  f.n=riskN;for(let k=1;k<=5;k++)f['c'+k]=ey.reduce((sum,y)=>sum+Math.max(0,1-Math.abs(y-k)),0);
  f.mean=mean(ey);f.min=ey.length?Math.min(...ey):null;f.span=early.length&&early.every(r=>timestamp(r)>0)?Math.log1p((Math.max(...early.map(timestamp))-Math.min(...early.map(timestamp)))/DAY):null;
  f.style_prior=contract.risk_style_prior?.[s]??contract.risk_global_prior??null;
  const eb=early.map(r=>eventFeatures.get(r)||{bias:0,known:0,residual:star(r.score)-localMu}),bias=eb.map(x=>x.bias),adjusted=ey.map((y,k)=>y-bias[k]),rr=eb.map(x=>x.residual);
  f.r_res_mean=mean(rr);f.r_res_min=rr.length?Math.min(...rr):null;f.b_mean=mean(bias);f.b_max=bias.length?Math.max(...bias):null;f.b_adj_mean=mean(adjusted);f.b_adj_min=adjusted.length?Math.min(...adjusted):null;f.b_share_high=bias.length?bias.filter(x=>x>.3).length/bias.length:null;f.b_known=eb.length?mean(eb.map(x=>x.known)):null;
  const riskPC=profile?.risk_description_projected||project(profile?.description_embedding,transforms.risk_description);for(let k=0;k<8;k++)f['dsc'+k]=riskPC?.[k]??null;
  f.has_desc=String(target.description||'').trim()?1:0;f.price=profile?.price_level??null;f.attr_n=Number.isSafeInteger(target.attribute_count)&&target.attribute_count>=0?Math.log1p(target.attribute_count):null;
  // Every field absent from this product's data stays missing. Never supply a
  // chain identity or manufacture a textual review from an imported vote.
  for(const key of Object.keys(f))if(!Number.isFinite(f[key]))f[key]=null;
  return f;
 }
 return {featureFor,global_mean:mu};
}
module.exports={buildFullFeatures,covisitGraph,project,standard,star,raterEventFeatures};
