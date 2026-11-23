import assert from 'node:assert/strict';
import { createComputeRuntime } from '../../../src/map/cluster/computeRuntime.js';
import { createWorkerClient } from '../../../src/map/cluster/workerClient.js';

const runtime = createComputeRuntime();
let seq=0;
const points={ keys:['place:1','place:2'],coordinates:new Float64Array([120,30,120.00001,30]),aggregateCells:[null,null],aggregates:[false,false] };
const view={viewBounds:{minLng:119,maxLng:121,minLat:29,maxLat:31},zoom:12,queryMode:'nearby',markerBand:null};
const request=(op,payload={},extra={})=>runtime.handle({op,requestId:++seq,dataRevision:1,viewRevision:seq,payload,...extra});
const a=await request('compute',{...view,data:points});
assert.equal(a.nodes.reduce((n,x)=>n+x.count,0),2);
assert.equal(a.metrics.builds,1);
assert.ok(Math.abs(a.metrics.prepareMs+a.metrics.indexMs+a.metrics.queryMs+a.metrics.transitionMs-a.metrics.ms)<0.01,
    'worker phase durations must not count index construction twice');
assert.equal(a.plan.kind,'initial');
const dropped=await request('compute',{...view,zoom:13});
assert.equal(dropped.plan.kind,'initial','unacknowledged result cannot be a transition baseline');
await request('commitAck',{snapshotId:a.snapshotId});
// An ack that was superseded cannot advance the baseline.
const b=await request('compute',{...view,zoom:14});
assert.equal(b.plan.kind,'initial');
await request('commitAck',{snapshotId:b.snapshotId});
const c=await request('compute',{...view,zoom:16},{baseSnapshotId:b.snapshotId});
assert.notEqual(c.plan.kind,'initial');
assert.equal(c.metrics.builds,1,'camera changes reuse the index');
const cluster=b.nodes.find(x=>x.kind==='cluster');
const info=await request('clusterInfo',{nodeKey:cluster.key});
assert.equal(info.aggregateOnly,false); assert.ok(info.expansionZoom>12);
const members=await request('members',{nodeKey:cluster.key});
assert.deepEqual(members.keys,['place:1','place:2']);
const reveal=await request('reveal',{place:{id:1,longitude:120,latitude:30},baseZoom:16,maxZoom:20});
assert.ok(reveal.zoom>=16);
await assert.rejects(request('clusterInfo',{nodeKey:cluster.key},{dataRevision:999}),{code:'STALE_DATA'});
await request('dispose');
await assert.rejects(request('clusterInfo',{nodeKey:cluster.key}),{code:'STALE_DATA'});
let fatals=0, posts=0;
const transport={postMessage:()=>{posts++;},terminate(){}};
const client=createWorkerClient({createWorker:()=>transport,onFatal:()=>{fatals++;}});
try {
    const pending=client.request('compute',{});
    transport.onerror({message:'fixture failure',preventDefault(){}});
    await assert.rejects(pending,{code:'WORKER_FAILED'});
    assert.equal(fatals,1,'idle or obsolete worker failures notify the owner immediately');
    const next=client.request('compute',{});next.catch(()=>{});
    assert.equal(posts,1,'a failed transport never queues work that will only time out');
    await assert.rejects(next,{code:'WORKER_FAILED'});
} finally {client.destroy();}
console.log('Worker computation protocol and acknowledged baselines passed');
