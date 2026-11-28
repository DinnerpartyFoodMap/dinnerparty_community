// P85/P87/P91/P92/P93 numeric feature definitions, with all chain fields removed.
// Values use the research five-star axis internally; product inputs remain four levels.
const {stripChainTag}=require('../../places/services/chainTagText');
const DAY=86400000;
const star=y=>1+4*(y-1)/3;
const mean=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:null;
// Vector helpers are plain loops that add in the same left-to-right order as the
// reduce/map forms they replaced, so every feature value stays bit-identical.
function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}
const norm=x=>Math.sqrt(dot(x,x));
const unit=x=>{const n=Math.max(norm(x),1e-9);return x.map(v=>v/n);};
const cosine=(a,b)=>a&&b&&a.length===b.length?dot(a,b)/Math.max(norm(a)*norm(b),1e-9):null;
function dist(a,b){if(!a||!b)return null;let s=0;for(let i=0;i<a.length;i++)s+=(a[i]-b[i])**2;return Math.sqrt(s);}
// Stored embeddings are Float32Array; differences and means are float64 so they
// are not rounded back to float32.
function sub(a,b){const out=new Float64Array(a.length);for(let i=0;i<a.length;i++)out[i]=a[i]-b[i];return out;}
function vmean(vectors,n){if(!vectors.length)return null;const out=new Float64Array(n);for(const v of vectors)for(let i=0;i<n;i++)out[i]+=v[i];for(let i=0;i<n;i++)out[i]/=vectors.length;return out;}
function standard(values,spec){if(!values||!spec||values.length!==spec.mean?.length)return null;const excluded=new Set(spec.excluded_indices||[]);return values.map((v,i)=>excluded.has(i)?0:Number.isFinite(v)?(v-spec.mean[i])/(spec.sd?.[i]>0?spec.sd[i]:1):0);}
function project(vector,spec){
 if(!vector||!spec||vector.length!==spec.mean?.length||!Array.isArray(spec.components))return null;
 const centered=sub(vector,spec.mean);return spec.components.map((c,i)=>dot(c,centered)/(spec.sd?.[i]>0?spec.sd[i]:1));
}
function timestamp(r){const t=Number(r.created_at??r.updated_at);return Number.isFinite(t)?t:0;}
function categories(place,profile){return profile?.categories||place.categories||stripChainTag(place.category).split(/[,，|]/).map(x=>x.trim()).filter(Boolean);}
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
 const cities=new Map(),city=id=>{if(cities.has(id))return cities.get(id);const c=byId.get(id)?.city||String(byId.get(id)?.address||'').match(/[^省区县市\s,，]+市/)?.[0]||null;cities.set(id,c);return c;};
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
  const flagRows=history.map(r=>profiles.get(r.place_id)?.flags);
  const hu=flags.map((_,k)=>{let sum=0,count=0;for(const row of flagRows){const v=row?.[k]??flagMean[k];if(v!==null){sum+=v;count++;}}return count?sum/count:null;});
  cached={U,lift,hu};preferences.set(history,cached);return cached;
 }
 // Everything below is shared by all candidates of this builder. Each cached
 // value is the expression featureFor used to evaluate again for every place;
 // the order of additions is unchanged, so the features are bit-identical.
 const norms=new WeakMap(),normOf=v=>{let n=norms.get(v);if(n===undefined){n=norm(v);norms.set(v,n);}return n;};
 const cosineOf=(a,b)=>a&&b&&a.length===b.length?dot(a,b)/Math.max(normOf(a)*normOf(b),1e-9):null;
 const shopMeans=new Map(),shopMeanOf=id=>{let m=shopMeans.get(id);if(m===undefined){m=shopMean(id);shopMeans.set(id,m);}return m;};
 const vectorSpaces=[['ds','dsp',contract.profiles?.ds?.mean?.length||0],['rv','rvp',contract.profiles?.rv?.mean?.length||0],['em','em',transforms.review?.components?.length||0]]
  .map(([space,prefix,width])=>({space,prefix,width,excluded:new Set(contract.profiles?.[space]?.excluded_indices||[]),centered:new Map(),units:new Map()}));
 // sub(vector,center) and unit(sub(vector,center)) of one place in one space.
 const centeredOf=(spec,id)=>{let c=spec.centered.get(id);if(!c){c=sub(spaces[spec.space].get(id),centers[spec.space]);spec.centered.set(id,c);}return c;};
 const unitOf=(spec,id)=>{let u=spec.units.get(id);if(!u){u=unit(centeredOf(spec,id));spec.units.set(id,u);}return u;};
 // Same-city / same-style review counts; only used when no viewer vote is hidden.
 const cityGroups=new Map();
 function cityStyleReviews(c,s,featureTime){
  const key=JSON.stringify([featureTime,c]);let group=cityGroups.get(key);
  if(!group){group={reviews:ratings.filter(r=>timestamp(r)>featureTime-365*DAY&&city(r.place_id)===c),styles:new Map()};cityGroups.set(key,group);}
  let counts=group.styles.get(s);
  if(!counts){const styleReviews=group.reviews.filter(r=>style(r.place_id)===s);counts={city:group.reviews.length,style:styleReviews.length,sum:styleReviews.reduce((sum,r)=>sum+star(r.score),0)};group.styles.set(s,counts);}
  return counts;
 }
 // Scalars of one history; shop means assume no hidden viewer vote.
 const historyScalars=new WeakMap();
 function scalarsOf(history){
  let state=historyScalars.get(history);if(state)return state;
  const n=history.length,styles=new Map(),styleCounts=new Map();
  for(const r of history){const k=style(r.place_id);if(!styles.has(k))styles.set(k,[]);styles.get(k).push(r);styleCounts.set(k,(styleCounts.get(k)||0)+1);}
  const hp=history.map(r=>price(r.place_id)).filter(v=>v!==null),hpop=history.map(r=>Math.log1p((byPlace.get(r.place_id)||[]).length));
  const hy=history.map(r=>star(r.score)),um=mean(hy);
  state={styles,priceMean:mean(hp),priceCount:hp.length,popMean:mean(hpop),shopMeanAvg:mean(history.map(r=>shopMeanOf(r.place_id))),
   entropy:n?-[...styleCounts.values()].reduce((sum,k)=>sum+(k/n)*Math.log(k/n),0):null,
   resSum:history.map(r=>star(r.score)-shopMeanOf(r.place_id)).reduce((a,b)=>a+b,0),squares:hy.reduce((sum,y)=>sum+(y-um)**2,0),
   high:hy.filter(y=>y===5).length,low:hy.filter(y=>y<=2).length};
  historyScalars.set(history,state);return state;
 }
 // Embedding inputs of one history's 50 most recent places.
 const historyVectors=new WeakMap();
 function vectorsOf(history){
  let state=historyVectors.get(history);if(state)return state;
  const recent=history.slice(-50);
  const spacesState=vectorSpaces.map(spec=>{
   const map=spaces[spec.space],center=centers[spec.space],members=recent.filter(r=>map.get(r.place_id)),u=vmean(members.map(r=>map.get(r.place_id)),spec.width);
   const groups=spec.space==='rv'?[['like',r=>star(r.score)>=4],['dislike',r=>star(r.score)<=2]].map(([label,mask])=>{const v=vmean(recent.filter(mask).map(r=>map.get(r.place_id)).filter(Boolean),spec.width);return {label,centered:v&&center?sub(v,center):null};}):[];
   return {members,u,centered:u&&center?sub(u,center):null,groups};
  });
  const dv=recent.map(r=>spaces.desc.get(r.place_id)).filter(Boolean);let du=null;
  if(dv.length){const total=new Float64Array(dv[0].length);for(const v of dv)for(let k=0;k<total.length;k++)total[k]+=v[k];du=unit(total);}
  state={spaces:spacesState,dv,du};historyVectors.set(history,state);return state;
 }
 function featureFor(placeId,{excludeViewer=false,asOf:featureTime=asOf,scope='all'}={}){
  let history=allHistory;if(owned.has(placeId)){history=histories.get(placeId);if(!history){history=allHistory.filter(r=>r.place_id!==placeId);histories.set(placeId,history);}}
  const target=byId.get(placeId)||{},profile=profiles.get(placeId),votes=(byPlace.get(placeId)||[]).filter(r=>!excludeViewer||r.user_id!==viewerId),recent=history.slice(-50),n=history.length;
  const hidden=excludeViewer?(byPlace.get(placeId)||[]).filter(r=>r.user_id===viewerId):[],hiddenSet=new Set(hidden),safeRatings=hidden.length?ratings.filter(r=>!hiddenSet.has(r)):ratings,localYs=hidden.length?safeRatings.map(r=>star(r.score)):ys;
  const localMu=hidden.length?(mean(localYs)??contract.global_mean??4):mu,localGv=hidden.length?(localYs.length>1?localYs.reduce((sum,y)=>sum+(y-localMu)**2,0)/(localYs.length-1):0):gv;
  const localShopMean=hidden.length?id=>{const rs=(byPlace.get(id)||[]).filter(r=>!hiddenSet.has(r));return(rs.reduce((sum,r)=>sum+star(r.score),0)+10*localMu)/(rs.length+10);}:shopMeanOf;
  const hs=scalarsOf(history);
  const voteValues=votes.map(r=>star(r.score)),nVotes=votes.length;
  const knownVoteTimes=votes.every(r=>timestamp(r)>0);
  const f={p_logn:Math.log1p(nVotes),p_mean:nVotes?(voteValues.reduce((a,b)=>a+b,0)+10*localMu)/(nVotes+10):null,p_since:votes.length&&knownVoteTimes?Math.log1p(Math.max(0,Math.floor((featureTime-Math.max(...votes.map(timestamp)))/DAY))):null,p_flavor:nVotes?0:null,p_env:nVotes?0:null,p_service:nVotes?0:null,p_cellsize:Math.log1p(candidateCount),p_cost:price(placeId),p_cost_n:price(placeId)===null?0:1};
  for(const d of [30,90,365])f['p_n'+d]=knownVoteTimes?Math.log1p(votes.filter(r=>timestamp(r)>featureTime-d*DAY).length):null;
  const c=city(placeId),s=style(placeId),grouped=!!(nVotes&&c&&s);
  let reviews={city:0,style:0,sum:0};
  if(grouped&&hidden.length){const cityReviews=safeRatings.filter(r=>timestamp(r)>featureTime-365*DAY&&city(r.place_id)===c),styleReviews=cityReviews.filter(r=>style(r.place_id)===s);reviews={city:cityReviews.length,style:styleReviews.length,sum:styleReviews.reduce((sum,r)=>sum+star(r.score),0)};}
  else if(grouped)reviews=cityStyleReviews(c,s,featureTime);
  f.p_style_share=grouped?reviews.style/Math.max(reviews.city,1):null;f.p_style_mean=grouped?(reviews.sum+10*localMu)/(reviews.style+10):null;
  const av=profile?.flags;flags.forEach((_,k)=>f['a_f'+String(k).padStart(2,'0')]=av?.[k]??null);
  // Public/personal rating and risk trees do not consume choice-only preference,
  // co-visit or multi-interest columns. Keep their identical scalar calculation.
  if(scope!=='estimate'){
  const styleHistory=s?hs.styles.get(s)||[]:[];
  f.u_style_share=n&&f.p_style_share!==null?(styleHistory.length+5*f.p_style_share)/(n+5):null;
  f.u_style_lift=f.u_style_share!==null?Math.log((f.u_style_share+1e-4)/(f.p_style_share+1e-4)):null;
  f.u_style_count=n?Math.log1p(styleHistory.length):null;f.u_style_resid=n?styleHistory.reduce((sum,r)=>sum+star(r.score)-localShopMean(r.place_id),0)/(styleHistory.length+5):null;f.u_logn=Math.log1p(n);
  f.u_price_mean=hs.priceMean;f.u_price_gap=f.p_cost!==null&&hs.priceCount?f.p_cost-f.u_price_mean:null;f.u_price_absgap=f.u_price_gap===null?null:Math.abs(f.u_price_gap);
  f.u_mean_gap=n&&f.p_mean!==null?f.p_mean-(hidden.length?mean(history.map(r=>localShopMean(r.place_id))):hs.shopMeanAvg):null;f.u_pop_gap2=n?f.p_logn-hs.popMean:null;
  f.u_style_entropy=hs.entropy;
  const Cv=catVectors.get(placeId)||[],{U,lift,hu}=historyPreference(history);
  f.u_cat_cos=n?dot(unit(Cv),unit(U)):null;f.u_cat_n=Math.log1p(n);
  const wanted=(rawCats.get(placeId)||[]).map(x=>catIndex.get(x)).filter(x=>x!==undefined);f.u_cat_lift=n&&wanted.length?mean(wanted.map(k=>lift[k])):null;f.u_cat_lift_max=n&&wanted.length?Math.max(...wanted.map(k=>lift[k])):null;
  if(av&&hu.every(x=>x!==null)&&flagMean.every(x=>x!==null)){const ac=av.map((v,k)=>v??flagMean[k]);f.u_attr_cos=n?cosine(sub(ac,flagMean),sub(hu,flagMean)):null;f.u_attr_dist=n?dist(ac,hu):null;}else{f.u_attr_cos=null;f.u_attr_dist=null;}
  const co=recent.map(r=>cf(r.place_id,placeId));f.cf_sum=co.reduce((a,b)=>a+b,0);f.cf_max=co.length?Math.max(...co):0;f.cf_mean=mean(co)??0;f.cf_nz=co.length?co.filter(x=>x>0).length/co.length:0;f.cf_recent=co.slice(-10).reduce((a,b)=>a+b,0);
  }
  const cp=profile?.description_projected||project(profile?.description_embedding,transforms.description);for(let k=0;k<8;k++)f['d_pc'+k]=cp?.[k]??null;
  if(scope!=='estimate'){
  const hv=vectorsOf(history);
  vectorSpaces.forEach((spec,index)=>{
   const {space,prefix,width,excluded}=spec,candidate=spaces[space].get(placeId),center=centers[space],{members,u,centered:b,groups}=hv.spaces[index];
   for(let k=0;k<width;k++){if(excluded.has(k))continue;f[prefix+String(k).padStart(2,'0')]=candidate?.[k]??null;if(space!=='em')f[space+'g'+String(k).padStart(2,'0')]=candidate&&u?candidate[k]-u[k]:null;}
   const a=candidate&&center?centeredOf(spec,placeId):null;f[space+'_cos']=cosineOf(a,b);f[space+'_dist']=candidate&&u?dist(candidate,u):null;
   const sims=candidate&&center?members.map(r=>({r,sim:cosineOf(unitOf(spec,placeId),unitOf(spec,r.place_id))})):[];
   f[space+'_mi_max']=sims.length?Math.max(...sims.map(x=>x.sim)):null;f[space+'_mi_top3']=mean(sims.map(x=>x.sim).sort((a,b)=>b-a).slice(0,3));f[space+'_mi_recent']=mean(sims.slice(-10).map(x=>x.sim));f[space+'_mi_like']=sims.some(x=>star(x.r.score)>=4)?Math.max(...sims.filter(x=>star(x.r.score)>=4).map(x=>x.sim)):null;
   for(const group of groups)f['rv_cos_'+group.label]=a&&group.centered?cosineOf(a,group.centered):null;
  });
  const desc=profile?.description_embedding,{dv,du}=hv;
  f.u_desc_cos=desc&&du?cosineOf(desc,du):null;f.u_desc_max=desc&&dv.length?Math.max(...dv.map(v=>cosineOf(desc,v))):null;
  }
  const resSum=hidden.length?history.map(r=>star(r.score)-localShopMean(r.place_id)).reduce((a,b)=>a+b,0):hs.resSum;
  f.l_len=resSum/(n+5);f.l_sd=Math.sqrt((hs.squares+5*localGv)/(n-1+5));f.l_hi=(hs.high+5*(hidden.length?(localYs.length?localYs.filter(y=>y===5).length/localYs.length:0):g5))/(n+5);f.l_lo=(hs.low+5*(hidden.length?(localYs.length?localYs.filter(y=>y<=2).length/localYs.length:0):g2))/(n+5);f.l_logn=Math.log1p(n);
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
