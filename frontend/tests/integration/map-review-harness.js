import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { createComputeScheduler } from '../../src/map/cluster/computeScheduler.js';
import { createMapSurface,until,wait } from './map-test-surface.js';

export async function runReviewRegressionTests() {
    const surface=createMapSurface(20,{project:()=>({x:550,y:350})}),controller=new MarkerLayerController(surface.map);
    const assert=(ok,label)=>{if(!ok)throw new Error(label);};
    try {
        let time=0,seq=0,executions=0;const timers=new Map();
        controller.scheduler.destroy();
        controller.scheduler=createComputeScheduler({
            now:()=>time,setTimer:(fn,ms)=>{timers.set(++seq,{fn,at:time+ms});return seq;},clearTimer:id=>timers.delete(id),
            execute:()=>{executions++;return {skipped:true};},onResult:()=>{}
        });
        for(let i=0;i<12;i++){
            await controller.update({places:[{id:i+1,longitude:120,latitude:30}]});
            time+=50;for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn();}
            await wait(0);
            if(time===200)assert(executions>0,'the real update entry preserves its 200ms deadline');
        }
        controller.destroy();
        const live=new MarkerLayerController(surface.map);
        try {
            await live.update({places:[{id:1,longitude:120,latitude:100},{id:1,longitude:120,latitude:30}]});
            await until(()=>live.snapshot?.dataRevision===live.dataRevision&&!live.renderQueue.busy,'valid duplicate retained');
            assert(live.entries.has('place:1'),'invalid records cannot consume a valid duplicate key');
            const places=Array.from({length:120},(_,i)=>({id:i+10,longitude:119.9+(i%20)*.01,latitude:29.98+Math.floor(i/20)*.01}));
            await live.update({places});
            await until(()=>live.snapshot?.dataRevision===live.dataRevision&&!live.renderQueue.busy&&!live.txns.size,'stable points');
            const previousVersion=live.version, slices=[];
            live.options.onMetric=(kind,value)=>{if(kind==='renderSlices'&&value.version>previousVersion)slices.push(value);};
            surface.emit('moveend');
            await until(()=>live.metrics.commits.at(-1)?.reason==='camera'&&!live.renderQueue.busy,'unchanged camera');
            assert(slices.length>0&&slices.every(slice=>slice.writes===0),'unchanged nodes are not throttled as 120 SDK writes');
            const stable=live.snapshot, keys=[...live.entries.keys()].sort();
            live.update({places:places.map((place,i)=>({...place,id:i+20000,longitude:119.99+(i%20)*.001})),queryMode:'search'});
            await until(()=>live.renderQueue.busy&&[...live.entries.keys()].some(key=>key==='place:20000'),'partial new render');
            surface.emit('zoomstart');
            await until(()=>!live.renderQueue.busy&&!live.cleanupQueue.busy,'rollback while the camera is moving');
            assert(JSON.stringify([...live.entries.keys()].sort())===JSON.stringify(keys),'cancel restores the last committed topology');
            assert(live.getDataBounds()===stable.dataBounds,'rollback restores committed data bounds as well as markers');
            surface.emit('zoomend');
            await until(()=>live.snapshot?.dataRevision===live.dataRevision&&!live.renderQueue.busy&&!live.txns.size,'resume latest data after rollback');
            const root=[...live.entries.values()][0];let taps=0;
            live.options.onPlaceClick=()=>taps++;
            root.interactive=false;
            root.marker.events.click();
            root.parts.hit.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            assert(taps===0,'all activation paths honor interaction state');
            root.interactive=true;
            await live.update({places:[{id:999,longitude:120,latitude:30}],queryMode:'search'});
            await until(()=>[...live.txns].some(txn=>txn.ghosts.length>20),'ghost transition');
            surface.emit('zoomstart');
            await wait(0);
            const oldGhosts=[...surface.container.querySelectorAll('.fm-marker[data-ghost]')];
            assert(oldGhosts.every(el=>getComputedStyle(el).visibility==='hidden'),'retired ghosts do not flash after animation cancellation');
            surface.setZoom(5);
            await live.update({places:[{id:1000,longitude:120,latitude:30}]});
            await until(()=>live.snapshot?.dataRevision===live.dataRevision&&!live.renderQueue.busy&&!live.cleanupQueue.busy&&!live.txns.size,'final target');
            assert(live.entries.has('place:1000')&&surface.attached.size===1,'interrupted reconciliation converges without duplicates');
            return {passed:true,executions};
        } finally {live.destroy();}
    } finally {controller.destroy();surface.destroy();}
}
