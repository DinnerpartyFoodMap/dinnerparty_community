import assert from 'node:assert/strict';
import { createComputeScheduler } from '../../../src/map/cluster/computeScheduler.js';
import { collectInSlices } from '../../../src/map/cluster/cooperative.js';

let time = 0, serial = 0;
const timers = new Map(), pending = [], started = [], shown = [], errors = [];
const tick = async ms => {
    time += ms;
    for (const [id,t] of [...timers]) if (t.at <= time) { timers.delete(id); t.fn(); }
    await new Promise(setImmediate);
};
const scheduler = createComputeScheduler({
    now:()=>time,
    setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:time+ms});return id;},
    clearTimer:id=>timers.delete(id),
    execute:target=>{started.push(target);return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
    onResult:value=>shown.push(value),onError:error=>errors.push(error)
});
scheduler.submit({kind:'data',dataRevision:1});
await tick(79); assert.equal(started.length,0);
scheduler.submit({kind:'data',dataRevision:2});
await tick(79); assert.equal(started.length,0);
scheduler.submit({kind:'data',dataRevision:3});
await tick(42); assert.equal(started.length,1,'continuous arrivals flush at 200ms');
for(let i=4;i<=100;i++) scheduler.submit({kind:'data',dataRevision:i});
await tick(80);
pending.shift().resolve('obsolete');
await tick(0);
assert.deepEqual(shown,[],'obsolete running result is discarded');
assert.equal(started.length,2,'only latest waiting target runs');
assert.equal(started[1].dataRevision,100);
pending.shift().resolve('latest'); await tick(0);
assert.deepEqual(shown,['latest']);
scheduler.submit({kind:'camera'}); await tick(0);
scheduler.invalidate(); pending.shift().resolve('invalidated');await tick(0);
assert.deepEqual(shown,['latest']);
scheduler.submit({kind:'camera'}); await tick(0);
pending.shift().reject(new Error('worker')); await tick(0);
assert.equal(errors.length,1);
scheduler.submit({kind:'camera'}); await tick(0);
scheduler.destroy();pending.shift().resolve('destroyed');await tick(0);
assert.deepEqual(shown,['latest']);
assert.equal(timers.size,0);

let steps=0, yields=0;
const values=await collectInSlices((function*(){for(let i=0;i<50;i++)yield i;})(), {
    now:()=>steps++,yieldTask:async()=>{yields++;},budgetMs:4
});
assert.equal(values.length,50); assert.ok(yields>1,'slices yield to other tasks');
const abort=new AbortController();abort.abort();
await assert.rejects(collectInSlices([1,2],{signal:abort.signal}),{name:'AbortError'});
console.log('Compute scheduling and cooperative preparation passed');
