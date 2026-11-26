import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { createMapSurface,until,wait } from './map-test-surface.js';
import { installPinchGuard } from '../../src/map/pinchGuard.js';

const places=Array.from({length:24},(_,i)=>({id:i+1,name:'Point '+i,
    longitude:119.99+(i%6)*.004,latitude:29.994+Math.floor(i/6)*.004}));
const touch=(container,type,count)=>{
    const event=new Event(type,{bubbles:true});
    Object.defineProperty(event,'touches',{value:Array.from({length:count},()=>({}))});
    container.dispatchEvent(event);
};
const assert=(ok,label)=>{if(!ok)throw new Error(label);};

export async function runTouchLifecycleTests() {
    const failures=[];
    {
        const surface=createMapSurface(10,{project:()=>({x:550,y:350})});
        const controller=new MarkerLayerController(surface.map);
        try {
            controller.update({places});
            await until(()=>controller.snapshot&&!controller.renderQueue.busy,'initial topology');
            const source=[...controller.entries.values()][0].parts.root,created=surface.stats.created;
            touch(surface.container,'touchstart',2);
            surface.setZoom(20); // SDK can emit an intermediate end while fingers remain down.
            await wait(120);
            assert(controller.snapshot.logicalZoom===10&&surface.stats.created===created&&source.isConnected,
                'intermediate SDK end cannot replace the active touch target or start rendering');
            touch(surface.container,'touchend',1);await wait(50);
            assert(controller.snapshot.logicalZoom===10,'one remaining finger still owns the gesture');
            touch(document.body,'touchend',0); // The remaining finger can lift outside the map.
            await until(()=>controller.snapshot.logicalZoom===20&&!controller.renderQueue.busy,'publish after last finger lifts');
            assert(controller.entries.size===24,'final touch topology retains every member');
            touch(surface.container,'touchstart',2);
            Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
            document.dispatchEvent(new Event('visibilitychange'));
            assert(!controller.isTouchCameraActive(),'backgrounding ends physical touch ownership');
            delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));
            await until(()=>!controller.renderQueue.busy,'return from background');
            touch(surface.container,'touchstart',2);
            surface.map.getBounds=()=>null;
            touch(surface.container,'touchcancel',0);
            await until(()=>!controller.isTouchCameraActive(),'unreadable camera settlement ends');
            assert(!controller.isTouchCameraActive(),'an unreadable viewport cannot leave an infinite frame poll');
        } catch(error) {failures.push(error.message);}
        finally {controller.destroy();surface.destroy();}
    }
    {
        const surface=createMapSurface(10,{project:()=>({x:550,y:350})});
        let settled=0,controller;
        controller=new MarkerLayerController(surface.map,{onViewSettled:()=>{
            settled++;
            // This is the page's tile-band publication, triggered by raw touch
            // settlement even when the SDK fails to emit camera lifecycle events.
            controller.update({places,markerBand:{kind:'leaf',tile:12,minZoom:11}});
        }});
        try {
            controller.update({places,markerBand:{kind:'aggregate',tile:3,cell:9,minZoom:0,maxZoom:10}});
            await until(()=>controller.snapshot&&!controller.renderQueue.busy,'initial coarse band');
            touch(surface.container,'touchstart',2);
            // Camera moves but consumers see no start/change/end notification.
            const getZoom=surface.map.getZoom;surface.map.getZoom=()=>20;
            touch(surface.container,'touchend',0);
            await until(()=>settled>0,'raw touch notifies the page');
            assert(settled===1,'raw touch settlement requests the current tile band without SDK end events');
            await until(()=>controller.snapshot.logicalZoom===20&&!controller.renderQueue.busy,'new band ready');
            assert(controller.entries.size===24,'new-band markers appear after a missing SDK end');
            surface.map.getZoom=getZoom;
        } catch(error) {failures.push(error.message);}
        finally {controller.destroy();surface.destroy();}
    }
    {
        const surface=createMapSurface(10);
        let invalid=false,recovery,recoveries=0,center={lng:120,lat:30};
        surface.map.getCenter=()=>{if(invalid)throw new Error('Invalid Object: LngLat(NaN, NaN)');return center;};
        surface.map.setZoomAndCenter=(zoom,center,immediate)=>{recovery={zoom,center,immediate};recoveries++;invalid=false;};
        const release=installPinchGuard(surface.container,{map:surface.map});
        try {
            touch(surface.container,'touchstart',2);
            invalid=true;surface.map.getZoom=()=>15.2;
            touch(surface.container,'touchend',0);
            // A new gesture can arrive before the queued recovery frame.
            touch(surface.container,'touchstart',2);touch(surface.container,'touchend',0);
            await until(()=>recoveries===1,'interrupted recovery completes');
            assert(recovery?.zoom===15.2&&recovery.center[0]===120&&recovery.center[1]===30&&recovery.immediate,
                'invalid SDK camera recovers the last valid center while preserving the requested zoom');
            touch(surface.container,'touchstart',2);
            Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));
            center={lng:121,lat:31};
            touch(surface.container,'touchstart',2);invalid=true;
            touch(surface.container,'touchcancel',0);
            await until(()=>recoveries===2,'new center recovers');
            assert(recovery.center[0]===121&&recovery.center[1]===31,'background return cannot recover to a previous gesture center');
            touch(surface.container,'touchstart',2);invalid=true;
            touch(surface.container,'touchend',0);
            Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));
            await until(()=>!invalid,'foreground recovery completes');
            assert(!invalid,'backgrounding before the recovery frame cannot lose the valid camera anchor');
        } catch(error) {failures.push(error.message);}
        finally {release();surface.destroy();}
    }
    {
        const surface=createMapSurface(10);
        let invalid=false,settled=0;
        const bounds=surface.map.getBounds;
        surface.map.getBounds=()=>invalid?null:bounds();
        surface.map.getCenter=()=>{if(invalid)throw new Error('Invalid camera');return {lng:120,lat:30};};
        surface.map.setZoomAndCenter=()=>{invalid=false;};
        const controller=new MarkerLayerController(surface.map,{onViewSettled:()=>settled++});
        const release=installPinchGuard(surface.container,{map:surface.map});
        try {
            controller.update({places});await until(()=>controller.snapshot&&!controller.renderQueue.busy,'background camera snapshot');
            touch(surface.container,'touchstart',2);invalid=true;
            Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));
            await until(()=>!invalid&&settled>0&&!controller.isTouchCameraActive(),'foreground page callback follows recovery');
            assert(!invalid&&settled===1&&!controller.isTouchCameraActive(),'foreground recovery synchronizes the page even without an SDK end event');
        } catch(error) {failures.push(error.message);}
        finally {release();controller.destroy();surface.destroy();}
    }
    if(failures.length)throw new Error(failures.join('; '));
    return {passed:true,checks:['active touch target retained','last-finger settlement','missing SDK lifecycle','tile band notification','invalid camera recovery','background return','unreadable viewport']};
}
