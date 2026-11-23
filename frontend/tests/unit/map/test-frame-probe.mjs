import assert from 'node:assert/strict';
const callbacks=new Map();let sequence=0;
globalThis.performance={now:()=>0};
globalThis.window={
    requestAnimationFrame:fn=>{callbacks.set(++sequence,fn);return sequence;},
    cancelAnimationFrame:id=>callbacks.delete(id),localStorage:{getItem:()=>null}
};
const {startFrameProbe}=await import('../../../src/motion/policy.js');
const stop=startFrameProbe();
for(const now of [100,116,132,148,164,180,196]){
    const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback(now);
}
const measured=stop();
assert.equal(measured.max,100,'the first blocked frame is part of the loading metric');
assert.equal(measured.frames,7);assert.equal(callbacks.size,0);
console.log('Initial-frame performance sampling passed');
