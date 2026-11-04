const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'visit-test-'));
Object.assign(process.env,{DB_FILE:path.join(tmp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');
try{
 init();db._raw.prepare("INSERT INTO User(id,username,password) VALUES('u','u','unused')").run();
 db._raw.prepare("INSERT INTO Place(id,name,creator_id,moderation_status) VALUES(1,'p','u','visible')").run();
 db._raw.prepare("UPDATE MapConsent SET feedback=1 WHERE user_id='u'").run();
 const v=require('../../modules/places/services/placeVisitEvidence'),now=Date.now(),view=v.view('u',1,now);
 const proof={view_id:view.id,first_fix_at:now,last_fix_at:now+660000,fix_count:12,max_gap_ms:60000,rule_version:'visit-50m-10min-v1',distance_band:'within_50m',accuracy_band:'within_25m'};
 assert.throws(()=>v.infer('u',1,{...proof,fix_count:2},now+660000));
 const e=v.infer('u',1,proof,now+660000);assert.equal(e.prompt,true);
 assert.throws(()=>v.answer('other',1,e.id,'yes',now+660000));
 v.answer('u',1,e.id,'yes',now+660000);
 assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRating').get().n,0,'visit is not a rating');
 assert.equal(v.infer('u',1,proof,now+660000).prompt,false,'no repeated invitation');
 assert.throws(()=>v.answer('u',1,e.id,'no',now+660001));
 const movedView=v.view('u',1,now+700000);
 db._raw.prepare('UPDATE Place SET latitude=32,longitude=122 WHERE id=1').run();
 assert.throws(()=>v.infer('u',1,{...proof,view_id:movedView.id,first_fix_at:now+700000,last_fix_at:now+1360000},now+1360000),'moving the marker invalidates previous geometry');
 db._raw.prepare("INSERT INTO Place(id,name,creator_id,moderation_status,latitude,longitude) VALUES(2,'neighbor','u','visible',32.0001,122)").run();
 const fresh=v.view('u',1,now+1400000);v.view('u',2,now+1400000);
 assert.equal(v.infer('u',1,{...proof,view_id:fresh.id,first_fix_at:now+1400000,last_fix_at:now+2060000},now+2060000).ambiguous,true,'overlapping viewed stores cannot be identified from proximity');
 console.log('Visit confirmation tests passed');
}finally{db._raw.close();fs.rmSync(tmp,{recursive:true,force:true});}
