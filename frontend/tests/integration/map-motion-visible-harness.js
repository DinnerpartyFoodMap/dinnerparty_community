import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { createMapSurface,until } from './map-test-surface.js';
import { getMotionPolicy } from '../../src/motion/policy.js';

export async function runMotionRegressionTests() {
    const surface=createMapSurface(10,{project:p=>({x:550+(p[0]-120)*8000,y:350-(p[1]-30)*8000})});
    // Model a slow SDK at its actual boundary. Animation must remain visible even
    // when preparation necessarily spans longer than the animation's duration.
    const add=surface.map.add;
    surface.map.add=markers=>{
        const started=performance.now();
        while(performance.now()-started<1.5){ /* synchronous external SDK work */ }
        add(markers);
    };
    const controller=new MarkerLayerController(surface.map);
    const assert=(ok,label)=>{if(!ok)throw new Error(label);};
    const distance=entry=>{
        const transform=getComputedStyle(entry.parts.travel).transform;
        const matrix=new DOMMatrixReadOnly(transform==='none'?undefined:transform);
        return Math.hypot(matrix.m41,matrix.m42);
    };
    try {
        assert(getMotionPolicy().clusterMotion,'fixture requires full motion');
        const places=Array.from({length:120},(_,i)=>({id:i+1,name:'Point '+i,
            longitude:119.98+(i%12)*.004,latitude:29.982+Math.floor(i/12)*.004}));
        controller.update({places});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy&&!controller.txns.size,'coarse snapshot');
        assert(controller.entries.size===1,'fixture has one parent');
        const zoomStarted=performance.now();
        surface.setZoom(20);
        await until(()=>[...controller.entries.values()].some(e=>e.node.kind==='place'&&e.anims?.size),'first moving split child');
        const child=[...controller.entries.values()].find(e=>e.node.kind==='place'&&e.anims?.size);
        const firstVisibleMs=performance.now()-zoomStarted;
        assert(getComputedStyle(child.parts.root).visibility!=='hidden','split motion must be visible while preparation is still running');
        assert(controller.renderQueue.busy,'test observes a partial split, not merely a settled frame');
        const before=distance(child);
        assert(before>1,'a split child starts near the parent, before reaching its own position');
        await until(()=>{
            const after=distance(child);
            return after>0.25&&after<before-0.25;
        },'a visible child travels away from its parent');
        await until(()=>controller.snapshot?.logicalZoom===20&&!controller.renderQueue.busy&&!controller.txns.size&&!controller.cleanupQueue.busy,'split settles');
        assert(controller.entries.size===120,'all split members eventually appear');
        surface.setZoom(10);
        await until(()=>[...controller.entries.values()].some(e=>e.node.kind==='cluster'&&e.anims?.size),'merge target starts');
        const parent=[...controller.entries.values()].find(e=>e.node.kind==='cluster'&&e.anims?.size);
        assert(getComputedStyle(parent.parts.root).visibility!=='hidden','merge target animation cannot run on a hidden marker');
        await until(()=>Number(getComputedStyle(parent.parts.glyph).opacity)>.05&&Number(getComputedStyle(parent.parts.glyph).opacity)<.99,'merge target visibly fades in');
        const travelers=[...controller.txns].flatMap(txn=>txn.ghosts).filter(e=>e.node.kind==='place'&&e.anims?.size);
        assert(travelers.some(e=>distance(e)>1),'visible old children travel toward the merge target');
        await until(()=>controller.entries.size===1&&!controller.renderQueue.busy&&!controller.txns.size&&!controller.cleanupQueue.busy,'merge settles');
        assert([...controller.entries.values()][0].node.count===120,'member counts survive visible motion');
        return {passed:true,firstVisibleMs,splitMembers:120,maxSlice:Math.max(...controller.metrics.renderSlices.map(s=>s.ms))};
    } finally {controller.destroy();surface.destroy();}
}
