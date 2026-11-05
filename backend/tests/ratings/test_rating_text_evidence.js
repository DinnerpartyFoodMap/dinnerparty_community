'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'text-evidence-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false',PLACE_MODERATION_ENABLED:'false',DEEPSEEK_API_KEY:'',SILICONFLOW_API_KEY:''});
require.cache[require.resolve('../../infrastructure/redis')]={exports:{isReady:()=>false}};
const {db,init}=require('../../infrastructure/database');let server;
async function main(){
 init();const sql=db._raw;for(const id of ['owner','guest','admin'])sql.prepare('INSERT INTO User(id,username,password,admin_level) VALUES(?,?,?,?)').run(id,id,'unused',id==='admin'?'YOUMU':null);
 sql.prepare("INSERT INTO Place(id,name,description,category,creator_id,moderation_status) VALUES(1,'Test','烧鸭好吃','粤菜','owner','visible')").run();
 const jwt=require('jsonwebtoken'),express=require('express'),app=express();app.use(express.json());app.use('/places',require('../../modules/places/routes/places'));app.use('/place-requests',require('../../modules/places/routes/placeRequests'));app.use('/comments',require('../../modules/community/routes/comments'));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
 const request=async(method,url,body,user='owner')=>{const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({id:user},process.env.JWT_SECRET||'yuyuko_secret_key')},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const revision=()=>sql.prepare('SELECT COUNT(*) n FROM PlaceRevision').get().n;
 let r=await request('PUT','/places/1',{description:'烧鸭好吃，等了40分钟'});assert.equal(r.status,400);assert.equal(revision(),0,'missing rating rolls back edit');
 r=await request('PUT','/places/1',{description:'烧鸭好吃，等了40分钟',rating:2});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(sql.prepare('SELECT score FROM PlaceRating').get().score,2);assert.equal(sql.prepare('SELECT COUNT(*) n FROM Comment').get().n,1);
 const evidence=require('../../modules/ratings/services/ratingTextEvidence'),judge=require('../../modules/ratings/services/ratingContentJudge');
 assert.equal(judge.cleanText(null),'');assert.equal(judge.cleanText(undefined),'');assert.equal(judge.cleanText(Number.NaN),'');assert.equal(judge.cleanText('nan'),'nan','literal text is not silently discarded');assert.equal(judge.multiplier(null,1),1,'a genuinely absent description has baseline influence, never template penalty');
 const row=sql.prepare('SELECT * FROM RatingTextEvidence').get();assert.equal(row.user_id,'owner');assert.ok(row.evidence_text.includes('等了40分钟'));assert.ok(!row.evidence_text.includes('烧鸭好吃'),'old author text not credited again');
 assert.ok(require('../../modules/ratings/services/modelProfiles').inputFor(1).reviews.some(r=>r.content.includes('等了40分钟')&&!r.content.includes('烧鸭好吃')),'model profiles consume only the new contribution, including short specific text, never the deleted/before-state diff');
 r=await request('PUT','/places/1',{description:'烧鸭好吃，等了40分钟',rating:4});assert.equal(r.status,200);assert.equal(sql.prepare('SELECT COUNT(*) n FROM Comment').get().n,1,'retry does not create another comment');assert.equal(sql.prepare('SELECT score FROM PlaceRating').get().score,2,'editing never overwrites an existing vote');
 assert.deepEqual((await request('GET','/places/1/edit-context')).data.mine,{score:2});
 const beforeJudgeClock=require('../../modules/ratings/services/ratingSnapshot').revision();
 await evidence.processPending({evaluate:async rows=>rows.map(r=>({id:r.id,polarity:'negative',specificity:1,positive_support:0,negative_support:1,negative_severity:.5,boilerplate:0,confidence:.9,excerpts:['等了40分钟']}))});
 assert.equal(require('../../modules/ratings/services/ratingSnapshot').revision(),beforeJudgeClock,'text judgment cannot invalidate raw vote summary snapshots');
 assert.equal(evidence.factors().get(JSON.stringify([1,'owner'])),1.225);
 assert.equal(evidence.mode(),'active');assert.ok(evidence.revision()>0,'quality/list text revision advances independently');
 const config=await require('../../modules/ratings/services/ratingEstimateAdapter').configuration();assert.equal(config.model.method,'research_full_nonchain');
 const adapter=require('../../modules/ratings/services/ratingEstimateAdapter'),withText=(await adapter.ratingViews([1])).estimates[0];process.env.RATING_TEXT_EVIDENCE_MODE='off';const withoutText=(await adapter.ratingViews([1])).estimates[0];delete process.env.RATING_TEXT_EVIDENCE_MODE;
 assert.ok(withText.average<withoutText.average,'active text evidence reaches the actual public quality adapter');assert.deepEqual(withText.distribution,withoutText.distribution);assert.equal(withText.evidence_count,withoutText.evidence_count,'quality policy never creates another vote');assert.ok(withText.average<=2.4);
 const client=require('../../infrastructure/numericAlgorithmClient');
 const input={config_version:config.config_version,model_hash:config.model.model_hash,calibration_policy:'local-negative-guard-v1',ratings:[{place_id:1,user_id:'a',score:2,text_weight:1.25},{place_id:1,user_id:'b',score:4,text_weight:1}],place_groups:[],text_evidence_policy:evidence.POLICY,text_evidence_mode:'shadow'};
 const shadow=await client.compute('ratingquality',input),active=await client.compute('ratingquality',{...input,text_evidence_mode:'active'}),plain=await client.compute('ratingquality',{...input,text_evidence_policy:undefined,text_evidence_mode:undefined,ratings:input.ratings.map(({text_weight,...r})=>r)});
 assert.deepEqual(shadow.qualities,plain.qualities);assert.deepEqual(shadow.shadow_qualities,active.qualities);assert.ok(active.qualities[0].average<plain.qualities[0].average,'bounded text weights actually affect the numeric service');
 assert.throws(()=>client.validate('ratingquality',{...shadow,text_evidence_policy:undefined},input),e=>e.code==='invalid_response');
 // Pending changes do not publish comments or scores before approval.
 r=await request('POST','/place-requests',{place_id:1,proposed:{description:'烧鸭好吃，等了40分钟，米饭是冷的'},rating:1},'guest');assert.equal(r.status,201,JSON.stringify(r.data));const pendingId=r.data.id;
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM Comment WHERE user_id='guest'").get().n,0);assert.equal(sql.prepare("SELECT COUNT(*) n FROM PlaceRating WHERE user_id='guest'").get().n,0);
 require('../../modules/places/services/placeEditRating').commitEditRating('guest',1,{rating:3});
 r=await request('POST',`/place-requests/${pendingId}/review`,{action:'approve'},'admin');assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(sql.prepare("SELECT score FROM PlaceRating WHERE user_id='guest'").get().score,3,'approval preserves a newer independently submitted vote');
 const attributed=sql.prepare("SELECT c.user_id,r.author_id,r.executor_id FROM Comment c JOIN PlaceRevision r ON r.id=c.place_revision_id WHERE c.user_id='guest'").get();assert.deepEqual(attributed,{user_id:'guest',author_id:'guest',executor_id:'admin'});
 assert.equal((await request('POST',`/place-requests/${pendingId}/review`,{action:'approve'},'admin')).status,409);
 // A correction with no first-hand experience can be submitted without a vote.
 r=await request('PUT','/places/1',{name:'Corrected',no_experience:true},'admin');assert.equal(r.status,200);assert.equal(sql.prepare("SELECT COUNT(*) n FROM PlaceRating WHERE user_id='admin'").get().n,0);
 const comments=await request('GET','/comments/place/1');assert.equal(comments.data.length,3);assert.ok(comments.data.every(c=>c.username));
 const revisions=require('../../modules/places/services/placeRevisions');assert.equal(revisions.backfillEditComments().candidates,0);sql.prepare('DELETE FROM Comment WHERE place_revision_id=?').run(sql.prepare("SELECT id FROM PlaceRevision WHERE path='admin_edit'").get().id);
 assert.equal(revisions.backfillEditComments({apply:true}).inserted,0,'backfill must not resurrect a removed comment');
 sql.prepare("DELETE FROM DeletedEditComment WHERE place_revision_id IN(SELECT id FROM PlaceRevision WHERE path='admin_edit')").run(); // Simulate a pre-feature revision that never had a comment.
 assert.equal(revisions.backfillEditComments({apply:true}).inserted,1);assert.equal(revisions.backfillEditComments({apply:true}).inserted,0,'backfill is idempotent and does not synthesize a vote');
 sql.prepare("UPDATE Place SET moderation_status='pending_review' WHERE id=1").run();assert.deepEqual((await request('GET','/comments/place/1')).data,[]);sql.prepare("UPDATE Place SET moderation_status='visible' WHERE id=1").run();
 // Withdrawal, version change, source deletion and expiry invalidate derived weights.
 sql.prepare("UPDATE RatingStream SET revision=revision+1 WHERE user_id='owner' AND place_id=1").run();assert.equal(evidence.factors().has(JSON.stringify([1,'owner'])),false);
 sql.prepare('DELETE FROM Comment WHERE id=?').run(row.comment_id);evidence.cleanup();assert.equal(sql.prepare('SELECT 1 FROM RatingTextEvidence WHERE comment_id=?').get(row.comment_id),undefined);
 assert.throws(()=>judge.validate({reviews:[{id:'x',applicable:true,information:.8,confidence:1,excerpts:['fabricated']}]},[{id:'x',text:'real'}]));
 assert.equal(judge.multiplier({applicable:true,information:1,confidence:.4}),1);
 assert.equal(judge.multiplier({confidence:1,positive_support:0,negative_support:0,boilerplate:1},4),1,'empty template praise receives no evidence bonus');
 assert.equal(judge.multiplier({confidence:1,positive_support:1,negative_support:0,boilerplate:0},4),1.25,'concrete positive evidence can earn the same bounded bonus');
 assert.equal(judge.multiplier({confidence:1,positive_support:0,negative_support:1,boilerplate:0},1),1.25,'concrete negative evidence is supported symmetrically');
 const failJudge=async()=>{throw new Error('unavailable');},started=Date.now();await evidence.processPending({now:started,evaluate:failJudge});await evidence.processPending({now:started+61000,evaluate:failJudge});await evidence.processPending({now:started+190000,evaluate:failJudge});
 assert.equal(sql.prepare("SELECT status FROM RatingTextEvidence WHERE user_id='guest'").get().status,'failed','three bounded failures stop retries');assert.equal(evidence.factors().has(JSON.stringify([1,'guest'])),false,'failed LLM keeps baseline weight');
 sql.prepare('UPDATE RatingTextEvidence SET expires_at_ms=?').run(started-1);evidence.cleanup(started);assert.equal(sql.prepare('SELECT COUNT(*) n FROM RatingTextEvidence').get().n,0,'derived text evidence expires without deleting public comments');
 // A withdrawal after request submission must never be resurrected at approval.
 const editRating=require('../../modules/places/services/placeEditRating');const intent=editRating.prepareEditRating('admin',1,{rating:4});editRating.commitEditRating('admin',1,{rating:3});sql.prepare("DELETE FROM PlaceRating WHERE user_id='admin'").run();sql.prepare("UPDATE RatingStream SET revision=revision+1 WHERE user_id='admin'").run();editRating.commitEditRating('admin',1,intent);assert.equal(sql.prepare("SELECT 1 FROM PlaceRating WHERE user_id='admin'").get(),undefined);
 const {addedText}=require('../../modules/places/services/placeEditDiff');assert.equal(addedText('old','old'),'');assert.equal(addedText('旧评价','旧评价，烧鸭没熟'),'，烧鸭没熟');assert.equal(addedText('删除这个','删除'),'');
 console.log('Text evidence: atomic edits, own contributions, rating prompts, moderated attribution, versioning, numeric shadow/active contracts, missing text and deletion passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));db._raw.close();assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));fs.rmSync(temp,{recursive:true,force:true});});
