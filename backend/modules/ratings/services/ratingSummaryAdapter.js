const {db}=require('../../../infrastructure/database');
const client=require('../../../infrastructure/numericAlgorithmClient');
const {context,same,revision}=require('./ratingSnapshot');
const RATING_COLUMNS_SQL=`
    COALESCE((SELECT s.count FROM PlaceRatingSummary s WHERE s.place_id=p.id),0) AS rating_count,
    (SELECT s.average FROM PlaceRatingSummary s WHERE s.place_id=p.id) AS rating_average`;
let pending=null;
function readRatings(){return db._raw.prepare(`SELECT r.*,COALESCE(u.is_banned,0) AS is_banned FROM PlaceRating r JOIN User u ON u.id=r.user_id`).all();}
function readSummary(id){const r=db._raw.prepare('SELECT * FROM PlaceRatingSummary WHERE place_id=?').get(id);return r?{count:r.count,average:r.average,tier:r.tier,distribution:JSON.parse(r.distribution)}:{count:0,average:null,tier:null,distribution:{1:0,2:0,3:0,4:0}};}
function writeSummary(id,r){db._raw.prepare(`INSERT INTO PlaceRatingSummary(place_id,count,average,tier,distribution) VALUES(?,?,?,?,?) ON CONFLICT(place_id) DO UPDATE SET count=excluded.count,average=excluded.average,tier=excluded.tier,distribution=excluded.distribution`).run(id,r.count,r.average,r.tier,JSON.stringify(r.distribution));}
async function rebuild(){for(let attempt=0;attempt<2;attempt++){
    const input=db._raw.transaction(()=>({...context(),ratings:readRatings(),place_ids:db._raw.prepare('SELECT id FROM Place').all().map(x=>x.id)}))();
    const summaries=[];
    for(let offset=0;offset<input.place_ids.length;offset+=200){const place_ids=input.place_ids.slice(offset,offset+200),ids=new Set(place_ids);const r=await client.compute('ratingsummary',{...input,place_ids,ratings:input.ratings.filter(x=>ids.has(x.place_id))});summaries.push(...r.summaries);}
    // Even an empty database verifies service capability before marking ready.
    if(!input.place_ids.length)await client.compute('ratingsummary',{...input,ratings:[]});
    const saved=db._raw.transaction(()=>{if(!same(input.input_revision))return false;db._raw.prepare('DELETE FROM PlaceRatingSummary').run();for(const r of summaries)writeSummary(r.place_id,r);db._raw.prepare('INSERT INTO RatingSummaryState(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(input.input_revision);return true;}).immediate();
    if(saved)return;
}throw client.failure(409,'stale_input');}
async function ensureRatingSummaries(){
    await require('./ratingReputation').ratingReady();
    for(let n=0;n<2;n++){
        const current=revision();
        if(db._raw.prepare('SELECT revision FROM RatingSummaryState WHERE id=1').get()?.revision===current)return current;
        if(!pending)pending=rebuild().finally(()=>{pending=null;});await pending;
    }
    if(db._raw.prepare('SELECT revision FROM RatingSummaryState WHERE id=1').get()?.revision!==revision())throw client.failure(409,'stale_input');
    return revision();
}
async function ratingSummarySnapshot(id){
    await ensureRatingSummaries();
    const current=revision();
    if(db._raw.prepare('SELECT revision FROM RatingSummaryState WHERE id=1').get()?.revision!==current)throw client.failure(409,'stale_input');
    return {input_revision:current,summary:readSummary(Number(id))};
}
async function ratingSummary(id){return (await ratingSummarySnapshot(id)).summary;}
async function ratingsReadMiddleware(req,res,next){try{await ensureRatingSummaries();next();}catch(e){res.status(e.status||503).json({error:e.publicMessage||'评价服务暂不可用，请稍后重试'});}}
module.exports={RATING_COLUMNS_SQL,readRatings,readSummary,writeSummary,ensureRatingSummaries,ratingSummary,ratingSummarySnapshot,ratingsReadMiddleware};
