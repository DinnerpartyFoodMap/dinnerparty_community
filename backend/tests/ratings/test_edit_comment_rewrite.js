// Edit records keep only the text added to the description; the rewrite script
// converts records written in the old "字段：旧 → 新" format.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'edit-comment-rewrite-'));
const file=path.join(temp,'test.sqlite');
Object.assign(process.env,{DB_FILE:file,LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');
const script=path.join(__dirname,'../../scripts/ratings/rewrite_edit_comments.js');
const run=(...args)=>{const r=spawnSync(process.execPath,[script,'--db',file,...args],{encoding:'utf8',env:{...process.env,DB_FILE:''}});assert.equal(r.status,0,r.stderr);return r.stdout;};
try{
 init();const sql=db._raw;
 sql.prepare("INSERT INTO User(id,username,password) VALUES('owner','owner','unused')").run();
 sql.prepare("INSERT INTO Place(id,name,category,description,creator_id,moderation_status) VALUES(1,'店','粤菜','烧鸭好吃','owner','visible')").run();
 const {recordPlaceRevision,backfillEditComments}=require('../../modules/places/services/placeRevisions');
 const place=()=>sql.prepare('SELECT * FROM Place WHERE id=1').get();
 const edit=(changes)=>{const before=place();sql.prepare(`UPDATE Place SET ${Object.keys(changes).map(k=>k+'=?').join(',')} WHERE id=1`).run(...Object.values(changes));return recordPlaceRevision({placeId:1,authorId:'owner',path:'owner_edit',before,after:place()});};
 const commentFor=id=>sql.prepare('SELECT content FROM Comment WHERE place_revision_id=?').pluck().get(id);
 // New edits: only the added description text; nothing for other fields.
 const added=edit({description:'烧鸭好吃，等了40分钟'});assert.equal(commentFor(added),'等了40分钟');
 const renamed=edit({name:'新店名'});assert.equal(commentFor(renamed),undefined,'a rename adds no description text');
 const removed=edit({description:'烧鸭好吃'});assert.equal(commentFor(removed),undefined,'deleting text adds nothing');
 const rewritten=edit({description:'**招牌**烧鸭好吃，米饭是冷的'});assert.equal(commentFor(rewritten),'招牌 … 米饭是冷的','Markdown is compared as plain text');
 assert.deepEqual(backfillEditComments(),{apply:false,candidates:0},'revisions without added text are not backfill candidates');

 // Records in the old format.
 sql.prepare('UPDATE Comment SET content=? WHERE place_revision_id=?').run('描述：烧鸭好吃 → 烧鸭好吃，等了40分钟',added);
 sql.prepare('INSERT INTO Comment(place_id,user_id,content,place_revision_id) VALUES(1,?,?,?)').run('owner','店名：店 → 新店名',renamed);
 const total=()=>sql.prepare('SELECT COUNT(*) FROM Comment').pluck().get();
 let out=run();
 assert.match(out,/地点修改记录 3 条：1 条改成只含新增的描述文字，1 条没有新增描述文字/);assert.match(out,/这是预览，未写库/);
 assert.equal(commentFor(added),'描述：烧鸭好吃 → 烧鸭好吃，等了40分钟','preview writes nothing');
 out=run('--apply');assert.match(out,/数据库已备份/);assert.match(out,/已改写 1 条/);
 assert.ok(fs.readdirSync(temp).some(name=>name.includes('.pre-edit-comment-rewrite-')),'backup next to the database');
 assert.equal(commentFor(added),'等了40分钟');assert.equal(commentFor(renamed),'店名：店 → 新店名','records without added text are kept by default');assert.equal(total(),3);
 out=run('--apply','--delete-empty');assert.match(out,/已改写 0 条，已删除 1 条/);
 assert.equal(commentFor(renamed),undefined);assert.equal(total(),2);
 assert.ok(sql.prepare('SELECT 1 FROM DeletedEditComment WHERE place_revision_id=?').get(renamed),'deleted records are not backfilled again');
 assert.match(run('--apply','--delete-empty'),/没有需要改的记录/,'idempotent');
 console.log('Edit comments: only added description text, no record without it, old records rewritten by the script.');
}catch(error){console.error(error);process.exitCode=1;}
finally{db._raw.close();fs.rmSync(temp,{recursive:true,force:true});}
