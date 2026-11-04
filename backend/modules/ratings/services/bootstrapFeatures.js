// Portable features: no external identities, current GPS or assumed brands.
const AXES=['homestyle','noodles','hotpotBbq','dessert','drinks','foreign'];
const ENGLISH={homestyle:['chinese'],noodles:['fast food','sandwich','pizza','hamburger','chicken','breakfast'],hotpotBbq:['barbecue','korean bbq','hot pot','hotpot'],dessert:['cake','bakery','ice cream','icecream','dessert'],drinks:['coffee','tea','cafe','café'],foreign:['japanese','korean','thai','italian','mexican','american','steak']};
function axes(place){
 const result=new Set(require('../../preferences/services/tasteAxes').ruleAxes(place));
 const text=String(place.category||place.style||'').toLowerCase();
 for(const axis of AXES)if(ENGLISH[axis].some(word=>text.includes(word)))result.add(axis);
 return AXES.map(axis=>result.has(axis)?1:0);
}
function fractional(vector){const n=vector.reduce((a,b)=>a+b,0);return n?vector.map(x=>x/n):vector;}
function median(values){if(!values.length)return null;const x=values.slice().sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function distanceKm(a,b){const rad=x=>x*Math.PI/180,dlat=rad(b[0]-a[0]),dlng=rad(b[1]-a[1]),h=Math.sin(dlat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dlng/2)**2;return 12742*Math.asin(Math.min(1,Math.sqrt(h)));}
function coordinate(place){const a=place.latitude,b=place.longitude;return a!=null&&b!=null&&Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(a)<=90&&Math.abs(b)<=180?[Number(a),Number(b)]:null;}
function createFeatures(places,ratings,viewerId=null,asOf=Date.now()){
 const byId=new Map(places.map(p=>[p.id,p])),vectors=new Map(places.map(p=>[p.id,axes(p)]));
 ratings=ratings.filter(r=>Number(r.created_at??r.updated_at??0)<=asOf);
 const global=AXES.map(()=>0);let globalCount=0;
 for(const rating of ratings){const vector=vectors.get(rating.place_id);if(!vector)continue;fractional(vector).forEach((v,k)=>global[k]+=v);globalCount++;}
 const globalShare=global.map(x=>globalCount?x/globalCount:0);
 const grouped=new Map();for(const r of ratings){if(!grouped.has(r.place_id))grouped.set(r.place_id,[]);grouped.get(r.place_id).push(r);}
 const allHistory=viewerId?ratings.filter(r=>r.user_id===viewerId&&byId.has(r.place_id)).sort((a,b)=>(b.created_at??b.updated_at??0)-(a.created_at??a.updated_at??0)):[];
 return function featureFor(placeId){
  const place=byId.get(placeId)||{},votes=grouped.get(placeId)||[],n=votes.length,ys=votes.map(r=>(r.score-1)/3),mean=n?ys.reduce((a,b)=>a+b,0)/n:null;
  const history=allHistory.filter(r=>r.place_id!==placeId),recent=history.slice(0,50),counts=AXES.map(()=>0);let known=0;
  for(const r of recent){const vector=vectors.get(r.place_id)||AXES.map(()=>0);if(vector.some(Boolean)){fractional(vector).forEach((v,k)=>counts[k]+=v);known++;}}
  const userShare=counts.map(x=>known?x/known:0),candidate=vectors.get(placeId)||AXES.map(()=>0),candidateNorm=Math.sqrt(candidate.reduce((a,b)=>a+b*b,0)),userNorm=Math.sqrt(userShare.reduce((a,b)=>a+b*b,0));
  const selected=AXES.map((_,k)=>k).filter(k=>candidate[k]);
  const coordinates=history.map(r=>coordinate(byId.get(r.place_id)||{})).filter(Boolean),target=coordinate(place);
  const center=coordinates.length?[median(coordinates.map(c=>c[0])),median(coordinates.map(c=>c[1]))]:null;
  const time=r=>Number(r.created_at??r.updated_at??0);
  return {log_n:Math.log1p(n),mean_norm:mean,var_norm:n?ys.reduce((a,b)=>a+(b-mean)**2,0)/n:null,low_share:n?ys.filter(y=>y<0.5).length/n:null,high_share:n?ys.filter(y=>y>0.5).length/n:null,
   chain_log:null,
   log_n30:Math.log1p(votes.filter(r=>time(r)>asOf-30*86400000&&time(r)<=asOf).length),log_n90:Math.log1p(votes.filter(r=>time(r)>asOf-90*86400000&&time(r)<=asOf).length),
   history_log_n:Math.log1p(history.length),user_mean_norm:history.length?history.reduce((a,r)=>a+(r.score-1)/3,0)/history.length:null,
   category_affinity:candidateNorm&&userNorm?candidate.reduce((sum,v,k)=>sum+v*userShare[k],0)/(candidateNorm*userNorm):null,
   category_lift:selected.length&&known?selected.reduce((sum,k)=>sum+Math.max(-3,Math.min(3,Math.log((userShare[k]+0.05)/(globalShare[k]+0.05)))),0)/selected.length:null,
   home_distance_log:center&&target?Math.log1p(distanceKm(center,target)):null};
 };
}
module.exports={AXES,axes,createFeatures};
