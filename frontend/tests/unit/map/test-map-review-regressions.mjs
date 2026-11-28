import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine,normalizePlaces,dataSignature } from '../../../src/map/cluster/engine.js';
import { createComputeRuntime } from '../../../src/map/cluster/computeRuntime.js';
import { MarkerTileStore,tileOf,lngOf,latOf } from '../../../src/map/markerTiles.js';

test('descendant budget is checked before Supercluster expansion allocates children',()=>{
    const engine=createEngine(Array.from({length:50000},(_,i)=>({id:i+1,longitude:120,latitude:30})));
    const node=engine.query([119,29,121,31],5)[0];
    let visits=0;
    const original=engine.index.getChildren.bind(engine.index);
    engine.index.getChildren=id=>{const result=original(id);visits+=result.length;return result;};
    assert.equal(engine.descendantsAt(node,20,{remaining:4000}),null);
    assert.equal(visits,0,'budget cannot be checked after expanding 50k children');
});

test('index reuse verifies coordinates and indexed anonymous/precision metadata',async()=>{
    const runtime=createComputeRuntime();
    const payload={viewBounds:{minLng:119,maxLng:121,minLat:29,maxLat:31},zoom:12,queryMode:'nearby',
        data:{keys:['place:1','place:2'],coordinates:new Float64Array([120,30,120,30]),aggregates:[true,true],aggregateCells:[[9,1,1],[9,1,1]]}};
    const a=await runtime.handle({op:'compute',dataRevision:1,payload});
    await runtime.handle({op:'commitAck',payload:{snapshotId:a.snapshotId}});
    const b=await runtime.handle({op:'compute',dataRevision:2,payload:{...payload,data:{...payload.data,aggregates:[false,false],aggregateCells:[null,null]}}});
    const info=await runtime.handle({op:'clusterInfo',dataRevision:2,payload:{nodeKey:b.nodes[0].key}});
    assert.equal(info.aggregateOnly,false,'metadata changes cannot reuse stale aggregate properties');
    assert.equal(b.metrics.builds,2);
    const normalized=normalizePlaces([{id:3,longitude:121,latitude:31}]);
    const index=createEngine([{id:1,longitude:120,latitude:30}]);
    index.signature=dataSignature(normalized); // force a full-dataset signature collision
    assert.equal(index.matches(normalized,index.signature),false,'signature equality still requires exact geometry equality');
});

test('queries for newly prepared children resolve within the same data revision',async()=>{
    const runtime=createComputeRuntime();
    const coordinates=new Float64Array(24);
    for(let i=0;i<12;i++){coordinates[i*2]=120+(i<6?-1:1)*0.0003+i*0.0000001;coordinates[i*2+1]=30;}
    const payload={viewBounds:{minLng:119,maxLng:121,minLat:29,maxLat:31},zoom:12,queryMode:'nearby',
        data:{keys:Array.from({length:12},(_,i)=>'place:'+i),coordinates,aggregates:Array(12).fill(false),aggregateCells:Array(12).fill(null)}};
    const a=await runtime.handle({op:'compute',dataRevision:1,payload});
    await runtime.handle({op:'commitAck',payload:{snapshotId:a.snapshotId}});
    const b=await runtime.handle({op:'compute',dataRevision:1,payload:{...payload,data:undefined,zoom:18}});
    assert.equal(b.nodes.length,2);
    const info=await runtime.handle({op:'clusterInfo',dataRevision:1,payload:{nodeKey:b.nodes[0].key}});
    assert.equal(info.aggregateOnly,false);
});

test('tile composition publishes 200k places atomically and yields between slices',async()=>{
    const rows=Array.from({length:200000},(_,i)=>({id:i+1,longitude:120,latitude:30}));
    const [x,y]=tileOf(120,30,12);
    const source={manifest:{levels:[],leaf:{tile:12,minZoom:13}},hashOf:()=> 'h',peek:()=>rows,peekForDisplay:()=>rows,load:()=>Promise.resolve(rows)};
    const store=new MarkerTileStore(source);
    store.setView({bounds:{minLng:lngOf(x+.01,12),maxLng:lngOf(x+.99,12),minLat:latOf(y+.99,12),maxLat:latOf(y+.01,12)},zoom:16});
    let published=false,beats=0;const timer=setInterval(()=>beats++,0);
    try {
        const pending=store.allAsync().then(result=>{published=true;return result;});
        await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(published,false,'partially composed data is never published');
        const list=await pending;
        assert.equal(list.length,200000);assert.ok(beats>1,'composition yields to the event loop');
        assert.equal(await store.allAsync(),list,'unchanged composition retains list identity');
        store.upsert({id:200001,longitude:120,latitude:30});
        const obsolete=store.allAsync();
        store.remove('place:1');
        await assert.rejects(obsolete,{name:'AbortError'});
        const fresh=await store.allAsync();
        assert.equal(fresh.length,200000);
        assert.equal(fresh[0].id,2);
        assert.equal(fresh.at(-1).id,200001,'an obsolete composition cannot overwrite the latest patch');
    } finally {clearInterval(timer);store.dispose();}
});
