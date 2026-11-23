import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { installPinchGuard } from '../../src/map/pinchGuard.js';
import { until,wait } from './map-test-surface.js';
import { readMapViewport } from '../../src/map/viewport.js';

// Diagnostic: real SDK + trusted CDP touch. No product timers/events are mocked.
export async function runTouchGestureTests() {
    await until(()=>window.dispatchMapTouch,'trusted touch driver');
    const response=await fetch('/__map-amap-config');
    const {key,serviceHost}=await response.json();
    window._AMapSecurityConfig={serviceHost};
    await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.onload=resolve;script.onerror=reject;
        script.src='https://webapi.amap.com/maps?v=2.0&key='+encodeURIComponent(key);document.head.append(script);
    });
    const container=document.createElement('div');
    container.style.cssText='position:relative;width:1000px;height:700px;touch-action:none';document.body.append(container);
    const map=new window.AMap.Map(container,{center:[120,30],zoom:13,zoomEnable:true,dragEnable:true});
    let ready=false;map.on('complete',()=>ready=true);
    await until(()=>ready,'real map');await wait(500);
    const trace=[],start=performance.now();
    let controller;const log=(type,extra={})=>trace.push({type,t:Math.round(performance.now()-start),z:+map.getZoom().toFixed(3),moving:controller?.cameraMoving,busy:controller?.renderQueue.busy,...extra});
    for(const type of ['movestart','dragstart','zoomstart','zoomchange','mapmove','moveend','zoomend','dragend'])map.on(type,()=>log(type));
    for(const type of ['touchstart','touchmove','touchend','touchcancel'])container.addEventListener(type,event=>log(type,{touches:event.touches.length,trusted:event.isTrusted,target:event.target.className}),{capture:true,passive:true});
    let cancels=0,restores=0,applies=0,motionFrame=0,kind;
    const visibleMotion={split:0,merge:0};
    controller=new MarkerLayerController(map,{onViewSettled:view=>log('touch-settled',view),onMetric:(kind,value)=>{if(kind==='commits')log('commit',value);}});
    const cancel=controller._cancelRender.bind(controller),render=controller._render.bind(controller);
    controller._cancelRender=options=>{if(controller.renderQueue.busy)cancels++;return cancel(options);};
    controller._render=function*(plan,next,reason){kind=plan.kind;if(reason==='resume')restores++;applies++;yield*render(plan,next,reason);};
    const sampleMotion=()=>{
        const entries=[...controller.entries.values(),...[...controller.txns].flatMap(txn=>txn.ghosts)];
        for(const entry of entries){
            if(!entry.anims?.size||getComputedStyle(entry.parts.root).visibility==='hidden'||Number(getComputedStyle(entry.parts.glyph).opacity)<.05)continue;
            const transform=getComputedStyle(entry.parts.travel).transform;
            const matrix=new DOMMatrixReadOnly(transform==='none'?undefined:transform);
            if(Math.hypot(matrix.m41,matrix.m42)>1){
                if(kind==='zoom-in')visibleMotion.split++;
                if(kind==='zoom-out')visibleMotion.merge++;
            }
        }
        motionFrame=requestAnimationFrame(sampleMotion);
    };
    motionFrame=requestAnimationFrame(sampleMotion);
    const release=installPinchGuard(container,{map});
    const assert=(condition,label)=>{if(!condition)throw new Error(label+' '+JSON.stringify({trace,cancels,restores,applies,touchCount:controller.touchCount,touchCameraFrame:controller.touchCameraFrame,logicalZoom:controller.snapshot?.logicalZoom,busy:controller.renderQueue.busy}));};
    try {
        const places=Array.from({length:5000},(_,i)=>({id:i+1,name:'Point '+i,
            longitude:119.98+(i%100)*.0004,latitude:29.99+Math.floor(i/100)*.0004}));
        await controller.update({places});
        await until(()=>controller.snapshot&&!controller.renderQueue.busy,'initial markers');
        const rect=container.getBoundingClientRect(),x=rect.left+500,y=rect.top+350;
        const points=d=>[{id:1,x:x-d,y,radiusX:3,radiusY:3},{id:2,x:x+d,y,radiusX:3,radiusY:3}];
        let previousZoom=map.getZoom();
        for(const [from,to] of [[100,300],[300,100],[100,320]]){
            await window.dispatchMapTouch([
                {type:'touchStart',points:points(from)},
                ...Array.from({length:24},(_,i)=>({wait:16,type:'touchMove',points:points(from+(to-from)*(i+1)/24)})),
                {wait:16,type:'touchEnd',points:[]}
            ]);
            const deadline=performance.now()+5000;
            while(performance.now()<deadline&&(controller.isTouchCameraActive()||controller.renderQueue.busy
                ||Math.abs(controller.snapshot.logicalZoom-map.getZoom())>.65))await wait(16);
            const zoom=map.getZoom();
            assert(!!readMapViewport(map),'the SDK camera remains finite after a centered pinch');
            assert(to>from ? zoom>previousZoom+.5 : zoom<previousZoom-.5,'every consecutive pinch changes the real SDK camera');
            assert(Math.abs(controller.snapshot.logicalZoom-zoom)<=.65,'marker topology catches up after a pinch starting on a marker');
            previousZoom=zoom;
        }
        await until(()=>!controller.txns.size&&!controller.cleanupQueue.busy,'touch animations finish');
        assert(visibleMotion.split>0&&visibleMotion.merge>0,'trusted touch produces visible moving split and merge animations');
        return {passed:true,visibleMotion,cancels,restores,applies,entries:controller.entries.size,
            cameraEvents:trace.filter(event=>event.type==='zoomend').length,touchSettlements:trace.filter(event=>event.type==='touch-settled').length,
            logicalZoom:controller.snapshot?.logicalZoom,mapZoom:map.getZoom(),cameraMoving:controller.cameraMoving,
            renderSlices:controller.metrics.renderSlices,commits:controller.metrics.commits};
    } finally {cancelAnimationFrame(motionFrame);release();controller.destroy();map.destroy();container.remove();}
}
