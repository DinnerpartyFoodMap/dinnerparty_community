import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../../src/map/cluster/engine.js';
import { buildSnapshot } from '../../../src/map/cluster/snapshot.js';
import { planTransition } from '../../../src/map/cluster/transitions.js';
import { tileOf,lngOf,latOf } from '../../../src/map/markerTiles.js';

const bounds={minLng:119,maxLng:122,minLat:29,maxLat:32};
const snapshot=(engine,zoom,markerBand=null)=>buildSnapshot(engine,{viewBounds:bounds,logicalZoom:zoom,queryMode:'nearby',markerBand});
test('large parent populations retain exact visible split and merge relationships',()=>{
    const engine=createEngine(Array.from({length:50000},(_,i)=>({
        id:i+1,longitude:120+(i%10)*.002,latitude:30+(Math.floor(i/10)%10)*.002
    })));
    const coarse=snapshot(engine,5),fine=snapshot(engine,20);
    assert.equal(coarse.visibleNodes.length,1);
    assert.equal(fine.visibleNodes.length,100);
    let leaves=0,children=0;
    const oldLeaves=engine.index.getLeaves.bind(engine.index),oldChildren=engine.index.getChildren.bind(engine.index);
    engine.index.getLeaves=(...args)=>{leaves++;return oldLeaves(...args);};
    engine.index.getChildren=(...args)=>{children++;return oldChildren(...args);};
    const split=planTransition(coarse,fine);
    assert.equal(split.splitFrom.size,100,'visible descendants cannot disappear because the parent contains 50k members');
    for(const parent of split.splitFrom.values())assert.equal(parent,coarse.visibleNodes[0].key);
    const merge=planTransition(fine,coarse);
    assert.equal(merge.mergeInto.size,100);
    assert.equal(leaves,0);assert.equal(children,0,'transition matching never materializes hidden descendants');
    assert.equal(planTransition(coarse,fine,{descendantBudget:0}).splitFrom.size,0);
});

test('large anonymous tile bands match by bounded cell groups instead of raw member expansion',()=>{
    const [x,y]=tileOf(120,30,9),coarseCell=[9,x,y];
    const coarsePlaces=[],finePlaces=[];
    for(let i=0;i<50000;i++){
        coarsePlaces.push({aggregateKey:'agg:9/'+x+'/'+y+'#'+i,aggregate:true,aggregateCell:coarseCell,
            longitude:lngOf(x+.5,9),latitude:latOf(y+.5,9)});
        const n=i%64,fx=x*8+n%8,fy=y*8+Math.floor(n/8);
        finePlaces.push({aggregateKey:'agg:12/'+fx+'/'+fy+'#'+i,aggregate:true,aggregateCell:[12,fx,fy],
            longitude:lngOf(fx+.5,12),latitude:latOf(fy+.5,12)});
    }
    const a=createEngine(coarsePlaces),b=createEngine(finePlaces);
    const coarse=snapshot(a,7,{kind:'aggregate',tile:2,cell:9,minZoom:0,maxZoom:7});
    const fine=snapshot(b,10,{kind:'aggregate',tile:5,cell:12,minZoom:8,maxZoom:10});
    assert.equal(coarse.visibleNodes.length,1);assert.ok(fine.visibleNodes.length>1);
    a.memberKeys=()=>{throw new Error('raw coarse members expanded');};
    b.memberKeys=()=>{throw new Error('raw fine members expanded');};
    const plan=planTransition(coarse,fine);
    assert.equal(plan.splitFrom.size,fine.visibleNodes.length,'cross-band zoom retains its visible split sources');
    assert.equal(planTransition(fine,coarse).mergeInto.size,fine.visibleNodes.length);
    assert.equal(planTransition(coarse,fine,{memberBudget:0}).splitFrom.size,0,'zero budget does no cell matching');
    const visits={remaining:2};
    const cells=a.cellGroups(coarse.visibleNodes[0],(lng,lat)=>tileOf(lng,lat,9).join('/'),visits,{anonymousOnly:true});
    assert.equal(cells.get(`${x}/${y}`),50000,'a compact cell preserves the complete population');
    assert.equal(visits.remaining,1,'coincident members cost one group visit');
});

test('visible hierarchy agrees with exact members across levels and partial viewports',()=>{
    let seed=91723;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    const places=Array.from({length:1200},(_,i)=>({id:i,longitude:119.9+random()*.3,latitude:29.9+random()*.3}));
    const engine=createEngine(places);
    for(const [from,to] of [[5,12],[10,16],[12,20]]){
        const coarse=snapshot(engine,from);
        const fine=buildSnapshot(engine,{viewBounds:{minLng:120,maxLng:120.1,minLat:30,maxLat:30.1},logicalZoom:to,queryMode:'nearby'});
        const owners=new Map();
        for(const parent of coarse.visibleNodes)for(const key of engine.memberKeys(parent))owners.set(key,parent.key);
        const plan=planTransition(coarse,fine,{descendantBudget:20000});
        const reverse=planTransition(fine,coarse,{descendantBudget:20000});
        for(const child of fine.visibleNodes){
            const members=engine.memberKeys(child),parentKey=owners.get(members[0]);
            assert.ok(members.every(key=>owners.get(key)===parentKey));
            assert.equal(plan.splitFrom.get(child.key)??plan.reuse.get(child.key),parentKey,'split uses its exact visible ancestor');
            assert.equal(reverse.mergeInto.get(child.key)??[...reverse.reuse].find(([,key])=>key===child.key)?.[0],parentKey,'merge uses the same ancestry');
        }
    }
});
