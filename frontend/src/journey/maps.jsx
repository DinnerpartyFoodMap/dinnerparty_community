import React,{useEffect,useRef,useState} from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import {loadAmap} from '../platform/amapLoader';
import {getRuntimeConfig} from '../platform/runtimeConfig';
import {OverseasTileLayer} from '../map/overseasTileLayer';
import {getCurrentLocation,describeLocationError} from '../platform/geolocation';
import {centerLabel} from './shared';
import { t, tx } from '../i18n/index.js';
import { searchExternalPlaces } from '../discovery/externalSearch.js';
import { useExternalSearch } from '../discovery/hooks/useExternalSearch.js';

// 日记里的地图能力：搜索中心选择与行程预览；地图选点使用与地图首页相同的全屏选点器（ctx.pickOnMap）。所有坐标均为 GCJ-02（与高德地图一致），
// 设备定位已在 platform/geolocation 中统一转换，这里不再二次转换。

const isDark=()=>document.documentElement.dataset.theme==='dark';
const timeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),ms))]);
function shortAddress(address) {
    return String(address||'').replace(/^.+?(省|自治区)/,'').replace(/^.+?市/,'').slice(0,40);
}
/** 坐标反查可读地名；失败时返回空名称，调用方显示“已选地图位置”并保留坐标。 */
export async function reverseGeocode(lng,lat,base) {
    try{
        const AMap=await timeout(loadAmap(),6000);
        if(AMap?.plugin){
            const result=await timeout(new Promise((resolve,reject)=>AMap.plugin('AMap.Geocoder',()=>{
                try{new AMap.Geocoder({radius:300,extensions:'all'}).getAddress([lng,lat],(status,res)=>status==='complete'&&res?.regeocode?resolve(res.regeocode):reject(new Error(String(status))));}
                catch(e){reject(e);}
            })),8000);
            const c=result.addressComponent||{};
            const city=(typeof c.city==='string'&&c.city)||(typeof c.province==='string'?c.province:'');
            const near=result.aois?.[0]?.name||result.pois?.[0]?.name||'';
            return {name:near||[c.district,c.township].filter(v=>typeof v==='string').join('')||shortAddress(result.formattedAddress),city,address:result.formattedAddress||''};
        }
    }catch{/* 退回服务端逆地理编码 */}
    try{
        const response=await fetch(`${base}/api/amap/regeo?location=${lng.toFixed(6)},${lat.toFixed(6)}`);
        if(response.ok){const data=await response.json();return {name:shortAddress(data.formatted_address),city:'',address:data.formatted_address||''};}
    }catch{/* 无法反查时保留坐标 */}
    return {name:'',city:'',address:''};
}
/** Explicit city/address search shares the server-side search budget. */
export async function searchAddress(keyword,city,base=getRuntimeConfig().apiBaseUrl) {
    const places=await searchExternalPlaces(base,{q:keyword,city,source:'journey_address'});
    return places.map(p=>({...p,lng:p.longitude,lat:p.latitude}));
}

/** 内嵌地图：独立实例，与主地图的标记层互不影响；卸载时销毁。 */
function useEmbeddedMap(ref,{center,zoom=15,onReady}) {
    const [state,setState]=useState('loading');
    const readyRef=useRef(onReady);readyRef.current=onReady;
    useEffect(()=>{
        let map,overseas,cancelled=false;
        loadAmap().then(AMap=>{
            if(cancelled||!ref.current)return;
            if(!AMap?.Map){setState('unavailable');return;}
            map=new AMap.Map(ref.current,{zoom,center:center?[center.lng,center.lat]:undefined,resizeEnable:true,mapStyle:isDark()?'amap://styles/dark':undefined});
            overseas=new OverseasTileLayer(map,{apiKey:getRuntimeConfig().cartoApiKey,dark:isDark()});
            setState('ready');readyRef.current?.(map,AMap);
        }).catch(()=>{if(!cancelled)setState('unavailable');});
        return()=>{cancelled=true;overseas?.destroy();try{map?.destroy();}catch{}};
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[]);
    return state;
}

/**
 * 搜索中心：当前位置 / 搜索城市或地址 / 地图选点 / 暂不设置。选定后作为本次固定上下文，浏览底图不会改变它。
 */
export function LocationPicker({open,value,base,mapRef,pickOnMap,onChange,onClose}) {
    const [query,setQuery]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState('');
    const addressSearch=useExternalSearch(query,`${open}:${value?.city||''}`,base);
    const results=addressSearch.loaded?addressSearch.results.map(p=>({...p,lng:p.longitude,lat:p.latitude})):null;
    const working=!!busy||addressSearch.loading;
    useEffect(()=>{if(open)setError('');},[open]);
    const locate=async()=>{
        setBusy('locate');setError('');
        try{
            const position=await getCurrentLocation({map:mapRef?.current});
            const place=await reverseGeocode(position.lng,position.lat,base);
            onChange({name:place.name,city:place.city,lng:position.lng,lat:position.lat,source:'current'});
        }catch(e){setError(describeLocationError(e));}
        finally{setBusy('');}
    };
    const search=e=>{
        e?.preventDefault();
        if(!query.trim()||working)return;
        setError('');
        void addressSearch.search({city:value?.city,source:'journey_address'});
    };
    // 全屏地图上选中的地点或图钉位置；城市只用于判断候选是否同城，读取不到时留空
    const pickFromMap=async()=>{
        const result=await pickOnMap?.({title:t('journey:maps.pickCenterTitle'),center:value});
        if(!result)return;
        const point=result.kind==='place'?{lng:Number(result.place.longitude),lat:Number(result.place.latitude)}:result.point;
        setBusy('map');setError('');
        try{
            const place=await reverseGeocode(point.lng,point.lat,base);
            onChange({name:result.kind==='place'?result.place.name:place.name,city:place.city,lng:point.lng,lat:point.lat,source:'map'});
        }finally{setBusy('');}
    };
    return <>
        <ResponsivePanel open={open} onClose={onClose} title={t('journey:maps.title')} kind="journey-location" desktop="center" mobile="sheet" width="min(480px, calc(100vw - 24px))">
            <div className="jw-stack jw-pad">
                <p className="jw-muted">{t('journey:maps.hint')}</p>
                {value&&<div className="jw-current-value"><span>{tx('journey:maps.current', { centerLabel: centerLabel(value) })}</span></div>}
                <button type="button" className="jw-option" disabled={working} onClick={locate}>{busy==='locate'?t('journey:maps.locating'):t('journey:maps.useCurrentLocation')}</button>
                <form className="jw-search" onSubmit={search} role="search">
                    <input aria-label={t('journey:maps.searchLabel')} placeholder={t('journey:maps.searchPlaceholder')} value={query} maxLength={60} onChange={e=>setQuery(e.target.value)}/>
                    <button type="submit" disabled={working||!query.trim()||addressSearch.loaded}>{addressSearch.loading?t('journey:maps.searching'):t('common:action.search')}</button>
                </form>
                {results&&(results.length?<ul className="jw-result-list" aria-label={t('journey:maps.resultsLabel')}>{results.map(r=><li key={r.id||`${r.lng},${r.lat}`}>
                    <button type="button" onClick={()=>onChange({name:r.name,city:r.city,lng:r.lng,lat:r.lat,source:'search'})}><strong>{r.name}</strong><small>{r.address}</small></button>
                </li>)}</ul>:<p className="jw-muted">{t('journey:maps.noResults')}</p>)}
                <button type="button" className="jw-option" disabled={working} onClick={pickFromMap}>{busy==='map'?t('journey:maps.readingSelection'):t('journey:maps.pickOnMap')}</button>
                {(error||addressSearch.error)&&<p className="jw-error-text" role="alert">{error||addressSearch.error}</p>}
                <div className="jw-actions">
                    <button type="button" onClick={()=>onChange(null)}>{t('journey:maps.skip')}</button>
                    <button type="button" onClick={onClose}>{t('common:action.cancel')}</button>
                </div>
            </div>
        </ResponsivePanel>
    </>;
}

/** 行程顺序预览：编号标记 + 虚线（顺序示意）。未定位站点不绘制位置。 */
export function StopMapPreview({stops,activeId,onSelect}) {
    const ref=useRef(null),mapRef=useRef(null),overlays=useRef([]);
    const located=stops.filter(s=>Number.isFinite(s.lng)&&Number.isFinite(s.lat));
    const state=useEmbeddedMap(ref,{center:located[0]||null,zoom:14,onReady:map=>{mapRef.current=map;draw();}});
    const draw=()=>{
        const map=mapRef.current,AMap=window.AMap;
        if(!map||!AMap)return;
        try{map.remove(overlays.current);}catch{}
        const list=[];
        stops.forEach((s,index)=>{
            if(!Number.isFinite(s.lng)||!Number.isFinite(s.lat))return;
            const content=document.createElement('button');
            content.type='button';content.textContent=String(index+1);content.className=`jw-map-dot${s.id===activeId?' is-active':''}`;
            content.setAttribute('aria-label',t('journey:maps.stopLabel', { index: index+1, name: s.name }));
            const marker=new AMap.Marker({position:[s.lng,s.lat],content,offset:new AMap.Pixel(-15,-15),zIndex:300});
            marker.on('click',()=>onSelect?.(s.id));list.push(marker);
            const previous=stops.slice(0,index).reverse().find(p=>Number.isFinite(p.lng)&&Number.isFinite(p.lat));
            if(previous)list.push(new AMap.Polyline({path:[[previous.lng,previous.lat],[s.lng,s.lat]],strokeColor:getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim()||'#E2789F',strokeWeight:4,strokeStyle:'dashed',zIndex:150}));
        });
        overlays.current=list;
        if(list.length){map.add(list);try{map.setFitView(list.filter(o=>o instanceof AMap.Marker),false,[40,40,40,40],16);}catch{}}
    };
    useEffect(draw,[JSON.stringify(stops.map(s=>[s.id,s.lng,s.lat])),activeId]);
    return <div className="jw-mini-map">
        <div ref={ref} className="jw-mini-map__canvas" aria-label={t('journey:maps.previewLabel')}/>
        {state==='unavailable'&&<div className="jw-mini-map__fallback">{t('journey:maps.mapUnavailable')}</div>}
        {!located.length&&state==='ready'&&<div className="jw-mini-map__fallback">{t('journey:maps.noLocated')}</div>}
        <small className="jw-mini-map__note">{t('journey:maps.previewNote')}</small>
    </div>;
}
