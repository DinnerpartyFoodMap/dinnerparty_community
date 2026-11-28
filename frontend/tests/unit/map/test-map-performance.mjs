import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tileKeysForBounds, MarkerTileStore } from '../../../src/map/markerTiles.js';
import { createEngine } from '../../../src/map/cluster/engine.js';
import { buildSnapshot } from '../../../src/map/cluster/snapshot.js';
import { planTransition, verifySnapshotMembers } from '../../../src/map/cluster/transitions.js';

// An unbounded enumeration exhausts this heap before it can return its 48 keys.
const tileModule = new URL('../../../src/map/markerTiles.js', import.meta.url).href;
const child = spawnSync(process.execPath, [
    '--max-old-space-size=64', '--import', './scripts/support/json-modules.mjs',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e',
    `import { tileKeysForBounds } from ${JSON.stringify(tileModule)};
     const keys = tileKeysForBounds({ minLng:-180,maxLng:180,minLat:-85,maxLat:85 }, 12);
     if (keys.length !== 48 || new Set(keys).size !== 48) process.exit(2);`
], { encoding: 'utf8', timeout: 15000, windowsHide:true });
assert.equal(child.status, 0, 'world query must fit in a 64MB heap: ' + child.stderr?.slice(-150));
for (const bounds of [
    { minLng: -1, maxLng: 1, minLat: -1, maxLat: 1 },
    { minLng: 110, maxLng: 120, minLat: 20, maxLat: 40 }
]) {
    const all = tileKeysForBounds(bounds, 5, 1024);
    assert.deepEqual(tileKeysForBounds(bounds, 5, 3), all.slice(0, 3));
}
assert.deepEqual(tileKeysForBounds({ minLng:0,maxLng:1,minLat:0,maxLat:1 }, 12, 0), []);

// An expired patch must not make the displayed leaf band use the target's bounds.
let now = 0;
const originalBounds = { minLng:113.26,maxLng:113.27,minLat:23.12,maxLat:23.14 };
const originalKeys = new Set(tileKeysForBounds(originalBounds, 12));
const row = { id:1,name:'original',longitude:113.2644,latitude:23.1291 };
const source = {
    manifest: { levels:[{tile:2,cell:9,minZoom:0,maxZoom:7}],leaf:{tile:12,minZoom:13} },
    hashOf: () => 'hash',
    peek: (z,key) => z === 12 && originalKeys.has(key) ? [row] : undefined,
    peekForDisplay: (z,key) => source.peek(z,key),
    load: () => new Promise(() => {})
};
const store = new MarkerTileStore(source, { now:()=>now,patchTtlMs:10,switchWaitMs:1 });
store.setView({ bounds:originalBounds,zoom:16 });
store.upsert({ ...row,name:'patch' });
assert.equal(store.all()[0].name, 'patch');
now = 11;
store.setView({ bounds:{minLng:0,maxLng:120,minLat:0,maxLat:40},zoom:5 });
assert.deepEqual(store.all().map(p=>p.id), [1], 'pending band retains displayed coverage after patch expiration');
store.dispose();

// Signature equality must not bypass the whole-transition member budget.
const places = Array.from({length:50000}, (_,i)=>({id:i+1,longitude:120,latitude:30}));
const a = createEngine(places);
const b = createEngine([...places,{id:999999,longitude:-100,latitude:0}]);
const input = {viewBounds:{minLng:119,maxLng:121,minLat:29,maxLat:31},logicalZoom:7,queryMode:'nearby'};
const prev = buildSnapshot(a,input), next = buildSnapshot(b,input);
let memberVisits = 0;
for (const engine of [a,b]) {
    const original = engine.memberKeys.bind(engine);
    engine.memberKeys = node => { memberVisits += node.count; return original(node); };
}
const plan = planTransition(prev,next,{memberBudget:0});
assert.equal(memberVisits, 0, 'zero budget never materializes members');
assert.equal(plan.reuse.size, 0);
assert.equal(plan.enter.length, 1);
assert.equal(plan.exit.length, 1);
for (const budget of [1,100,1000,6000]) {
    memberVisits = 0;
    planTransition(prev,next,{memberBudget:budget});
    assert.ok(memberVisits<=budget,'all cross-generation phases share the member budget');
}
assert.deepEqual(verifySnapshotMembers(next), []);
const collisionA = createEngine([{id:1,longitude:120,latitude:30},{id:2,longitude:120,latitude:30}]);
const collisionB = createEngine([{id:3,longitude:120,latitude:30},{id:4,longitude:120,latitude:30}]);
const ca = buildSnapshot(collisionA,input), cb = buildSnapshot(collisionB,input);
cb.visibleNodes[0].memberSignature = ca.visibleNodes[0].memberSignature;
assert.equal(planTransition(ca,cb).reuse.size,0,'equal hashes never replace exact membership verification');
console.log('Map performance bounds passed');
