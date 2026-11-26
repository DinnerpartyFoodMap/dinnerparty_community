import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { tileOf,lngOf,latOf } from '../../src/map/markerTiles.js';
import { createMapSurface,until } from './map-test-surface.js';

const assert=(ok,label)=>{if(!ok)throw new Error(label);};
const touch=(surface,type,count)=>{
    const event=new Event(type,{bubbles:true});
    Object.defineProperty(event,'touches',{value:Array.from({length:count},()=>({}))});
    surface.container.dispatchEvent(event);
};

export async function runAnchorRefinementTests() {
    const results=[],failures=[];
    for(const input of ['desktop','touch','silent-touch']){
        const surface=createMapSurface(12),controller=new MarkerLayerController(surface.map);
        const [x,y]=tileOf(120,30,14);
        const coordinate=[lngOf(x+.5,14),latOf(y+.5,14)];
        const detail={id:1,name:'Actual place',longitude:coordinate[0]-.002,latitude:coordinate[1]};
        const coarse={aggregateKey:`agg:14/${x}/${y}#0`,aggregate:true,aggregateCell:[14,x,y],
            longitude:coordinate[0],latitude:coordinate[1]};
        const band={kind:'aggregate',tile:9,cell:14,minZoom:0,maxZoom:12};
        try {
            controller.update({places:[coarse],markerBand:band});
            await until(()=>controller.snapshot&&!controller.renderQueue.busy,'anonymous snapshot');
            surface.setZoom(13);
            controller.update({places:[detail],markerBand:{kind:'leaf',tile:12,minZoom:13}});
            await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'named snapshot');
            const entry=controller.entries.get('place:1');
            const initial=entry.node;
            assert(initial.sourceCoordinate&&Math.abs(initial.coordinate[0]-coordinate[0])<1e-7,'band switch initially preserves its anonymous anchor');
            const zoom=async value=>{
                const commits=controller.metrics.commits.length;
                if(input!=='desktop')touch(surface,'touchstart',2);
                if(input==='silent-touch')surface.map.getZoom=()=>value;
                else surface.setZoom(value);
                if(input!=='desktop')touch(surface,'touchend',0);
                await until(()=>!controller.renderQueue.busy&&!controller.isTouchCameraActive()
                    &&controller.metrics.commits.length>commits&&controller.metrics.commits.at(-1)?.reason==='camera','settled camera commit');
            };
            // A final camera request can supersede all intermediate refine
            // requests. Physical touch also deliberately defers DOM updates.
            await zoom(13.1);
            const partial=controller.entries.get('place:1').node;
            const remaining=Math.abs(partial.coordinate[0]-detail.longitude);
            assert(remaining<.002-1e-7&&remaining>1e-7,input+': final camera commit advances partial coordinate refinement');
            await zoom(13.05);
            assert(Math.abs(controller.entries.get('place:1').node.coordinate[0]-partial.coordinate[0])<1e-7,input+': zooming out keeps the current anchor');
            await zoom(13.4);
            const final=controller.entries.get('place:1').node;
            assert(Math.abs(final.coordinate[0]-detail.longitude)<1e-7,input+': continued zoom releases the temporary anonymous anchor');
            assert(!final.sourceCoordinate,input+': accurate coordinates no longer retain a temporary source');
            await zoom(14);
            assert(controller.snapshot.logicalZoom===14,input+': anchor refinement does not freeze cluster topology');
            results.push({input,initialError:.002,partialError:remaining,finalError:Math.abs(final.coordinate[0]-detail.longitude)});
        } catch(error){failures.push(error.message);}
        finally{controller.destroy();surface.destroy();}
    }
    if(failures.length)throw new Error(failures.join('; '));
    return {passed:true,results};
}
