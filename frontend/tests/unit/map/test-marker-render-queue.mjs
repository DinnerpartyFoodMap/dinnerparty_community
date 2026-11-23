import assert from 'node:assert/strict';
import { createMarkerRenderQueue } from '../../../src/map/markerRenderQueue.js';

let clock=0, seq=0;
const frames=new Map(), seen=[], finished=[], slices=[];
const frame=()=>{
    const batch=[...frames.values()]; frames.clear();
    for(const callback of batch)callback();
};
const queue=createMarkerRenderQueue({
    now:()=>clock,scheduleFrame:fn=>{frames.set(++seq,fn);return seq;},cancelFrame:id=>frames.delete(id),
    onSlice:metric=>slices.push(metric)
});
const work=Array.from({length:10},(_,i)=>()=>{seen.push(i);clock+=3;});
const first=queue.replace({version:1,operations:work,onComplete:version=>finished.push(version)});
frame();assert.deepEqual(seen,[0,1],'work yields after the 4ms soft budget');
const second=queue.replace({version:2,operations:[()=>seen.push('new')],onComplete:version=>finished.push(version)});
assert.equal(await first,false);
frame();assert.equal(await second,true);
assert.deepEqual(finished,[2]);assert.deepEqual(seen,[0,1,'new']);
const third=queue.replace({version:3,operations:Array.from({length:9},()=>()=>seen.push('batch'))});
frame();assert.equal(seen.filter(x=>x==='batch').length,4,'even cheap operations have a bounded batch');
queue.pause();frame();assert.equal(frames.size,0);
queue.resume();frame();frame();assert.equal(await third,true);
const fourth=queue.replace({version:4,operations:work});
queue.destroy();queue.destroy();frame();assert.equal(await fourth,false);
assert.equal(frames.size,0);assert.ok(slices.length>0);
console.log('Cancelable marker rendering budgets passed');
