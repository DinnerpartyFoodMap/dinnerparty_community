const {db,isVectorSearchAvailable}=require('../../../infrastructure/database');
const {EMBEDDING_MODEL}=require('../../../infrastructure/aiClients');
const {context,same,profileRows}=require('./ratingSnapshot');
const {placeMeanVector}=require('./meanVectorAdapter');
const client=require('../../../infrastructure/numericAlgorithmClient');
function userRatingWeight(id){return db._raw.prepare('SELECT weight FROM UserReputation WHERE user_id=?').get(id)?.weight??0.5;}
function encodeMean(value){if(!value)return null;const b=Buffer.alloc(1024*8);value.forEach((n,i)=>b.writeDoubleLE(n,i*8));return b.toString('base64');}
let pending=null,started=false;
async function refreshRatingWeights(now=Date.now()){
    if(pending)return pending.promise;
    const controller=new AbortController(),entry={controller,promise:null};
    entry.promise=(async()=>{for(let attempt=0;attempt<2;attempt++){
        const mean=isVectorSearchAvailable()?encodeMean(await placeMeanVector(now)):null;
        const input=db._raw.transaction(()=>({...context(now),model:EMBEDDING_MODEL,mean,
            users:db._raw.prepare('SELECT id,is_banned FROM User').all(),
            places:db._raw.prepare('SELECT id,creator_id,description,category,per_person_cost,exterior_images,menu_images FROM Place').all(),
            ratings:db._raw.prepare('SELECT place_id,user_id,score,source,updated_at FROM PlaceRating').all(),
            favorites:db._raw.prepare('SELECT user_id,place_id FROM Favorite').all(),
            requests:db._raw.prepare("SELECT requester_id,status FROM PlaceRequest WHERE status='approved'").all(),profiles:isVectorSearchAvailable()?profileRows():[]}))();
        const result=await client.computeRatingWeights(input,{signal:controller.signal});
        const saved=db._raw.transaction(()=>{if(controller.signal.aborted||!same(input.input_revision))return false;
            db._raw.prepare('DELETE FROM UserReputation').run();
            const save=db._raw.prepare(`INSERT INTO UserReputation(user_id,beta,gamma,weight,contribution,evidence,rating_count,agreement,updated_at) VALUES(@user_id,@beta,@gamma,@weight,@contribution,@evidence,@rating_count,@agreement,@updated_at)`);
            for(const row of result.reputations)save.run({...row,updated_at:now});
            const update=db._raw.prepare('UPDATE PlaceRating SET weight=? WHERE place_id=? AND user_id=?');for(const row of result.rating_weights)update.run(row.weight,row.place_id,row.user_id);
            db._raw.prepare('INSERT INTO RatingWeightRefresh(id,updated_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at').run(now);return true;
        }).immediate();
        if(saved)return result.reputations.length;
    }throw client.failure(409,'stale_input');})().finally(()=>{if(pending===entry)pending=null;});pending=entry;return entry.promise;
}
async function refreshRatingWeightsIfNeeded(now=Date.now()){const last=db._raw.prepare('SELECT updated_at FROM RatingWeightRefresh WHERE id=1').get();if(last&&now>=last.updated_at&&now-last.updated_at<86400000)return false;await refreshRatingWeights(now);return true;}
function startRatingReputationWorker(){started=true;refreshRatingWeightsIfNeeded().catch(()=>console.warn('Rating startup refresh unavailable'));const interval=setInterval(()=>refreshRatingWeightsIfNeeded().catch(()=>console.warn('Rating refresh unavailable')),60000);interval.unref?.();return()=>{started=false;clearInterval(interval);pending?.controller.abort();};}
async function ratingReady(){if(started)await refreshRatingWeightsIfNeeded();}
module.exports={userRatingWeight,refreshRatingWeights,refreshRatingWeightsIfNeeded,startRatingReputationWorker,ratingReady,encodeMean};
