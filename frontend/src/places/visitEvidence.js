// Foreground-only, ephemeral evidence. No coordinates leave this state machine.
export function createVisitEvidence({radius=50,dwellMs=600000,maxGapMs=90000,minSamples=11}={}){
 let samples=[],lastStamp=null;
 const reset=()=>{samples=[];lastStamp=null;};
 return {reset,observe(place,fix,now=Date.now()){
  if(!place||!fix||!Number.isFinite(fix.timestamp)||fix.timestamp>now||now-fix.timestamp>15000||fix.timestamp===lastStamp||fix.source==='ip'||fix.coordSystem!=='GCJ-02'||!(fix.accuracy>0&&fix.accuracy<=25))return null;
  const rad=Math.PI/180,dy=(fix.lat-place.latitude)*rad,dx=(fix.lng-place.longitude)*rad;
  const a=Math.sin(dy/2)**2+Math.cos(place.latitude*rad)*Math.cos(fix.lat*rad)*Math.sin(dx/2)**2;
  const distance=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  if(!Number.isFinite(distance)||distance+fix.accuracy>radius){reset();return null;}
  if(samples.length&&fix.timestamp-samples.at(-1)>maxGapMs)reset();
  if(lastStamp!==null&&fix.timestamp<=lastStamp)return null;
  lastStamp=fix.timestamp;samples.push(fix.timestamp);
  if(samples.length>minSamples+10)samples.shift();
  if(samples.length<minSamples||samples.at(-1)-samples[0]<=dwellMs)return null;
  return {first_fix_at:samples[0],last_fix_at:samples.at(-1),fix_count:samples.length,max_gap_ms:Math.max(...samples.slice(1).map((x,i)=>x-samples[i])),rule_version:'visit-50m-10min-v1',distance_band:'within_50m',accuracy_band:'within_25m'};
 }};
}
