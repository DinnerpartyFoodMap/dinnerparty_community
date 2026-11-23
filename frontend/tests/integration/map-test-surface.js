export const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
export async function until(predicate,label) {
    const deadline=performance.now()+12000;
    while (!predicate()) {
        if(performance.now()>deadline)throw new Error('Timed out: '+label);
        await wait(10);
    }
}
export function createMapSurface(initialZoom=12, {project:projectOverride} = {}) {
    const container=document.createElement('div');
    container.style.cssText='position:relative;width:1100px;height:700px;overflow:hidden';
    document.body.appendChild(container);
    let zoom=initialZoom;
    const events=new Map(),attached=new Set(),stats={maxAdd:0,maxRemove:0,created:0};
    const scale=()=>256*2**zoom/360;
    const project=projectOverride || (point=>({x:550+(point[0]-120)*scale(),y:350-(point[1]-30)*scale()}));
    const map={
        getContainer:()=>container,getZoom:()=>zoom,getZooms:()=>[2,20],
        getBounds:()=>({getSouthWest:()=>({lng:119.8,lat:29.8}),getNorthEast:()=>({lng:120.2,lat:30.2})}),
        lngLatToContainer:project,
        on:(name,fn)=>{if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},
        off:(name,fn)=>events.get(name)?.delete(fn),
        add:markers=>{stats.maxAdd=Math.max(stats.maxAdd,markers.length);for(const m of markers){attached.add(m);container.appendChild(m.wrapper);m.render();}},
        remove:markers=>{stats.maxRemove=Math.max(stats.maxRemove,markers.length);for(const m of markers){attached.delete(m);m.wrapper.remove();}}
    };
    class Marker {
        constructor(options){stats.created++;this.coordinate=options.position;this.events={};this.wrapper=document.createElement('div');this.wrapper.style.position='absolute';this.wrapper.appendChild(options.content);}
        on(name,fn){this.events[name]=fn;}
        setzIndex(z){this.wrapper.style.zIndex=z;}
        setPosition(point){this.coordinate=point;this.render();}
        setMap(value){if(!value){attached.delete(this);this.wrapper.remove();}}
        render(){const point=project(this.coordinate);this.wrapper.style.left=point.x+'px';this.wrapper.style.top=point.y+'px';}
    }
    window.AMap={Marker,Pixel:class {constructor(x,y){this.x=x;this.y=y;}}};
    const emit=name=>{for(const fn of events.get(name)||[])fn();};
    return {map,container,stats,attached,emit,
        setZoom(value){emit('zoomstart');zoom=value;for(const m of attached)m.render();emit('zoomchange');emit('zoomend');},
        destroy(){container.remove();}
    };
}
