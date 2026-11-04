const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'negative-evidence-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');
async function main(){
 init();const sql=db._raw;
 for(const id of ['owner','viewer','third'])sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(id,id,'unused');
 for(const [id,category]of [[1,'粤菜'],[2,'避雷'],[3,'避雷'],[4,'咖啡'],[5,'咖啡']])sql.prepare("INSERT INTO Place(id,name,category,creator_id,moderation_status) VALUES(?,?,?,'owner','visible')").run(id,'synthetic'+id,category);
 const rate=(place,user,score,source='user')=>sql.prepare('INSERT INTO PlaceRating(place_id,user_id,score,source,created_at,updated_at) VALUES(?,?,?,?,0,0)').run(place,user,score,source);
 rate(1,'owner',2,'create');rate(2,'owner',1,'migration');rate(2,'viewer',1);rate(2,'third',4);
 rate(3,'owner',4,'create');rate(3,'third',4);rate(4,'viewer',4);rate(5,'viewer',3);
 const adapter=require('../../modules/ratings/services/ratingEstimateAdapter'),config=await adapter.configuration();
 assert.equal(config.model.method,'research_full_nonchain');assert.equal(config.calibration_policy,'local-negative-guard-v1');
 const views=await adapter.ratingViews([1,2,3],'viewer');
 for(const id of [1,2]){
  assert.ok(views.estimates.find(p=>p.place_id===id).average<=2.4);
  assert.ok(views.predictions.find(p=>p.place_id===id).average<=2.4,'target exclusion cannot suppress the public negative consensus');
 }
 assert.equal(views.estimates.find(p=>p.place_id===1).evidence_count,1,'creation default is retained');
 assert.deepEqual(views.estimates.find(p=>p.place_id===2).distribution,{1:2,2:0,3:0,4:1},'migration default is retained');
 assert.ok(views.estimates.find(p=>p.place_id===3).average<=2.4,'an explicit community warning remains effective even alongside high votes');
 assert.equal(require('../../modules/ratings/services/placeRatings').isAvoidedPlace({category:'避雷',rating_count:2,rating_average:4}),true);
 sql.prepare("UPDATE Place SET category='粤菜' WHERE id=3").run();
 assert.ok((await adapter.ratingViews([3],'viewer')).estimates[0].average>2.5,'removing the explicit warning restores the normal rating path');
 sql.prepare("UPDATE Place SET category='Restaurant' WHERE id=2").run();
 assert.ok((await adapter.ratingViews([2],'viewer')).estimates[0].average<=2.4,'ordinary model/category labels do not erase real low votes');
 const client=require('../../infrastructure/numericAlgorithmClient');
 assert.throws(()=>client.validate('ratingquality',{},{calibration_policy:adapter.CALIBRATION_POLICY}),e=>e.code==='invalid_response','old private service response cannot silently bypass the calibration');
 console.log('Negative evidence integration passed: asymmetric votes, local anchoring, viewer exclusion, category changes, retained defaults and version handshake.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db._raw.close();fs.rmSync(temp,{recursive:true,force:true});});
