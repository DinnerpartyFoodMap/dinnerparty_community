import { MarkerLayerController } from '../../src/map/MarkerLayerController.js';
import { tileOf,lngOf,latOf } from '../../src/map/markerTiles.js';
import { until,wait } from './map-test-surface.js';

// Real SDK positioning and the real worker must release a named place from its
// temporary anonymous-cell anchor when the committed camera advances.
export async function runAmapAnchorTests() {
    const response=await fetch('/__map-amap-config');
    if(!response.ok)throw new Error('AMap public configuration unavailable for the anchor test');
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
    const [x,y]=tileOf(120,30,14);
    const anonymousCoordinate=[lngOf(x+.5,14),latOf(y+.5,14)];
    const actualCoordinate=[anonymousCoordinate[0]-.002,anonymousCoordinate[1]];
    const anonymous={aggregateKey:`agg:14/${x}/${y}#0`,aggregate:true,aggregateCell:[14,x,y],
        longitude:anonymousCoordinate[0],latitude:anonymousCoordinate[1]};
    const named={id:1,name:'Named anchor fixture',longitude:actualCoordinate[0],latitude:actualCoordinate[1]};
    const container=document.createElement('div');
    container.style.cssText='position:relative;width:1100px;height:700px';
    document.body.appendChild(container);
    const map=new window.AMap.Map(container,{center:actualCoordinate,zoom:12,viewMode:'2D'});
    let ready=false;map.on('complete',()=>{ready=true;});
    let controller;
    const samples=[],trace=[];
    const assert=(ok,label)=>{
        if(!ok)throw new Error(label+' '+JSON.stringify({samples,trace}));
    };
    const sameCoordinate=(a,b)=>a&&a.every((value,axis)=>Math.abs(value-b[axis])<1e-7);
    const sample=(label,target)=>{
        const entry=controller.entries.get('place:1');
        assert(entry?.node.kind==='place'&&entry.node.place?.name===named.name,label+': named place exists');
        assert(entry.parts.root.isConnected&&entry.parts.label.textContent===named.name,label+': named marker is attached');
        const origin=entry.parts.root.getBoundingClientRect(),box=container.getBoundingClientRect();
        const projected=map.lngLatToContainer(target);
        const expected={x:projected.getX(),y:projected.getY()};
        const rendered={x:origin.left-box.left,y:origin.top-box.top};
        const error=Math.hypot(rendered.x-expected.x,rendered.y-expected.y);
        const result={label,zoom:map.getZoom(),logicalZoom:controller.snapshot.logicalZoom,
            coordinate:entry.node.coordinate,expected,rendered,error};
        samples.push(result);
        assert(sameCoordinate(entry.node.coordinate,target),label+': named coordinate matches its geographic target');
        assert(origin.width<.01&&origin.height<.01,label+': marker root remains a zero-size geographic origin');
        assert(error<=2,label+': named marker DOM aligns within two CSS pixels of its geographic target');
        return entry;
    };
    const cameraIdle=zoom=>Math.abs(map.getZoom()-zoom)<1e-6&&!controller.cameraMoving&&!controller.isTouchCameraActive();
    try {
        await until(()=>ready,'real AMap initial load');await wait(500);
        controller=new MarkerLayerController(map,{onMetric:(kind,value)=>{
            if(kind==='commits')trace.push({zoom:map.getZoom(),...value});
        }});
        controller.update({places:[anonymous],markerBand:{kind:'aggregate',tile:8,cell:14,minZoom:0,maxZoom:12}});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy,'anonymous cell marker');
        map.setZoomAndCenter(13,actualCoordinate,true);
        await wait(40);await until(()=>cameraIdle(13),'real camera enters the detail band');
        controller.update({places:[named],markerBand:{kind:'leaf',tile:12,minZoom:13}});
        await until(()=>controller.snapshot?.dataRevision===controller.dataRevision&&!controller.renderQueue.busy
            &&!controller.txns.size&&!controller.cleanupQueue.busy,'named place replaces anonymous cell');
        await wait(32);
        const initial=sample('band-switch anchor',anonymousCoordinate);
        assert(initial.node.sourceCoordinate&&sameCoordinate(initial.node.sourceCoordinate,actualCoordinate),
            'the initial named marker records its precise source coordinate');
        for(const zoom of [14,16]){
            const commits=controller.metrics.commits.length;
            map.setZoomAndCenter(zoom,actualCoordinate,true);
            await until(()=>cameraIdle(zoom)&&controller.snapshot.logicalZoom===zoom
                &&controller.metrics.commits.length>commits&&!controller.renderQueue.busy
                &&!controller.txns.size&&!controller.cleanupQueue.busy,'precise named marker at zoom '+zoom);
            await wait(32);
            const entry=sample('settled zoom '+zoom,actualCoordinate);
            assert(!entry.node.sourceCoordinate,'zoom '+zoom+': temporary anonymous anchor is released');
        }
        return {passed:true,map:'AMap',fixture:'one anonymous cell to one named precise place',samples,commits:trace};
    } finally {controller?.destroy();map.destroy();container.remove();}
}
