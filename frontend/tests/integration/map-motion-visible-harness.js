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
        const result={passed:true,firstVisibleMs,splitMembers:120,maxSlice:Math.max(...controller.metrics.renderSlices.map(s=>s.ms))};
        controller.destroy();surface.destroy();
        result.mergeOrder=await runMergeOrderTests();
        return result;
    } finally {controller.destroy();surface.destroy();}
}

// Zooming out over many separate groups spreads the reconciliation over many
// frames. No place may be shown twice at any frame: old points start moving in
// the same slice that reveals their cluster, and a cluster left over from a
// superseded reconciliation must not stay beside the cluster that replaces it.
export async function runMergeOrderTests() {
    const assert=(ok,label)=>{if(!ok)throw new Error(label);};
    // second: the next zoom begins while markers of the first zoom are still being added.
    const scenario=async ({start=20,first=17,second=null})=>{
        const project=p=>({x:550+(p[0]-120)*8000,y:350-(p[1]-30)*8000});
        const surface=createMapSurface(start,{project});
        const add=surface.map.add;
        surface.map.add=markers=>{
            const started=performance.now();
            while(performance.now()-started<1.5){ /* synchronous external SDK work */ }
            add(markers);
        };
        const controller=new MarkerLayerController(surface.map);
        const cancel=controller._cancelRender.bind(controller);
        let cancelled=0;
        controller._cancelRender=options=>{if(controller.renderQueue.busy)cancelled++;return cancel(options);};
        // Groups of three points: separate at zoom 20, one cluster per group at 17,
        // neighbouring groups merge at 12.
        const SPACING=0.02,ORIGIN=[119.82,29.82],SIDE=19;
        const places=[],onscreenGroups=new Set();
        for(let col=0;col<SIDE;col++)for(let row=0;row<SIDE;row++){
            const lng=ORIGIN[0]+col*SPACING,lat=ORIGIN[1]+row*SPACING,p=project([lng,lat]);
            if(p.x>0&&p.x<1100&&p.y>0&&p.y<700)onscreenGroups.add(col*SIDE+row);
            for(const [dx,dy] of [[0,0],[0.0003,0],[0,0.0003]])places.push({id:places.length+1,name:'P'+places.length,longitude:lng+dx,latitude:lat+dy});
        }
        const groupOf=c=>Math.round((c[0]-ORIGIN[0])/SPACING)*SIDE+Math.round((c[1]-ORIGIN[1])/SPACING);
        const frames=[];let sampling=true;
        const sample=()=>{
            if(!sampling)return;
            const parents=new Set(),points=new Set();
            let shown=0;
            for(const entry of controller.entries.values()){
                if(entry.ghost||!entry.attached||!entry.parts.root.isConnected||'staged' in entry.parts.root.dataset)continue;
                shown+=entry.node.count;
                const group=groupOf(entry.node.coordinate);
                if(onscreenGroups.has(group))(entry.node.kind==='cluster'&&entry.node.count===3?parents:points).add(group);
            }
            let mixed=0;
            for(const group of parents)if(points.has(group))mixed++;
            // Ghosts are excluded: a place counted twice means two static markers stand for it.
            frames.push({mixed,duplicated:Math.max(0,shown-places.length)});
            requestAnimationFrame(sample);
        };
        try {
            controller.update({places});
            await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy&&!controller.txns.size,'initial snapshot');
            const kindAt=zoom=>zoom>=20?'place':'cluster';
            assert([...controller.entries.values()].every(e=>e.node.kind===kindAt(start)),'fixture starts at the expected level');
            const settledAt=[...controller.entries.values()];
            requestAnimationFrame(sample);
            surface.setZoom(first);
            if(second){
                await until(()=>[...controller.entries.values()].filter(e=>!settledAt.includes(e)).length>=40,'first markers added');
                assert(controller.renderQueue.busy,'interrupt lands during reconciliation');
                surface.setZoom(second);
            }
            const target=second||first;
            await until(()=>controller.snapshot?.logicalZoom===target&&!controller.renderQueue.busy&&!controller.txns.size&&!controller.cleanupQueue.busy,'transition settles');
            sampling=false;
            const entries=[...controller.entries.values()];
            assert(entries.every(e=>e.node.kind===kindAt(target))&&entries.reduce((sum,e)=>sum+e.node.count,0)===places.length,'every place ends in exactly one marker');
            if(target===17)assert(entries.length===SIDE*SIDE,'each group ends as one cluster');
            return {frames:frames.length,cancelled,markers:entries.length,
                mixedFrames:frames.filter(f=>f.mixed).length,maxMixedGroups:Math.max(0,...frames.map(f=>f.mixed)),
                duplicatedFrames:frames.filter(f=>f.duplicated).length,maxDuplicated:Math.max(0,...frames.map(f=>f.duplicated))};
        } finally {sampling=false;controller.destroy();surface.destroy();}
    };
    const report={plain:await scenario({}),sameIds:await scenario({second:15}),regrouped:await scenario({second:12}),
        splitAgain:await scenario({start:12,second:20})};
    const text=JSON.stringify(report);
    for(const name of ['sameIds','regrouped','splitAgain'])
        assert(report[name].cancelled>0,name+': the second zoom must supersede a reconciliation in progress: '+text);
    assert(report.regrouped.markers<SIDE_GROUPS,'the second zoom must merge neighbouring groups: '+text);
    for(const [name,result] of Object.entries(report)){
        assert(result.mixedFrames===0,name+': a cluster appears while its old points are still static: '+text);
        assert(result.duplicatedFrames===0,name+': some places are shown by two static markers: '+text);
    }
    return {passed:true,...report};
}
const SIDE_GROUPS=19*19;
