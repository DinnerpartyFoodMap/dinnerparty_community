import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { installPinchGuard } from '../../src/map/pinchGuard.js';
import { until,wait } from './map-test-surface.js';

// Real AMap SDK + trusted wheel input (or two-finger pinches when the runner
// emulates touch). Samples every frame which markers are visibly on screen and
// reports markers that vanish and come back while zooming. Each zoom step starts
// while the previous step's markers are still being added, which used to roll
// the layer back to the old snapshot and re-apply the new one (visible blinking).
async function loadAmap() {
    const response=await fetch('/__map-amap-config');
    if(!response.ok)throw new Error('AMap public configuration unavailable for the flicker test');
    const {key,serviceHost}=await response.json();
    window._AMapSecurityConfig={serviceHost};
    await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        const timeout=setTimeout(()=>reject(new Error('AMap SDK network timeout')),20000);
        script.onload=()=>{clearTimeout(timeout);resolve();};
        script.onerror=()=>{clearTimeout(timeout);reject(new Error('AMap SDK could not be loaded'));};
        script.src='https://webapi.amap.com/maps?v=2.0&key='+encodeURIComponent(key);
        document.head.appendChild(script);
    });
}

export async function runZoomFlickerTests() {
    const progress=text=>{document.getElementById('result').textContent='progress: '+text;};
    progress('wheel driver');
    await until(()=>window.dispatchMapWheel,'trusted wheel driver');
    progress('amap');
    await loadAmap();
    progress('map');
    const container=document.createElement('div');
    container.style.cssText='position:relative;width:1000px;height:700px';
    document.body.appendChild(container);
    const map=new window.AMap.Map(container,{center:[120,30],zoom:14,viewMode:'2D'});
    let ready=false;map.on('complete',()=>{ready=true;});
    await until(()=>ready,'real map');await wait(500);
    const start=performance.now(),events=[];
    let controller,phase='setup';
    const log=(type,extra={})=>events.push({type,phase,t:Math.round(performance.now()-start),z:+Number(map.getZoom()).toFixed(3),...extra});
    for(const type of ['zoomstart','zoomend','movestart','moveend'])map.on(type,()=>log(type));
    const releasePinchGuard=installPinchGuard(container,{map});
    controller=new MarkerLayerController(map,{onMetric:(kind,value)=>{if(kind==='commits')log('commit',{reason:value.reason,kind:value.kind,nodes:value.nodes});}});
    const cancel=controller._cancelRender.bind(controller),render=controller._render.bind(controller);
    let restores=0;
    controller._cancelRender=options=>{
        if(controller.renderQueue.busy&&options?.restore!==false){restores++;log('restore');}
        return cancel(options);
    };
    controller._render=function*(plan,next,reason){
        const began=performance.now(),firstFrame=frames.length;let steps=0;
        log('render',{reason,kind:plan.kind,nodes:next.visibleNodes.length});
        for(const step of render(plan,next,reason)){steps++;yield step;}
        log('rendered',{reason,ms:Math.round(performance.now()-began),steps,frames:frames.length-firstFrame});
    };
    const frames=[];let frame=0;
    // Cheap per-frame read: computed styles only for ghosts and animating entries,
    // so sampling does not starve the frame-sliced marker reconciliation.
    const visibleKeys=()=>{
        const area=container.getBoundingClientRect(),keys=new Set();
        const entries=[...controller.entries.values(),...[...controller.txns].flatMap(txn=>txn.ghosts)];
        for(const entry of entries){
            const root=entry.parts.root;
            // Ghosts count too: a merge hands over from fading children to the parent.
            if(!root.isConnected||root.dataset.staged!==undefined||root.dataset.retired!==undefined)continue;
            // Exit animations hold their end state (fill: both) after they leave entry.anims.
            if((entry.ghost||entry.anims?.size)&&Number(getComputedStyle(entry.parts.travel).opacity)*Number(getComputedStyle(entry.parts.glyph).opacity)<.3)continue;
            const box=root.getBoundingClientRect();
            if(box.left<area.left||box.top<area.top||box.left>area.right||box.top>area.bottom)continue;
            keys.add(entry.key);
        }
        return keys;
    };
    const sample=()=>{
        frames.push({t:Math.round(performance.now()-start),phase,z:+Number(map.getZoom()).toFixed(3),keys:visibleKeys()});
        frame=requestAnimationFrame(sample);
    };
    const idle=()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.cameraMoving
        &&!controller.renderQueue.busy&&!controller.txns.size&&!controller.cleanupQueue.busy;
    const waitIdle=async label=>{
        // Throttled runs (FOODMAP_CPU_RATE) need longer than the shared 12 s helper.
        const deadline=performance.now()+40000;
        while(!idle()){
            if(performance.now()>deadline){
                const state={cameraMoving:controller.cameraMoving,touch:controller.isTouchCameraActive(),render:controller.renderQueue.busy,
                    txns:controller.txns.size,cleanup:controller.cleanupQueue.busy,entries:controller.entries.size,
                    zoom:map.getZoom(),logicalZoom:controller.snapshot?.logicalZoom,
                    recent:events.filter(item=>/render|commit|zoomend/.test(item.type)).slice(-30)
                        .map(item=>[item.t,item.type,item.z,item.reason||'',item.kind||'',item.nodes||'',item.ms??''].join(' '))};
                throw new Error('Timed out: '+label+' '+JSON.stringify(state));
            }
            await wait(10);
        }
    };
    const settle=async label=>{await waitIdle(label);await wait(400);await waitIdle(label);};
    try {
        // Shops 40-80 m apart: clusters at city zoom, single places from about z17.
        const places=Array.from({length:4000},(_,i)=>({id:i+1,name:'Point '+i,
            longitude:119.985+(i%80)*.0004+((i*7919)%13)*.00002,latitude:29.99+Math.floor(i/80)*.0004+((i*104729)%11)*.00002}));
        progress('initial');
        await controller.update({places});
        await settle('initial markers');
        frame=requestAnimationFrame(sample);
        const rect=container.getBoundingClientRect();
        const touch=typeof window.dispatchMapTouch==='function';
        if(touch){
            const cx=rect.left+520,cy=rect.top+340;
            const points=d=>[{id:1,x:cx-d,y:cy,radiusX:3,radiusY:3},{id:2,x:cx+d,y:cy,radiusX:3,radiusY:3}];
            const pinch=(from,to)=>window.dispatchMapTouch([{type:'touchStart',points:points(from)},
                ...Array.from({length:8},(_,i)=>({wait:16,type:'touchMove',points:points(from+(to-from)*(i+1)/8)})),
                {wait:16,type:'touchEnd',points:[]}]);
            for(const [label,from,to] of [['pinch-in',80,130],['pinch-out',130,80]]){
                phase=label;progress(label);
                for(let i=0;i<6;i++){await pinch(from,to);await wait(180);}
                await settle(label);
            }
        } else {
            const wheel=(count,deltaY,gap,dx=0)=>window.dispatchMapWheel(Array.from({length:count},(_,i)=>({wait:i?gap:0,x:rect.left+500+dx,y:rect.top+350,deltaY})));
            for(const [label,count,delta,gap] of [['in-fast',24,-100,40],['out-fast',24,100,40],['in-slow',12,-100,250],['out-slow',12,100,250]]){
                phase=label;progress(label);
                await wheel(count,delta,gap,label.startsWith('in')?60:-60);
                await settle(label);
            }
        }
        phase='done';
        cancelAnimationFrame(frame);
        // A key that is visible, missing for 1-20 frames and visible again blinked.
        const blinks=[];
        const keys=new Set(frames.flatMap(item=>[...item.keys]));
        for(const key of keys){
            let lastSeen=-1;
            frames.forEach((item,index)=>{
                if(!item.keys.has(key))return;
                const gap=index-lastSeen-1;
                if(lastSeen>=0&&gap>0&&gap<=20)blinks.push({key,phase:item.phase,from:frames[lastSeen].t,to:item.t,frames:gap,z:item.z});
                lastSeen=index;
            });
        }
        const byPhase={};
        for(const blink of blinks)byPhase[blink.phase]=(byPhase[blink.phase]||0)+1;
        const counts=frames.map(item=>item.keys.size);
        // Frames where the visible count drops by half and recovers within 10 frames.
        const dips=[];
        for(let i=1;i<counts.length-1;i++){
            const before=counts[i-1];
            if(before<4||counts[i]>before/2)continue;
            const after=counts.slice(i+1,i+11);
            if(after.some(value=>value>=before*.8))dips.push({t:frames[i].t,phase:frames[i].phase,before,at:counts[i]});
        }
        const zooms=frames.map(item=>item.z),renders=events.filter(item=>item.type==='rendered');
        const passed=!blinks.length&&!dips.length;
        return {passed,input:touch?'pinch':'wheel',zoomRange:[Math.min(...zooms),Math.max(...zooms)],frames:frames.length,
            blinks:blinks.length,byPhase,sample:blinks.slice(0,12),dips:dips.slice(0,12),restores,
            renders:{completed:renders.length,maxMs:Math.max(0,...renders.map(item=>item.ms))},
            ...(passed ? {} : {events:events.filter(item=>item.type!=='movestart'&&item.type!=='moveend')})};
    } finally {cancelAnimationFrame(frame);releasePinchGuard();controller.destroy();map.destroy();container.remove();}
}
