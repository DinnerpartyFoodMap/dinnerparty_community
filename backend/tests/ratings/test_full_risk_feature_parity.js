const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {buildFullFeatures}=require('../../modules/ratings/services/fullModelFeatures');
const dir=process.env.JOURNEY_PRIVATE_SERVICE_DIR;
if(!dir){console.log('Full risk feature parity skipped: private fixture directory is unset.');process.exit(0);}
const fixturePath=path.join(dir,'tests/data/full-risk-feature-parity.json');
if(!fs.existsSync(fixturePath)){console.log('Full risk feature parity skipped: full training fixture is not available.');process.exit(0);}
const f=JSON.parse(fs.readFileSync(fixturePath)),contract=JSON.parse(fs.readFileSync(path.join(dir,'models/research-full-nonchain-v2/risk-feature-contract.json')));
const diffs=[];
for(const block of f.cases){
 const profiles=new Map(block.places.map(p=>[p.id,{categories:[p.style],price_level:p.price_bucket,description_embedding:p.description_embedding}]));
 const ratings=block.ratings.map(r=>({...r,score:1+3*(r.native5-1)/4}));
 const builder=buildFullFeatures({places:block.places,ratings,profiles,viewerId:block.viewer_id,asOf:block.as_of_ms,contract,candidateCount:block.expected.length});
 for(const row of block.expected){const actual=builder.featureFor(row.place_id);for(const [key,value]of Object.entries(row.features)){const a=actual[key];if(value===null?a!==null:!Number.isFinite(a)||Math.abs(a-value)>1e-4)diffs.push({n:block.risk_n,place_id:row.place_id,key,expected:value,actual:a});}}
}
assert.equal(diffs.length,0,JSON.stringify(diffs.slice(0,25)));
console.log('Full P86 risk feature Python/Node parity passed for first1/3/5 and original time-ordered rater effects.');
