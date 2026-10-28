const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rating-boundaries-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',PLACE_MODERATION_ENABLED:'false',SILICONFLOW_API_KEY:'',DEEPSEEK_API_KEY:''});
const {db,init}=require('../../infrastructure/database'),sql=db._raw;
function load(relative,overrides={}){
    const filename=path.resolve(__dirname,relative),native=createRequire(filename),module={exports:{}};
    const custom=id=>Object.hasOwn(overrides,id)?overrides[id]:native(id);
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(filename,'utf8')}\n})`,{filename})(custom,module,module.exports,filename,path.dirname(filename));
    return module.exports;
}
const snapshot=require('../../modules/ratings/services/ratingSnapshot'),client=require('../../infrastructure/numericAlgorithmClient');
const summary=require('../../modules/ratings/services/ratingSummaryAdapter');
const bump=()=>sql.prepare('UPDATE AlgorithmClock SET revision=revision+1 WHERE id=1').run();
const empty={count:0,average:null,tier:null,distribution:{1:0,2:0,3:0,4:0}};
async function main(){
    init();const failures=[];
    async function check(name,fn){try{await fn();console.log(`PASS ${name}`);}catch(e){failures.push(name);console.error(`FAIL ${name}: ${e.message}`);}}
    for(const id of ['viewer','peer1','peer2','creator','editor'])sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
    const place=Number(sql.prepare("INSERT INTO Place(name,creator_id,moderation_status) VALUES('race-place','creator','visible')").run().lastInsertRowid);
    await check('viewer snapshot is captured before awaiting mean',async()=>{
        let changed=false;
        const business=load('../../modules/ratings/services/ratingBusiness.js',{
            '../../../infrastructure/database':{db,isVectorSearchAvailable:()=>true},
            './meanVectorAdapter':{placeMeanVector:async()=>{if(!changed){changed=true;bump();}return null;}},
            '../../../infrastructure/numericAlgorithmClient':{...client,compute:async(_op,input)=>({personalized:input.viewer.generation})}
        });
        const result=await business.personalizedSummary(place,'viewer',{readViewerPreference:async()=>({generation:snapshot.revision()})});
        assert.equal(result,snapshot.revision(),'an old viewer cannot be stamped with the post-await revision');
    });
    await check('ratingState rechecks the combined public and personal snapshot',async()=>{
        let changed=false;
        const business=load('../../modules/ratings/services/ratingBusiness.js',{
            '../../../infrastructure/database':{db,isVectorSearchAvailable:()=>false},
            '../../preferences/services/userPreferenceService':{getUserPreference:async()=>({generation:snapshot.revision()})},
            './ratingSummaryAdapter':{...summary,ratingSummary:async()=>{if(!changed){changed=true;bump();}return empty;},ratingSummarySnapshot:async()=>{if(!changed){changed=true;bump();}return {summary:empty,input_revision:snapshot.revision()};}},
            '../../../infrastructure/numericAlgorithmClient':{...client,compute:async(_op,input)=>({personalized:input.viewer.generation})}
        });
        const result=await business.ratingState(place,{id:'viewer'});assert.equal(result.personalized,snapshot.revision());
    });
    await check('list does not reuse personal values across an awaited summary refresh',async()=>{
        let changed=false,lastDerived;
        const derive=async()=>{lastDerived=snapshot.revision();return new Map([[place,3]]);};
        const list=load('../../modules/places/services/placeList.js',{
            '../../../infrastructure/database':{db,isVectorSearchAvailable:()=>true},
            '../../ratings/services/placeRatings':{RATING_COLUMNS_SQL:summary.RATING_COLUMNS_SQL,personalizedAverages:derive,personalizedAveragesSnapshot:async()=>({input_revision:snapshot.revision(),averages:await derive()})},
            '../../ratings/services/ratingSummaryAdapter':{ensureRatingSummaries:async()=>{if(!changed){changed=true;bump();}return snapshot.revision();}},
            '../../../infrastructure/numericAlgorithmClient':{...client,compute:async(_op,input)=>{assert.equal(input.input_revision,lastDerived,'list personal data and sort must share the same revision');return {ranked:input.places.map(p=>({place_id:p.id,score:3}))};}}
        });
        assert.equal((await list.listPlaces({},'viewer')).items.length,1);
    });
    await check('list excludes a creator blocked while remote sorting is pending',async()=>{
        const list=load('../../modules/places/services/placeList.js',{
            '../../ratings/services/ratingSummaryAdapter':{ensureRatingSummaries:async()=>snapshot.revision()},
            '../../../infrastructure/numericAlgorithmClient':{...client,compute:async(_op,input)=>{sql.prepare("INSERT OR IGNORE INTO UserBlock(user_id,blocked_id) VALUES('viewer','creator')").run();return {ranked:input.places.map(p=>({place_id:p.id,score:3}))};}}
        });
        try{assert.equal((await list.listPlaces({},'viewer')).items.length,0);}finally{sql.prepare("DELETE FROM UserBlock WHERE user_id='viewer'").run();}
    });
    for(const change of ['discovery','ban','block','delete'])await check(`neighbors recheck ${change} after the last profile await`,async()=>{
        if(!sql.prepare("SELECT id FROM User WHERE id='peer1'").get())sql.prepare("INSERT INTO User(id,username,password) VALUES('peer1','peer1','unused')").run();
        sql.prepare("UPDATE User SET is_banned=0 WHERE id='peer1'").run();
        sql.prepare("UPDATE MapConsent SET discovery=1 WHERE user_id IN('viewer','peer1','peer2')").run();
        for(const id of ['peer1','peer2'])sql.prepare("INSERT OR IGNORE INTO UserPreference(user_id,model,dimensions,algorithm_version,status,updated_at,dirty) VALUES(?,'test',1024,2,'ready',1,0)").run(id);
        const p={status:'ready',vector:[1,0],model:'test',dimensions:2,algorithm_version:2,vector_place_count:5};
        let changed=false;
        const community=load('../../modules/community/services/communityPreferences.js',{'../../preferences/services/userPreferenceService':{getUserPreference:async(id)=>{
            if(id==='peer2'&&!changed){changed=true;
                if(change==='discovery')sql.prepare("UPDATE MapConsent SET discovery=0 WHERE user_id='peer1'").run();
                if(change==='ban')sql.prepare("UPDATE User SET is_banned=1 WHERE id='peer1'").run();
                if(change==='block')sql.prepare("INSERT INTO UserBlock(user_id,blocked_id) VALUES('viewer','peer1')").run();
                if(change==='delete')sql.prepare("DELETE FROM User WHERE id='peer1'").run();
            }return p;
        }}});
        try{assert.ok(!(await community.neighbors('viewer')).neighbors.some(p=>p.id==='peer1'));}finally{sql.prepare("DELETE FROM UserBlock WHERE user_id='viewer'").run();}
    });
    await check('create cannot retry past an in-flight creator ban',async()=>{
        let banned=false;
        const service=load('../../modules/places/services/placeService.js',{'../../../infrastructure/numericAlgorithmClient':{...client,compute:async()=>{if(!banned){banned=true;sql.prepare("UPDATE User SET is_banned=1 WHERE id='creator'").run();}return {summaries:[{...empty,count:1,average:4,tier:4,distribution:{1:0,2:0,3:0,4:1}}]};}}});
        const before=sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
        try{await assert.rejects(service.createPlace({name:'banned-race',category:'餐厅',latitude:30,longitude:120},'creator',{source:'web'}),e=>e.status===403);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n,before);}finally{sql.prepare("UPDATE User SET is_banned=0 WHERE id='creator'").run();}
    });
    await check('edit rechecks current admin permission after summary await',async()=>{
        const express=require('express');sql.prepare("UPDATE User SET admin_level='YUYUKO' WHERE id='editor'").run();
        const route=load('../../modules/places/routes/places.js',{
            '../../accounts/middleware/auth':{requireAuth:(req,_res,next)=>{req.user=sql.prepare("SELECT * FROM User WHERE id='editor'").get();next();},attachViewer:(_req,_res,next)=>next()},
            '../../ratings/services/ratingSummaryAdapter':{ensureRatingSummaries:async()=>{sql.prepare("UPDATE User SET admin_level=NULL WHERE id='editor'").run();}}
        });
        const app=express();app.use(express.json());app.use('/places',route);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
        try{const response=await fetch(`http://127.0.0.1:${server.address().port}/places/${place}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'forbidden-edit'})});assert.equal(response.status,403);assert.equal(sql.prepare('SELECT name FROM Place WHERE id=?').get(place).name,'race-place');}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    });
    assert.deepEqual(failures,[],'all asynchronous version and authorization boundaries must pass');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    require('../../modules/preferences/services/userPreferenceService').startUserVectorWorker()();await new Promise(setImmediate);sql.close();fs.rmSync(temp,{recursive:true,force:true});
});
