// Explicit integration: set JOURNEY_PRIVATE_SERVICE_DIR; no public test imports private algorithms by default.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
async function main(){
    if(!process.env.JOURNEY_PRIVATE_SERVICE_DIR){console.log('Real numeric service integration skipped: JOURNEY_PRIVATE_SERVICE_DIR is unset.');return;}
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'numeric-service-'));
    Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',JOURNEY_ALGORITHM_SERVICE_TOKEN:'numeric-integration-test',PLACE_MODERATION_ENABLED:'false',SILICONFLOW_API_KEY:'',DEEPSEEK_API_KEY:''});
    const {createServer}=require(path.resolve(process.env.JOURNEY_PRIVATE_SERVICE_DIR,'src/server.js'));
    const server=createServer({env:{JOURNEY_ALGORITHM_SERVICE_TOKEN:process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.JOURNEY_ALGORITHM_SERVICE_URL=`http://127.0.0.1:${server.address().port}`;
    process.env.NUMERIC_ALGORITHM_SERVICE_URL=process.env.JOURNEY_ALGORITHM_SERVICE_URL;process.env.NUMERIC_ALGORITHM_SERVICE_TOKEN=process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN;
    const {db,init}=require('../../infrastructure/database');init();
    const pref=require('../../modules/preferences/services/userPreferenceService');
    const ratings=require('../../modules/ratings/services/placeRatings');
    const create=require('../../modules/places/services/placeService').createPlace;
    try{
        for(const id of ['creator','viewer','other'])db._raw.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
        const p=await create({name:'test-place',category:'餐厅',latitude:30,longitude:120,description:'本人补充的介绍',rating:4,rating_input_kind:'explicit'},'creator',{source:'web'});
        assert.equal(p.rating_average,4);assert.equal(p.rating_count,1);
        await new Promise(setImmediate); // Let the deliberately unconfigured embedding retry finish before installing a fixture vector.
        const v=new Float32Array(1024);v[0]=1;
        db._raw.prepare('INSERT INTO place_vectors(place_id,embedding) VALUES(?,?)').run(BigInt(p.id),Buffer.from(v.buffer));
        db._raw.prepare('UPDATE Place SET has_vector=1 WHERE id=?').run(p.id);
        const r=await ratings.ratePlace({id:'viewer'},p.id,3,{requestId:'first-rating-request'});
        assert.equal(r.summary.count,2);assert.equal(r.summary.average,3.5);assert.equal(r.mine.score,3);
        assert.equal((await pref.getUserPreference('viewer')).status,'ready');
        const before=db._raw.prepare('SELECT * FROM PlaceRating WHERE user_id=? AND place_id=?').get('viewer',p.id);
        const profileBeforeConfirm=db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get('viewer');
        await ratings.ratePlace({id:'viewer'},p.id,3,{requestId:'confirm-rating-request',confirm:true});
        const after=db._raw.prepare('SELECT * FROM PlaceRating WHERE user_id=? AND place_id=?').get('viewer',p.id);
        assert.deepEqual(after,before);assert.equal(ratings.ratingQuota('viewer').used,1);
        assert.deepEqual(db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get('viewer'),profileBeforeConfirm,'confirmation keeps a fresh profile and its original refresh deadline unchanged');
        const count=db._raw.prepare('SELECT COUNT(*) AS n FROM RatingRevision').get().n;
        await ratings.ratePlace({id:'viewer'},p.id,3,{requestId:'confirm-rating-request',confirm:true});
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM RatingRevision').get().n,count);
        await assert.rejects(ratings.ratePlace({id:'viewer'},p.id,1,{requestId:'confirm-rating-request'}),e=>e.status===409);
        await assert.rejects(ratings.ratePlace({id:'viewer'},p.id,3,{requestId:'confirm-rating-request',confirm:false}),e=>e.status===409,'changing confirmation intent under the same request ID is a different command');
        await ratings.ratePlace({id:'viewer'},p.id,1,{requestId:'change-rating-request'});
        assert.equal((await pref.getUserPreference('viewer')).status,'empty');
        assert.equal((await ratings.ratePlace({id:'viewer'},p.id,3,{requestId:'confirm-rating-request',confirm:true})).mine.score,1,'replay returns current state rather than old receipt');
        await require('../../modules/ratings/services/ratingReputation').refreshRatingWeights();
        assert.ok((await ratings.ratingSummary(p.id)).average>=1);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM RatingEvidenceLink WHERE user_id=?').get('creator').n,1);
        const client=require('../../infrastructure/numericAlgorithmClient'),compute=client.compute;
        let release,started;const blocked=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});let once=true;
        client.compute=async(op,input,options)=>{if(op==='preference'&&input.user_id==='other'&&once){once=false;started();await blocked;}return compute(op,input,options);};
        try{
            pref.changeFavorite('other',p.id,true);
            const job=pref.getUserPreference('other');await began;pref.changeFavorite('other',p.id,false);release();
            assert.equal((await job).status,'empty','stale positive snapshot must not replace an unfavorite');
            const row=db._raw.prepare('SELECT * FROM UserPreference WHERE user_id=?').get('other');assert.equal(row.input_revision,row.computed_input_revision);
        }finally{client.compute=compute;release();}
        let deliver,ready;const held=new Promise(resolve=>{deliver=resolve;}),received=new Promise(resolve=>{ready=resolve;});let holdOnce=true;
        client.compute=async(op,input,options)=>{const result=await compute(op,input,options);if(op==='preference'&&input.user_id==='other'&&holdOnce){holdOnce=false;ready();await held;}return result;};
        try{
            pref.changeFavorite('other',p.id,true);const job=pref.getUserPreference('other');await received;
            pref.startUserVectorWorker()();deliver();await assert.rejects(job);
            assert.equal(db._raw.prepare('SELECT dirty FROM UserPreference WHERE user_id=?').get('other').dirty,1,'stopping the worker rejects late publication even after HTTP completed');
        }finally{client.compute=compute;deliver();}
        await ratings.withdrawRating({id:'viewer'},p.id,{requestId:'withdraw-rating-request'});
        assert.equal((await ratings.ratingState(p.id,{id:'viewer'})).mine,null);
        const unchanged=db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRatingEvent').get().n;
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
        await assert.rejects(ratings.ratePlace({id:'viewer'},p.id,4,{requestId:'unavailable-request'}),e=>e.status===503);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRatingEvent').get().n,unchanged);
        console.log('Real private numeric HTTP: scores, profile publication, confirmations, idempotency, history, withdrawal and failure atomicity passed.');
    }finally{
        pref.startUserVectorWorker()();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));
        await new Promise(setImmediate);db._raw.close();fs.rmSync(temp,{recursive:true,force:true});
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
