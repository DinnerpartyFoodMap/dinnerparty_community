const {db}=require('../../../infrastructure/database');
const client=require('../../../infrastructure/numericAlgorithmClient');
const snapshot=require('./ratingSnapshot');
const {classifyRatingEvidence}=require('./ratingSourcePolicy');
const {createFeatures}=require('./bootstrapFeatures');
const profiles=require('./modelProfiles');
const {buildFullFeatures,covisitGraph}=require('./fullModelFeatures');
const CONFIG=Object.freeze({config_version:'neutral-shadow-v1',source_policy_version:'retained-ratings-v2',estimator_config:{method:'equal_weight_shrinkage',m:3,config_hash:'neutral-shadow-m3-v1'}});
function mode(name){const value=process.env[name];return value==='off'?'off':value==='shadow'?'shadow':'active';}
function modes(){return {estimate:mode('RATING_ESTIMATE_MODE'),prediction:mode('RATING_PREDICTION_MODE'),rank:mode('RATING_LIST_RANK_MODE'),random:mode('RATING_RANDOM_RANK_MODE')};}
const contracts=new Map();
async function configuration(){const model=await client.capabilities();if(!model)return null;let contract=null,featureOrders=null;
 if(model.schema_version===2||model.method==='research_full_nonchain'){
  let entry=contracts.get(model.model_hash);if(!entry){entry=client.compute('modelcontract',{config_version:model.model_id,model_hash:model.model_hash}).catch(e=>{contracts.delete(model.model_hash);throw e;});if(contracts.size>=4)contracts.delete(contracts.keys().next().value);contracts.set(model.model_hash,entry);}
  const data=await entry;contract=data.feature_contract;featureOrders=data.feature_orders;
  if(!contract.encoders&&contract.encoder_model)contract={...contract,encoders:Object.fromEntries(['description','review'].map(kind=>[kind,{model:contract.encoder_model,revision:contract.encoder_revision,dimensions:contract.transforms?.[kind]?.mean?.length||1024,max_length:contract[kind+'_max_length'],pooling:'last-token-left-padding-l2-f16'}]))};
 }
 return {config_version:model.model_id,source_policy_version:'retained-ratings-v2',estimator_config:{method:model.method,config_hash:model.model_hash},model,contract,featureOrders};}
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
const featureCache=new Map(),qualityCache=new Map(),graphCache=new Map();
function fullFeatures(viewerId,context,config,database=db._raw,candidateCount=1){
 const key=JSON.stringify([context.input_revision,config.model.model_hash,viewerId,candidateCount,context.as_of_ms]),cached=featureCache.get(key);if(cached?.database===database)return cached.value;
 const graphKey=JSON.stringify([context.input_revision,config.model.model_hash]);let graph=graphCache.get(graphKey);
 if(!graph||graph.database!==database||context.as_of_ms<graph.from||context.as_of_ms>=graph.until){const places=database.prepare("SELECT * FROM Place WHERE moderation_status='visible'").all(),allRatings=qualified(places.map(p=>p.id),database),ratings=allRatings.filter(r=>Number(r.created_at??r.updated_at??0)<=context.as_of_ms),assets=profiles.readProfiles(places,config.model,database),future=allRatings.map(r=>Number(r.created_at??r.updated_at??0)).filter(t=>t>context.as_of_ms);graph={database,places,ratings,assets,covisit:covisitGraph(ratings),from:context.as_of_ms,until:future.length?Math.min(...future):Infinity};if(graphCache.size>=4)graphCache.delete(graphCache.keys().next().value);graphCache.set(graphKey,graph);}
 const value=buildFullFeatures({places:graph.places,ratings:graph.ratings,profiles:graph.assets,viewerId,asOf:context.as_of_ms,contract:config.contract,candidateCount,covisit:graph.covisit});
 if(featureCache.size>=16)featureCache.delete(featureCache.keys().next().value);featureCache.set(key,{database,value});return value;
}
async function quality(context,config,excludeViewer=null){
 const key=JSON.stringify([context.input_revision,config.model.model_hash,excludeViewer]),cached=qualityCache.get(key);if(cached&&context.as_of_ms>=cached.from&&context.as_of_ms<cached.until)return cached.result;
 const places=db._raw.prepare("SELECT id,category FROM Place WHERE moderation_status='visible'").all(),ids=places.map(p=>p.id),allRatings=qualified(ids).filter(r=>r.user_id!==excludeViewer),future=allRatings.map(r=>Number(r.created_at??r.updated_at??0)).filter(t=>t>context.as_of_ms),ratings=allRatings.filter(r=>Number(r.created_at??r.updated_at??0)<=context.as_of_ms).map(({place_id,user_id,score})=>({place_id,user_id,score})),assets=profiles.readProfiles(places,config.model),rated=new Set(ratings.map(r=>r.place_id));
 const place_groups=places.filter(p=>rated.has(p.id)).map(p=>{const raw=assets.get(p.id)?.primary_style||assets.get(p.id)?.categories?.[0]||String(p.category||'').split(/[,，|]/)[0].trim();return {place_id:p.id,group_id:raw&&!['其他','未分类','餐厅','地点'].includes(raw)?raw:null};});
 const result=client.compute('ratingquality',{...context,config_version:config.config_version,model_hash:config.model.model_hash,ratings,place_groups},{timeoutMs:30000}).then(r=>new Map(r.qualities.map(p=>[p.place_id,p.average]))).catch(e=>{qualityCache.delete(key);throw e;});
 if(qualityCache.size>=16)qualityCache.delete(qualityCache.keys().next().value);qualityCache.set(key,{result,from:context.as_of_ms,until:future.length?Math.min(...future):Infinity});return result;
}
async function estimate(ids,ratings,context,config,active,viewerId=null,excludeViewer=null){
 const full=config.model?.method==='research_full_nonchain',builder=full?fullFeatures(viewerId,context,config):null,qualities=full?await quality(context,config,excludeViewer):null;
 const rows=[];for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200),allowed=new Set(batch),bootstrap=['research_bootstrap','research_full_nonchain'].includes(config.estimator_config.method);
  const {model,contract,featureOrders,...wire}=config;
  const r=await client.compute('ratingestimate',{...context,...wire,place_ids:batch,ratings:ratings.filter(r=>allowed.has(r.place_id)).map(({place_id,user_id,score})=>({place_id,user_id,score})),...(bootstrap?{place_features:batch.map(place_id=>({place_id,features:full?builder.featureFor(place_id,{excludeViewer:excludeViewer!==null}):{chain_log:null},...(qualities?.has(place_id)?{quality_average:qualities.get(place_id)}:{})}))}:{priors:batch.map(place_id=>({place_id,average:2.5,prior_version:'frozen-neutral-v1'}))})});
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
  const allIds=[...new Set([...ids,...historyIds])],ratings=qualified(allIds).filter(r=>Number(r.created_at??r.updated_at??0)<=context.as_of_ms);
  const estimates=await estimate(ids,ratings,context,config,!!configured&&mode.estimate==='active',viewerId),predictions=[];
  if(viewerId&&mode.prediction!=='off'){
   const baselines=await estimate(allIds,ratings.filter(r=>r.user_id!==viewerId),context,config,false,viewerId,viewerId),byId=new Map(baselines.map(r=>[r.place_id,r]));
   const history=ratings.filter(r=>r.user_id===viewerId&&(byId.get(r.place_id)?.average??byId.get(r.place_id)?.prior_average)!=null).map(r=>({place_id:r.place_id,score:r.score,baseline:byId.get(r.place_id).average??byId.get(r.place_id).prior_average}));
   const full=config.model?.method==='research_full_nonchain',builder=full?fullFeatures(viewerId,context,config):null;
   for(let offset=0;offset<ids.length;offset+=200){const batch=ids.slice(offset,offset+200);const result=await client.compute('ratingpredict',{...context,config_version:config.config_version,...(configured?{model_hash:configured.model.model_hash,model_method:configured.model.method}:{}),...(full?{place_features:batch.map(place_id=>({place_id,features:builder.featureFor(place_id,{excludeViewer:true})}))}:{}),estimates:batch.map(id=>byId.get(id)),viewer_history:history,bias_strength:5});predictions.push(...result.predictions.map(r=>({...r,active:!!configured&&mode.prediction==='active'})));}
  }
  if(snapshot.same(context.input_revision)&&configKey===JSON.stringify(modes()))return {input_revision:context.input_revision,model:configured?.model??null,estimates:mode.estimate!=='off'?estimates:[],predictions};
 }throw client.failure(409,'stale_input');
}
async function rankCandidates(candidates,viewerId,context,{bonuses=[0.3,0.24,0.18,0.12,0.06],database=db._raw,config=null}={}){
 config=config||await configuration();if(!config)return null;
 const featureFor=config.model.method==='research_full_nonchain'?fullFeatures(viewerId,context,config,database,candidates.length).featureFor:features(viewerId,context.as_of_ms,database);
 const order=config.featureOrders?.choice,featureSnapshot=Object.fromEntries(candidates.map(c=>{const values=featureFor(c.place_id);return [c.place_id,order?Object.fromEntries(order.map(key=>[key,values[key]??null])):values];}));
 const result=await client.compute('listrank',{...context,config_version:config.config_version,model_hash:config.model.model_hash,candidates:candidates.map(c=>({...c,features:featureSnapshot[c.place_id]})),bonuses_by_choice_rank:bonuses});
 return {...result,model:config.model,feature_snapshot:featureSnapshot};
}
module.exports={ratingViews,qualified,CONFIG,modes,configuration,features,rankCandidates,fullFeatures};
