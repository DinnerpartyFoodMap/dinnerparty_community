const {db}=require('../../../infrastructure/database');
const client=require('../../../infrastructure/numericAlgorithmClient');
const snapshot=require('./ratingSnapshot');
const {classifyRatingEvidence}=require('./ratingSourcePolicy');
const CONFIG=Object.freeze({config_version:'neutral-shadow-v1',source_policy_version:'explicit-revisions-v1',estimator_config:{method:'equal_weight_shrinkage',m:3,config_hash:'neutral-shadow-m3-v1'}});
// This initial prior/configuration has no offline validation and is deliberately shadow-only.
function modes(){return {estimate:process.env.RATING_ESTIMATE_MODE==='shadow',prediction:process.env.RATING_PREDICTION_MODE==='shadow'};}
function qualified(ids){
 const result=[];
 for(let offset=0;offset<ids.length;offset+=200){
  const batch=ids.slice(offset,offset+200),marks=batch.map(()=>'?').join(',');
  const rows=db._raw.prepare(`SELECT r.*,u.is_banned FROM PlaceRating r JOIN User u ON u.id=r.user_id WHERE r.place_id IN (${marks})`).all(...batch);
  const revisions=db._raw.prepare(`SELECT user_id,place_id,action,origin,revision,previous_revision FROM RatingRevision WHERE place_id IN (${marks}) ORDER BY revision`).all(...batch);
  const chains=new Map();for(const r of revisions){const key=JSON.stringify([r.place_id,r.user_id]);if(!chains.has(key))chains.set(key,[]);chains.get(key).push(r);}
  for(const row of rows)if(classifyRatingEvidence(row,chains.get(JSON.stringify([row.place_id,row.user_id]))||[]).eligible)result.push({place_id:row.place_id,user_id:row.user_id,score:row.score});
 }
 return result;
}
async function estimate(ids,ratings,context){
 const rows=[];for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200),allowed=new Set(batch);const r=await client.compute('ratingestimate',{...context,...CONFIG,place_ids:batch,ratings:ratings.filter(r=>allowed.has(r.place_id)),priors:batch.map(place_id=>({place_id,average:2.5,prior_version:'frozen-neutral-v1'}))});rows.push(...r.estimates.map(row=>({...row,active:false})));}return rows;
}
async function ratingViews(placeIds,viewerId=null){
 const mode=modes();if(!mode.estimate&&!mode.prediction)return {estimates:[],predictions:[]};
 const ids=[...new Set(placeIds)];if(!ids.length)return {estimates:[],predictions:[]};
 for(let attempt=0;attempt<2;attempt++){
  const context=snapshot.context(),configKey=JSON.stringify(modes());
  const historyIds=viewerId&&mode.prediction?db._raw.prepare('SELECT place_id FROM PlaceRating WHERE user_id=?').all(viewerId).map(r=>r.place_id):[];
  const allIds=[...new Set([...ids,...historyIds])],ratings=qualified(allIds);
  const estimates=await estimate(ids,ratings,context),predictions=[];
  if(viewerId&&mode.prediction){
   // The viewer never contributes to target estimates or historical baselines.
   const baselines=await estimate(allIds,ratings.filter(r=>r.user_id!==viewerId),context),byId=new Map(baselines.map(r=>[r.place_id,r]));
   const history=ratings.filter(r=>r.user_id===viewerId&&byId.get(r.place_id)?.average!=null).map(r=>({place_id:r.place_id,score:r.score,baseline:byId.get(r.place_id).average}));
   for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200);const result=await client.compute('ratingpredict',{...context,config_version:CONFIG.config_version,estimates:batch.map(id=>byId.get(id)),viewer_history:history,bias_strength:5});predictions.push(...result.predictions.map(r=>({...r,active:false})));}
  }
  if(snapshot.same(context.input_revision)&&configKey===JSON.stringify(modes()))return {input_revision:context.input_revision,estimates:mode.estimate?estimates:[],predictions};
 }
 throw client.failure(409,'stale_input');
}
module.exports={ratingViews,qualified,CONFIG};
