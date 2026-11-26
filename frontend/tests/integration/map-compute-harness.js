import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { createWorkerClient } from '../../src/map/cluster/workerClient.js';
import { createMapSurface,until,wait,loadPlacesThroughTiles } from './map-test-surface.js';

export async function runMapComputeTests() {
    const renderSlices=[];
    const surface=createMapSurface(13),controller=new MarkerLayerController(surface.map,{onMetric:(kind,value)=>{
        if(kind==='renderSlices')renderSlices.push(value.ms);
    }});
    const assert=(ok,label)=>{if(!ok)throw new Error(label);};
    let beats=0;const interval=setInterval(()=>beats++,5);
    const longTasks=[];
    const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
    observer.observe({type:'longtask',buffered:false});
    try {
        const cold=performance.now();
        const samples=[];
        for(const count of [0,1,1000,10000]) {
            const started=performance.now();
            await controller.update({places:Array.from({length:count},(_,i)=>({id:i+1,longitude:120,latitude:30}))});
            await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'fixture '+count);
            assert([...controller.entries.values()].reduce((sum,e)=>sum+e.node.count,0)===count,'member conservation for '+count);
            samples.push({count,ms:performance.now()-started,worker:controller.metrics.worker.at(-1)});
        }
        const places=Array.from({length:50000},(_,i)=>({id:i+1,name:'Place '+i,
            longitude:119.95+(i%250)*0.0004,latitude:29.96+Math.floor(i/250)*0.0004}));
        const largeStart=performance.now();
        const before=beats;
        await controller.update(await loadPlacesThroughTiles(places));
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'50k worker snapshot');
        assert(beats>before,'the page remains responsive while the worker builds the index');
        assert(controller.getEngine()===null,'web does not retain a synchronous index');
        const node=[...controller.entries.values()][0].node;
        assert([...controller.entries.values()].reduce((sum,e)=>sum+e.node.count,0)===50000,'all members are retained');
        const info=await controller.getClusterInfo(node.key);
        assert(!info.aggregateOnly,'real places are not anonymous');
        const firstMs=performance.now()-largeStart;
        const largeWorker=controller.metrics.worker.at(-1);
        const builds=controller.metrics.worker.at(-1).builds;
        surface.setZoom(14);
        await until(()=>controller.snapshot?.logicalZoom===14&&!controller.renderQueue.busy,'camera result');
        assert(controller.metrics.worker.at(-1).builds===builds,'camera requests do not rebuild the index');
        for(let i=0;i<20;i++)controller.update({places:[{id:100000+i,longitude:120,latitude:30,name:'latest'}]});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'latest data wins');
        assert(controller.entries.size===1&&controller.entries.has('place:100019'),'intermediate updates cannot overwrite the final data');
        const result={passed:true,inputCount:50000,firstMs,totalMs:performance.now()-cold,samples,heartbeats:beats-before,worker:largeWorker,
            maxRenderSlice:Math.max(...renderSlices),longTasks};
        controller.update({places});
        controller.destroy();await wait(220);
        assert(surface.attached.size===0,'destroy cancels preparation and pending replies');

        const errorSurface=createMapSurface();
        let attempts=0;
        const broken=new MarkerLayerController(errorSurface.map,{workerOptions:{createWorker:()=>{attempts++;throw new Error('fixture worker failure');}}});
        const warn=console.warn;console.warn=()=>{};
        try {
            await broken.update({places:[{id:1,longitude:120,latitude:30}]});
            await until(()=>errorSurface.container.querySelector('.fm-marker-retry'),'retry UI after one automatic retry');
            assert(attempts===2,'worker initialization automatically retries only once');
            broken.destroy();assert(!errorSurface.container.querySelector('.fm-marker-retry'),'destroy removes retry UI');
        } finally {console.warn=warn;broken.destroy();errorSurface.destroy();}
        // Exercise the actual browser worker transport independently of the controller.
        const client=createWorkerClient();client.destroy();
        await client.request('compute',{}).then(()=>{throw new Error('disposed transport accepted a request');},()=>{});
        return result;
    } finally {clearInterval(interval);observer.disconnect();controller.destroy();surface.destroy();}
}
