const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {buildFullFeatures}=require('../../modules/ratings/services/fullModelFeatures');
const dir=process.env.JOURNEY_PRIVATE_SERVICE_DIR;
if(!dir){console.log('Full feature parity skipped: private fixture directory is unset.');process.exit(0);}
for(const [name,file]of [['research-full-nonchain-v2','full-feature-parity.json'],['research-full-nonchain-4b-v3','full-feature-parity-4b.json']]){
const fixturePath=path.join(dir,'tests/data',file);
if(!fs.existsSync(fixturePath)){console.log(`Full feature parity skipped: ${name} fixture is not available.`);continue;}
const f=JSON.parse(fs.readFileSync(fixturePath)),contract=JSON.parse(fs.readFileSync(path.join(dir,'models',name,'feature-contract.json')));
const profiles=new Map(f.places.map(p=>[p.id,{ds:p.ds,rv:p.rv,categories:p.categories,price_level:p.price_bucket,flags:contract.flags.map(key=>p.flags[key]),description_embedding:p.description_embedding,review_embedding:p.review_embedding}]));
const ratings=f.ratings.map(r=>({...r,score:1+3*(r.native5-1)/4}));
const builder=buildFullFeatures({places:f.places,ratings,profiles,viewerId:f.viewer_id,asOf:f.as_of_ms,contract,candidateCount:f.expected.length});
const diffs=[];for(const row of f.expected){const actual=builder.featureFor(row.place_id);for(const [key,value]of Object.entries(row.features)){const a=actual[key];if(value===null?a!==null:!Number.isFinite(a)||Math.abs(a-value)>1e-4)diffs.push({place_id:row.place_id,key,expected:value,actual:a});}}
assert.equal(diffs.length,0,JSON.stringify(diffs.slice(0,25)));
console.log(`${name}: full feature Python/Node parity passed for every original P93 non-chain feature on synthetic histories.`);
}
