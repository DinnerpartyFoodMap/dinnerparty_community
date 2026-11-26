import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { until,wait,loadPlacesThroughTiles } from './map-test-surface.js';

// Optional network-dependent measurement; no place data is sent to a backend.
export async function runAmapBenchmark() {
    const response=await fetch('/__map-amap-config');
    if(!response.ok)throw new Error('AMap public configuration unavailable for the benchmark');
    const {key,serviceHost}=await response.json();
    if(!key)throw new Error('AMap public configuration has no JS key');
    window._AMapSecurityConfig={serviceHost};
    await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        const timeout=setTimeout(()=>reject(new Error('AMap SDK network timeout')),20000);
        script.onload=()=>{clearTimeout(timeout);resolve();};
        script.onerror=()=>{clearTimeout(timeout);reject(new Error('AMap SDK could not be loaded'));};
        script.src='https://webapi.amap.com/maps?v=2.0&key='+encodeURIComponent(key);
        document.head.appendChild(script);
    });
    const container=document.createElement('div');
    container.style.cssText='position:relative;width:1100px;height:700px';
    document.body.appendChild(container);
    const map=new window.AMap.Map(container,{center:[120,30],zoom:13});
    let complete=false;map.on('complete',()=>{complete=true;});
    let controller;
    const longTasks=[];const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
    observer.observe({type:'longtask',buffered:false});
    try {
        await until(()=>complete,'real AMap initial load');
        await wait(500);
        const baseline=longTasks.splice(0);
        const renderSlices=[];
        controller=new MarkerLayerController(map,{onMetric:(kind,value)=>{
            if(kind==='renderSlices')renderSlices.push(value.ms);
        }});
        const places=Array.from({length:50000},(_,i)=>({id:i+1,name:'Point '+i,
            longitude:119.95+(i%250)*0.0004,latitude:29.96+Math.floor(i/250)*0.0004}));
        const started=performance.now();
        let firstMarkerMs=null;
        const add=map.add.bind(map);
        map.add=markers=>{
            if(firstMarkerMs===null)firstMarkerMs=performance.now()-started;
            return add(markers);
        };
        const coldTiles=await loadPlacesThroughTiles(places);
        await controller.update(coldTiles);
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'real AMap markers');
        const ms=performance.now()-started;
        const count=controller.entries.size;
        map.setZoomAndCenter(18,[120,30],true);
        await until(()=>controller.snapshot?.logicalZoom>=18&&!controller.renderQueue.busy,'real AMap large zoom');
        await wait(400);
        map.setZoomAndCenter(13,[120,30],true);
        await until(()=>controller.snapshot?.logicalZoom===13&&!controller.renderQueue.busy&&!controller.txns.size&&!controller.cleanupQueue.busy,'real AMap return');
        const hotStarted=performance.now(),hotTiles=await loadPlacesThroughTiles(places);
        await controller.update(hotTiles);
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'warm IndexedDB markers');
        const hotMs=performance.now()-hotStarted;
        if (hotTiles.requests !== 0) throw new Error('Warm marker tiles unexpectedly fetched the network');
        if (controller.metrics.worker.at(-1).builds !== 1) throw new Error('Unchanged cached geometry rebuilt its index');
        return {passed:true,map:'AMap',inputCount:50000,visibleNodes:count,firstMarkerMs,settledMs:ms,
            coldTileRequests:coldTiles.requests,hotTileRequests:hotTiles.requests,hotSettledMs:hotMs,baselineLongTasks:baseline,longTasks,
            renderSamples:renderSlices.length,renderP95:renderSlices.sort((a,b)=>a-b)[Math.floor(renderSlices.length*0.95)],
            worker:controller.metrics.worker};
    } finally {observer.disconnect();controller?.destroy();map.destroy();container.remove();}
}
