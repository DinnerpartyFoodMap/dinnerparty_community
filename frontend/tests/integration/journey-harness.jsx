import React,{useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import JourneyWorkspace from "../../src/journey/JourneyWorkspace";
import PlaceDetailPanel from "../../src/places/components/PlaceDetailPanel";
import {MotionProvider} from "../../src/motion/MotionProvider";
import {OverlayHost} from "../../src/components/overlay/OverlayHost";
import MotionSurface from "../../src/components/overlay/MotionSurface";
import {ConfirmProvider} from "../../src/components/feedback/Confirm";
import TipsProvider from "../../src/components/feedback/Tips";
import {useMapFeedback,Exposure} from "../../src/journey/feedback";
import {preserveJourneyBeforeLeave} from "../../src/journey/navigation";
window.__TEST_LEAVE=preserveJourneyBeforeLeave;
import {applyDarkMode,applyThemeColors,resolveThemePrimary,resolveThemeSecondary} from "../../src/theme/theme";
window.__TEST_THEME=(dark,custom={})=>{applyDarkMode(dark);applyThemeColors(resolveThemePrimary(custom),resolveThemeSecondary(custom));};
// 只替换高德 SDK：标记、折线、内嵌地图、地点搜索、逆地理编码与定位都是可预测的替身。
class Marker {constructor(options){this.options=options;}on(event,handler){if(event==='click')this.options.content.addEventListener('click',handler);}}
class Polyline {constructor(options){this.options=options;}}
class FakeMap {
    constructor(el,options={}){this.el=el;this.center=options.center||[120,30];this.handlers={};el.dataset.fakeMap='1';
        Object.assign(el.style,{background:'repeating-linear-gradient(45deg,#d9e6dd,#d9e6dd 12px,#e8f0ea 12px,#e8f0ea 24px)'});
        window.__TEST_FAKE_MAP=this;}
    getCenter(){const [lng,lat]=this.center;return {getLng:()=>lng,getLat:()=>lat};}
    setCenter(c){this.center=Array.isArray(c)?c:[c.lng,c.lat];(this.handlers.moveend||[]).forEach(h=>h());}
    setZoomAndCenter(_z,c){this.setCenter(c);}
    on(event,handler){(this.handlers[event]=this.handlers[event]||[]).push(handler);}
    off(){} add(){} remove(){} destroy(){} setFitView(){}
}
window.AMap={Marker,Polyline,Map:FakeMap,Pixel:class {},plugin:(_name,callback)=>callback(),
    // Reverse geocoding answers after a delay, as the real service does, so stale-address races are observable.
    Geocoder:class {getAddress(_p,callback){setTimeout(()=>callback('complete',{regeocode:{formattedAddress:'测试省测试市测试区大学城路 1 号',addressComponent:{city:'测试市',province:'测试省',district:'测试区',township:'大学城街道'},aois:[{name:'测试大学城'}]}}),Number(window.__TEST_GEOCODE_DELAY||300));}},
    PlaceSearch:class {search(keyword,callback){callback('complete',{poiList:{pois:[{id:'poi1',name:`${keyword}商圈`,address:'测试路 8 号',cityname:'测试市',location:{lng:120.01,lat:30.01}}]}});}},
    Geolocation:class {getCurrentPosition(callback){callback('complete',{position:{lng:120.003,lat:30.002},accuracy:20});}}};
const PLACE={id:1,name:'测试面馆',category:'面食',description:'一家测试用的面馆',longitude:120,latitude:30};
const OTHER_PLACE={id:2,name:'屏幕外餐馆',category:'面食',description:'',longitude:120,latitude:30};
// 全屏地图选点的替身：与真实选点器同样的约定（站内标记、高德搜索结果、中心图钉、返回），并显示打开时的中心位置。
function FakeMapPicker({open,title,center,onPickPlace,onPickPoint,onClose}){
    return <MotionSurface show={open} portal preset="sheet" overlay={{onClose,modal:true,kind:'journey-map-picker',label:title}} aria-label={title}
        style={{position:'absolute',inset:0,background:'var(--color-bg-base)',color:'var(--color-text-primary)',padding:20,display:'flex',flexDirection:'column',gap:8,alignItems:'flex-start'}}>
        <div data-testid="fake-map-picker" style={{display:'flex',flexDirection:'column',gap:8,alignItems:'flex-start'}}>
            <strong>{title}</strong>
            <span>中心：{center?`${center.lng},${center.lat}`:'未指定'}</span>
            <button type="button" onClick={()=>onPickPlace({...PLACE})}>选择测试面馆</button>
            <button type="button" onClick={()=>onPickPlace({id:'amap_B0PICK',name:'高德选中的店',longitude:120.02,latitude:30.02,address:'高德路 1 号',isMarked:false})}>选择高德地点</button>
            <button type="button" onClick={()=>onPickPoint({lng:121,lat:31})}>选图钉位置</button>
            <button type="button" onClick={onClose}>返回日记</button>
        </div>
    </MotionSurface>;
}
function Harness(){
    const token=window.__TEST_TOKEN;
    const feedback=useMapFeedback('',token);
    window.__TEST_FEEDBACK=feedback;
    const [detail,setDetail]=useState(null),[shown,setShown]=useState('');
    const map=useMemo(()=>({getCenter:()=>({getLng:()=>120,getLat:()=>30}),setCenter(){},setZoomAndCenter(){},setFitView(){},
        add(items){const layer=document.getElementById('map-layer');items.forEach(i=>{if(i.options.content)layer.appendChild(i.options.content);});},
        remove(items){items.forEach(i=>i.options.content?.remove());},
        on(event,handler){if(event==='click')window.__TEST_MAP_CLICK=handler;},
        off(event){if(event==='click')delete window.__TEST_MAP_CLICK;}}),[]);
    const mapRef=useRef(map),journeyRef=useRef(null);
    return <main style={{position:'relative',width:'100vw',height:'100vh',background:'var(--color-bg-base)',color:'var(--color-text-primary)'}}><h1 style={{padding:20,font:'24px sans-serif',margin:0}}>地图日记 · 隔离测试</h1>
        <div style={{position:'absolute',left:20,top:90,width:230,height:65,overflow:'auto'}}>
            <Exposure feedback={feedback} placeId={1} surface="search" rank={0} style={{height:50,background:'var(--color-bg-surface)',padding:8}} onClick={()=>feedback.record('click','search',1)}>测试曝光卡片</Exposure>
            <div style={{height:600}}/><Exposure feedback={feedback} placeId={2} surface="search" rank={1}>屏幕外测试卡片</Exposure>
        </div>
        <div style={{position:'absolute',left:270,right:8,top:90,display:'flex',flexWrap:'wrap',gap:8}}>
            <button type="button" onClick={()=>setDetail(PLACE)}>打开测试面馆详情</button>
            <button type="button" onClick={()=>setDetail(OTHER_PLACE)}>切换到屏幕外餐馆</button>
            <button type="button" onClick={()=>journeyRef.current?.open()}>打开日记入口</button>
            <span data-testid="shown-place">{shown}</span>
        </div>
        <div id="map-layer" style={{position:'absolute',left:'15%',top:'25%'}}/>
        <JourneyWorkspace ref={journeyRef} backendUrl="" token={token} isAuthenticated mapRef={mapRef} mapReady feedback={feedback} selectedPlace={{...PLACE}}
            onShowPlace={id=>setShown(`已定位地图标记 ${id}`)} mapPicker={FakeMapPicker}/>
        <PlaceDetailPanel open={!!detail} place={detail} backendUrl="" onClose={()=>setDetail(null)}/>
    </main>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost><TipsProvider><ConfirmProvider><Harness/></ConfirmProvider></TipsProvider></OverlayHost></MotionProvider>);
