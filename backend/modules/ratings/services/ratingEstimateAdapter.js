const {db}=require('../../../infrastructure/database');
const client=require('../../../infrastructure/numericAlgorithmClient');
const snapshot=require('./ratingSnapshot');
const {classifyRatingEvidence}=require('./ratingSourcePolicy');
const {createFeatures}=require('./bootstrapFeatures');
const CONFIG=Object.freeze({config_version:'neutral-shadow-v1',source_policy_version:'explicit-revisions-v1',estimator_config:{method:'equal_weight_shrinkage',m:3,config_hash:'neutral-shadow-m3-v1'}});
function mode(name){const value=process.env[name];return value==='off'?'off':value==='shadow'?'shadow':'active';}
function modes(){return {estimate:mode('RATING_ESTIMATE_MODE'),prediction:mode('RATING_PREDICTION_MODE'),rank:mode('RATING_LIST_RANK_MODE'),random:mode('RATING_RANDOM_RANK_MODE')};}
async function configuration(){const model=await client.capabilities();return model?{config_version:model.model_id,source_policy_version:'explicit-revisions-v1',estimator_config:{method:'research_bootstrap',config_hash:model.model_hash},model}:null;}
function qualified(ids,database=db._raw){
 const result=[];
 for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200),marks=batch.map(()=>'?').join(',');
  const rows=database.prepare(`SELECT r.*,u.is_banned FROM PlaceRating r JOIN User u ON u.id=r.user_id WHERE r.place_id IN (${marks})`).all(...batch);
  const revisions=database.prepare(`SELECT user_id,place_id,action,origin,revision,previous_revision FROM RatingRevision WHERE place_id IN (${marks}) ORDER BY revision`).all(...batch);
  const chains=new Map();for(const r of revisions){const key=JSON.stringify([r.place_id,r.user_id]);if(!chains.has(key))chains.set(key,[]);chains.get(key).push(r);}
  for(const row of rows)if(classifyRatingEvidence(row,chains.get(JSON.stringify([row.place_id,row.user_id]))||[]).eligible)result.push({place_id:row.place_id,user_id:row.user_id,score:row.score,created_at:row.created_at,updated_at:row.updated_at});
 }return result;
}
function features(viewerId,now=Date.now(),database=db._raw){const places=database.prepare("SELECT id,name,category,latitude,longitude FROM Place WHERE moderation_status='visible'").all(),ratings=qualified(places.map(p=>p.id),database);return createFeatures(places,ratings,viewerId,now);}
async function estimate(ids,ratings,context,config,active){
 const rows=[];for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200),allowed=new Set(batch),bootstrap=config.estimator_config.method==='research_bootstrap';
  const r=await client.compute('ratingestimate',{...context,...config,model:undefined,place_ids:batch,ratings:ratings.filter(r=>allowed.has(r.place_id)).map(({place_id,user_id,score})=>({place_id,user_id,score})),...(bootstrap?{place_features:batch.map(place_id=>({place_id,features:{chain_log:null}}))}:{priors:batch.map(place_id=>({place_id,average:2.5,prior_version:'frozen-neutral-v1'}))})});
  rows.push(...r.estimates.map(row=>({...row,active,risk:row.risk?{...row.risk,active}:undefined})));}return rows;
}
async function ratingViews(placeIds,viewerId=null){
 const mode=modes();if(mode.estimate==='off'&&mode.prediction==='off')return {estimates:[],predictions:[]};
 const ids=[...new Set(placeIds)];if(!ids.length)return {estimates:[],predictions:[]};
 const configured=await configuration(),config=configured||CONFIG;
 if(!configured&&mode.estimate!=='shadow'&&mode.prediction!=='shadow')return {estimates:[],predictions:[]};
 for(let attempt=0;attempt<2;attempt++){
  const context=snapshot.context(),configKey=JSON.stringify(modes());
  const historyIds=viewerId&&mode.prediction!=='off'?db._raw.prepare('SELECT place_id FROM PlaceRating WHERE user_id=?').all(viewerId).map(r=>r.place_id):[];
  const allIds=[...new Set([...ids,...historyIds])],ratings=qualified(allIds);
  const estimates=await estimate(ids,ratings,context,config,!!configured&&mode.estimate==='active'),predictions=[];
  if(viewerId&&mode.prediction!=='off'){
   const baselines=await estimate(allIds,ratings.filter(r=>r.user_id!==viewerId),context,config,false),byId=new Map(baselines.map(r=>[r.place_id,r]));
   const history=ratings.filter(r=>r.user_id===viewerId&&(byId.get(r.place_id)?.average??byId.get(r.place_id)?.prior_average)!=null).map(r=>({place_id:r.place_id,score:r.score,baseline:byId.get(r.place_id).average??byId.get(r.place_id).prior_average}));
   for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200);const result=await client.compute('ratingpredict',{...context,config_version:config.config_version,...(configured?{model_hash:configured.model.model_hash}:{}),estimates:batch.map(id=>byId.get(id)),viewer_history:history,bias_strength:5});predictions.push(...result.predictions.map(r=>({...r,active:!!configured&&mode.prediction==='active'})));}
  }
  if(snapshot.same(context.input_revision)&&configKey===JSON.stringify(modes()))return {input_revision:context.input_revision,model:configured?.model??null,estimates:mode.estimate!=='off'?estimates:[],predictions};
 }throw client.failure(409,'stale_input');
}
async function rankCandidates(candidates,viewerId,context,{bonuses=[0.3,0.24,0.18,0.12,0.06],database=db._raw,config=null}={}){
 config=config||await configuration();if(!config)return null;
 const featureFor=features(viewerId,context.as_of_ms,database);
 const result=await client.compute('listrank',{...context,config_version:config.config_version,model_hash:config.model.model_hash,candidates:candidates.map(c=>({...c,features:featureFor(c.place_id)})),bonuses_by_choice_rank:bonuses});
 return {...result,model:config.model,feature_snapshot:Object.fromEntries(candidates.map(c=>[c.place_id,featureFor(c.place_id)]))};
}
module.exports={ratingViews,qualified,CONFIG,modes,configuration,features,rankCandidates};
