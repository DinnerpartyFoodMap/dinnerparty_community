const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-features-'));
Object.assign(process.env,{DB_FILE:path.join(temp,'test.sqlite'),LOG_TO_FILE:'false',LOG_TO_CONSOLE:'false'});
const {createFeatures,axes}=require('../../modules/ratings/services/bootstrapFeatures');
assert.deepEqual(axes({category:'Restaurant'}),[0,0,0,0,0,0]);
assert.deepEqual(axes({category:'Chinese restaurant'}),[1,0,0,0,0,0]);
assert.deepEqual(axes({category:'咖啡厅'}),[0,0,0,0,1,0]);
const places=[{id:1,category:'Chinese restaurant',latitude:0,longitude:0},{id:2,category:'Coffee shop',latitude:0,longitude:1},{id:3,category:'Restaurant',latitude:0,longitude:2}];
const ratings=[{place_id:1,user_id:'u',score:4,created_at:10},{place_id:2,user_id:'v',score:1,created_at:20},{place_id:2,user_id:'w',score:2,created_at:30},{place_id:3,user_id:'x',score:3,created_at:40},{place_id:1,user_id:'future',score:1,created_at:101}];
const feature=createFeatures(places,ratings,'u',100)(2);
assert.equal(feature.log_n,Math.log1p(2));assert.equal(feature.mean_norm,1/6);assert.equal(feature.var_norm,1/36);assert.equal(feature.low_share,1);assert.equal(feature.high_share,0);
assert.equal(feature.chain_log,null);assert.equal(feature.category_affinity,0);
assert.ok(Math.abs(feature.category_lift-Math.log(0.05/0.55))<1e-12,'global share weights review frequency and retains unknown reviews in denominator');
assert.equal(createFeatures(places,ratings,null,100)(3).category_affinity,null,'missing user history remains missing');
assert.equal(createFeatures(places,ratings,'u',100)(1).history_log_n,0,'candidate own rating excluded from preference history');
// More than 50 reviews: preference classes use the last 50; home uses every
// historical coordinate. Old reviews must not disappear from the home median.
const many=Array.from({length:61},(_,i)=>({id:i+10,category:'Chinese restaurant',latitude:0,longitude:i<31?0:10}));
many.push({id:99,category:'Coffee shop',latitude:0,longitude:1});
const history=many.slice(0,61).map((p,i)=>({place_id:p.id,user_id:'u',score:4,created_at:i+1}));
const far=createFeatures(many,history,'u',100)(99);
assert.ok(Math.abs(far.home_distance_log-Math.log1p(6371*Math.PI/180))<1e-12,'home median includes reviews older than the last50');
console.log('Bootstrap portable features passed: scale, weighted categories, missing data, target exclusion, future cutoff and full-history home.');
require('../../infrastructure/database').db._raw.close();fs.rmSync(temp,{recursive:true,force:true});
