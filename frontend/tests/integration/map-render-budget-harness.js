import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { NativeMarkerLayer } from '../../src/map/nativeMarkerLayer.js';
import { createMapSurface,until,wait } from './map-test-surface.js';

export async function runMapRenderTests() {
    const surface=createMapSurface(20,{project:()=>({x:550,y:350})}),controller=new MarkerLayerController(surface.map);
    const assert=(ok,label)=>{if(!ok)throw new Error(label);};
    try {
        // Deliberately oversized coverage stresses offscreen as well as onscreen creation.
        const places=Array.from({length:200},(_,i)=>({id:i+1,name:'Point '+i,longitude:119.9+(i%20)*0.01,latitude:29.95+Math.floor(i/20)*0.01}));
        await controller.update({places});
        await until(()=>surface.attached.size>0&&controller.renderQueue.busy,'first initial batch');
        const firstRoot=[...surface.attached][0].wrapper.querySelector('.fm-marker');
        assert(getComputedStyle(firstRoot).visibility!=='hidden','initial batches are visible before final convergence');
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'batched initial markers');
        assert(surface.attached.size===200,'all target markers eventually attach');
        assert(controller.metrics.renderSlices.length>1,'initial creation is spread over frames');
        assert(surface.stats.maxAdd>1&&surface.stats.maxAdd<=4,'each SDK attachment batch is small and shares a single call');
        const unchanged=surface.stats.created;
        surface.emit('moveend');
        await wait(300);
        assert(surface.stats.created===unchanged,'unchanged snapshots reuse existing markers');
        await controller.update({places:[{id:999,longitude:120,latitude:30,name:'replacement'}],queryMode:'search'});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy&&controller.txns.size===0,'batched removal');
        await until(()=>!controller.cleanupQueue.busy,'retired markers recycled');
        assert(surface.attached.size===1,'retired markers leave no DOM behind');
        assert(surface.stats.maxRemove>1&&surface.stats.maxRemove<=4,'retired markers are removed in small batches');
        controller.update({places});
        await wait(90);
        surface.setZoom(5);
        controller.update({places:[{id:1000,longitude:120,latitude:30,name:'final'}]});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy&&controller.txns.size===0&&!controller.cleanupQueue.busy,'interrupted rendering converges');
        assert(controller.entries.size===1&&controller.entries.has('place:1000'),'superseded render cannot delete the new entry');
        const result={passed:true,created:surface.stats.created,maxAdd:surface.stats.maxAdd,maxRemove:surface.stats.maxRemove,
            maxSlice:Math.max(...controller.metrics.renderSlices.map(s=>s.ms))};
        controller.destroy();assert(surface.attached.size===0,'destroy releases all markers');
        const nativeCommits=[];
        const nativeMap={...surface.map,setMarkerStyle(){},setSelectedPlace(){},
            setNodes(nodes,plan,options){nativeCommits.push({nodes,plan,options});return {count:nodes.length};}
        };
        const nativeLayer=new NativeMarkerLayer(nativeMap);
        try {
            nativeLayer.update({places});
            await until(()=>nativeLayer.snapshot?.nodeByKey.size>0,'native Worker snapshot');
            assert(!nativeLayer.localCompute,'the iOS marker path starts its bundled Worker in the browser');
            assert(nativeCommits.length===1,'the first native snapshot reaches the bridge');
        } finally {nativeLayer.destroy();}
        return result;
    } finally {controller.destroy();surface.destroy();}
}
