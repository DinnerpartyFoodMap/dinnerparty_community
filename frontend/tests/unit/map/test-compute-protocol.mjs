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

// An ordinary settled camera request must finish inherited anchor refinement
// even when every intermediate `refine` request was discarded.
{
    const runtime=createComputeRuntime();
    const anchor=[113.2662964,23.075],exact=[113.264,23.075];
    const x=Math.floor((anchor[0]+180)/360*2**14);
    const sin=Math.sin(anchor[1]*Math.PI/180);
    const y=Math.floor((.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*2**14);
    const base={viewBounds:{minLng:113,maxLng:114,minLat:23,maxLat:24},queryMode:'nearby'};
    const aggregate={kind:'aggregate',tile:8,cell:14,minZoom:0,maxZoom:12};
    const leaf={kind:'leaf',tile:12,minZoom:13};
    const input=(key,coordinate,cell=null)=>({keys:[key],coordinates:new Float64Array(coordinate),aggregateCells:[cell],aggregates:[!!cell]});
    const compute=(payload,dataRevision=2)=>runtime.handle({op:'compute',dataRevision,payload:{...base,...payload}});
    const ack=snapshot=>runtime.handle({op:'commitAck',payload:{snapshotId:snapshot.snapshotId}});
    const coarse=await compute({zoom:12,markerBand:aggregate,data:input(`agg:14/${x}/${y}#0`,anchor,[14,x,y])},1);await ack(coarse);
    const named=await compute({zoom:13,markerBand:leaf,data:input('place:1',exact)});await ack(named);
    assert.deepEqual(named.nodes[0].coordinate,coarse.nodes[0].coordinate,'new names keep the displayed anchor at the band switch');
    const partial=await compute({zoom:13.1,markerBand:leaf});await ack(partial);
    assert.ok(partial.nodes[0].coordinate[0]<anchor[0]&&partial.nodes[0].coordinate[0]>exact[0],
        'final camera work advances coordinates without an intermediate refine flag');
    const pan=await compute({zoom:13.1,markerBand:leaf});await ack(pan);
    assert.deepEqual(pan.nodes[0].coordinate,partial.nodes[0].coordinate,'stationary updates retain the displayed position');
    const out=await compute({zoom:13.05,markerBand:leaf});await ack(out);
    assert.deepEqual(out.nodes[0].coordinate,partial.nodes[0].coordinate,'zooming out does not advance or rewind precision');
    await compute({zoom:14,markerBand:leaf}); // superseded, never acknowledged
    const latest=await compute({zoom:13.2,markerBand:leaf});await ack(latest);
    const expected=anchor[0]+(exact[0]-anchor[0])*.8;
    assert.ok(Math.abs(latest.nodes[0].coordinate[0]-expected)<1e-7&&latest.nodes[0].sourceCoordinate,
        'a discarded higher-zoom candidate cannot leak its completed refinement into a newer lower target');
    const final=await compute({zoom:14,markerBand:leaf});await ack(final);
    assert.ok(final.nodes[0].coordinate.every((value,i)=>Math.abs(value-exact[i])<1e-7),'continued zoom releases the inherited anonymous coordinate');
    assert.equal(final.nodes[0].sourceCoordinate,undefined);
    assert.equal(final.logicalZoom,14,'coordinate refinement preserves normal topology changes');
}
// Snapshots sent but never confirmed (their reconciliation was cut short) may
// still be partly on screen; the web layer asks for their destinations too.
{
    const runtime=createComputeRuntime();
    const keys=[],coordinates=[];
    for(let group=0;group<4;group++)for(const [dx,dy] of [[0,0],[0.0003,0],[0,0.0003]]){
        keys.push('place:'+(keys.length+1));coordinates.push(120+group*0.004+dx,30+dy);
    }
    const data={keys,coordinates:new Float64Array(coordinates),aggregateCells:keys.map(()=>null),aggregates:keys.map(()=>false)};
    const base={viewBounds:{minLng:119.99,maxLng:120.03,minLat:29.99,maxLat:30.01},queryMode:'nearby',markerBand:null,orphans:true};
    const compute=payload=>runtime.handle({op:'compute',dataRevision:1,payload:{...base,...payload}});
    const fine=await compute({zoom:20,data});
    await runtime.handle({op:'commitAck',payload:{snapshotId:fine.snapshotId}});
    assert.equal((await compute({zoom:20})).orphanPlan,null,'a confirmed baseline leaves no orphans');
    const mid=await compute({zoom:17}); // superseded before its reconciliation finished
    const coarse=await compute({zoom:13});
    assert.equal(coarse.plan.kind,'zoom-out','the main plan still starts from the confirmed snapshot');
    const top=coarse.nodes[0].key;
    assert.deepEqual(coarse.orphanPlan.mergeInto,new Map(mid.nodes.map(node=>[node.key,top])),
        'clusters of the unconfirmed snapshot merge into the new cluster');
    assert.equal((await compute({zoom:13,orphans:false})).orphanPlan,null,'only requested when the caller renders orphans');
    await runtime.handle({op:'commitAck',payload:{snapshotId:(await compute({zoom:13})).snapshotId}});
    assert.equal((await compute({zoom:13})).orphanPlan,null,'a confirmation clears the unconfirmed snapshots');
}
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
