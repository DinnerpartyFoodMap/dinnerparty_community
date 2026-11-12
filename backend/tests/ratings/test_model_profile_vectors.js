// Model profile embeddings are float32 BLOB columns. Rows written by older
// builds (vectors as JSON arrays inside assets) are moved once at startup,
// losslessly, and the freed space is vacuumed.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'profile-vectors-'));
const file=path.join(temp,'test.sqlite');
Object.assign(process.env,{DB_FILE:file,LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {db,init}=require('../../infrastructure/database');
const profiles=require('../../modules/ratings/services/modelProfiles');
const {buildFullFeatures}=require('../../modules/ratings/services/fullModelFeatures');
const connections=[];
function open(){const connection=new Database(file);connection.pragma('foreign_keys = ON');connections.push(connection);return connection;}
function float32Vector(seed){let x=seed;return Array.from({length:1024},()=>{x=(x*1103515245+12345)%2147483648;return Math.fround(x/2147483648-.5);});}
const revision=sql=>sql.prepare('SELECT revision FROM AlgorithmClock WHERE id=1').get().revision;
try{
 init();const sql=db._raw;
 sql.prepare("INSERT INTO User(id,username,password) VALUES('owner','owner','unused')").run();
 const model={model_hash:'a'.repeat(64)},stale={model_hash:'b'.repeat(64)},broken={model_hash:'c'.repeat(64)},failed={model_hash:'d'.repeat(64)};
 const legacy=[];
 // Enough legacy rows that the move frees over a quarter of the file.
 for(let id=1;id<=40;id++){
  sql.prepare("INSERT INTO Place(id,name,category,description,creator_id,moderation_status) VALUES(?,?,'其他','简介','owner','visible')").run(id,'店铺'+id);
  const description=float32Vector(id),review=id%2?float32Vector(1000+id):null;
  const assets={ds:[7],rv:review?[4]:null,categories:['Restaurant'],flags:[1],price_level:2,review_count:review?1:0,profile_schema_version:1,description_embedding:description,review_embedding:review,description_projected:[.1],review_projected:review?[.2]:null,risk_description_projected:[.3]};
  legacy.push({id,description,review,assets});
  sql.prepare(`INSERT INTO PlaceModelProfile(place_id,model_hash,input_hash,schema_version,status,assets,attempts,retry_at,updated_at,extraction_version) VALUES(?,?,?,1,'ready',?,0,0,0,3)`).run(id,model.model_hash,profiles.inputHash(profiles.inputFor(id,sql)),JSON.stringify(assets));
 }
 // An older build rewrote this row after the move: its JSON key is newer than the stale BLOB.
 sql.prepare(`INSERT INTO PlaceModelProfile(place_id,model_hash,input_hash,schema_version,status,assets,description_embedding,review_embedding,updated_at) VALUES(1,?,'x',1,'ready',?,?,?,0)`)
  .run(stale.model_hash,JSON.stringify({ds:[7],review_count:0,description_embedding:[.5,.25],review_embedding:null}),Buffer.alloc(8),Buffer.alloc(8));
 sql.prepare(`INSERT INTO PlaceModelProfile(place_id,model_hash,input_hash,schema_version,status,assets,updated_at) VALUES(1,?,'x',1,'ready','{"description_embedding":[1,',0)`).run(broken.model_hash);
 sql.prepare(`INSERT INTO PlaceModelProfile(place_id,model_hash,input_hash,schema_version,status,updated_at) VALUES(1,?,'x',1,'failed',0)`).run(failed.model_hash);
 const before=revision(sql);
 sql.pragma('wal_checkpoint(TRUNCATE)');const sizeBefore=fs.statSync(file).size;

 // Startup schema on a new connection performs the one-time move.
 const migrated=open();profiles.initModelProfileSchema(migrated);
 assert.equal(migrated.prepare(`SELECT count(*) FROM PlaceModelProfile WHERE instr(assets,'_embedding":')>0`).pluck().get(),1,'only the malformed JSON row is left untouched');
 assert.equal(migrated.pragma('freelist_count',{simple:true}),0,'freed pages are vacuumed');
 // ~1.3 MB of JSON vector text becomes ~0.24 MB of float32; the rest is the empty schema.
 assert.ok(sizeBefore-fs.statSync(file).size>768*1024,`file shrinks (${sizeBefore} -> ${fs.statSync(file).size} bytes)`);
 assert.ok(revision(migrated)>before,'moved vectors invalidate cached scores once');
 const read=profiles.readProfiles(legacy.map(p=>({id:p.id})),model,migrated);
 assert.equal(read.size,legacy.length);
 for(const p of legacy){
  const assets=read.get(p.id);
  assert.ok(assets.description_embedding instanceof Float32Array);
  assert.deepEqual(Array.from(assets.description_embedding),p.description,'float32 storage is exact');
  if(p.review)assert.deepEqual(Array.from(assets.review_embedding),p.review);else assert.equal(assets.review_embedding,null);
  const {description_embedding,review_embedding,...rest}=p.assets;
  for(const [key,value]of Object.entries(rest))assert.deepEqual(assets[key],value,'other assets are unchanged: '+key);
 }
 const staleRow=migrated.prepare('SELECT assets,description_embedding,review_embedding FROM PlaceModelProfile WHERE model_hash=?').get(stale.model_hash);
 assert.deepEqual(JSON.parse(staleRow.assets),{ds:[7],review_count:0});
 assert.deepEqual([staleRow.description_embedding.readFloatLE(0),staleRow.description_embedding.readFloatLE(4)],[.5,.25],'JSON written by an older build wins over stale BLOBs');
 assert.equal(staleRow.review_embedding,null);
 assert.equal(migrated.prepare('SELECT assets FROM PlaceModelProfile WHERE model_hash=?').pluck().get(failed.model_hash),null);

 // The move runs once; a later startup changes nothing.
 const settled=revision(migrated),again=open();profiles.initModelProfileSchema(again);
 assert.equal(revision(again),settled,'an already moved database is not rewritten');

 // Feature values are identical whether the vector is a float32 BLOB or the old JSON array.
 const places=legacy.slice(0,6).map(p=>({id:p.id,category:'其他'}));
 const ratings=[1,2,3,4,5].map(id=>({place_id:id,user_id:'viewer',score:3,created_at:id}));
 const transform={mean:new Array(1024).fill(.01),components:[float32Vector(77)],sd:[2]};
 const contract={transforms:{description:transform,risk_description:transform}};
 const strip=assets=>{const {description_projected,risk_description_projected,...rest}=assets;return rest;};
 const fromBlob=new Map(places.map(p=>[p.id,strip(read.get(p.id))])),fromJson=new Map(legacy.slice(0,6).map(p=>[p.id,strip(p.assets)]));
 const features=profilesMap=>buildFullFeatures({places,ratings,profiles:profilesMap,viewerId:'viewer',asOf:10,contract}).featureFor(6);
 const a=features(fromBlob),b=features(fromJson);
 for(const key of ['d_pc0','dsc0','u_desc_cos','u_desc_max'])assert.equal(a[key],b[key],key);
 assert.ok(Number.isFinite(a.u_desc_cos)&&Number.isFinite(a.d_pc0));
 console.log('Model profile vectors passed: float32 BLOB columns, lossless one-time move, VACUUM and identical features.');
}catch(error){console.error(error);process.exitCode=1;}
finally{for(const connection of connections)connection.close();db._raw.close();fs.rmSync(temp,{recursive:true,force:true});}
