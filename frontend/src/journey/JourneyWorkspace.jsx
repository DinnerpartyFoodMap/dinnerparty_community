import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {request} from './feedback';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import {useOverlayEntry} from '../components/overlay/MotionSurface';
import {useConfirm} from "../components/feedback/Confirm";
import {useTips} from "../components/feedback/Tips";
import {getTokenUserId} from '../platform/credentialStore';
import {getThemeColor,getThemeSecondary,pickContrastTextColor,DEFAULT_PRIMARY,DEFAULT_SECONDARY} from "../theme/theme";
import JourneyEntrySheet from './JourneyEntrySheet';
import JourneyComposer from './JourneyComposer';
import JourneyGeneration from './JourneyGeneration';
import JourneyReview from './JourneyReview';
import JourneyCalendar from './JourneyCalendar';
import JourneyDetail from './JourneyDetail';
import JourneyUnfinished,{JourneyMedia} from './JourneyUnfinished';
import JourneyShare from './JourneyShare';
import JourneyCommunity from './JourneyCommunity';
import PublicJourneyView from './PublicJourneyView';
import {invalidatePlaceDiaries} from './PlaceDiaryList';
import {loadUnfinished} from './JourneyUnfinished';
import './journey.css';
import { t, tx } from '../i18n/index.js';

const PAGES={composer:JourneyComposer,generation:JourneyGeneration,review:JourneyReview,calendar:JourneyCalendar,detail:JourneyDetail,
    unfinished:JourneyUnfinished,media:JourneyMedia,share:JourneyShare,community:JourneyCommunity,public:PublicJourneyView};
const LABELS={composer:t('journey:common.feature.generate'),generation:t('journey:common.action.generateDraft'),review:t('journey:workspace.label.review'),calendar:t('journey:common.feature.calendar'),detail:t('journey:workspace.label.detail'),unfinished:t('journey:workspace.label.unfinished'),media:t('journey:common.feature.privateImages'),share:t('journey:common.action.generateShare'),community:t('journey:common.feature.community'),public:t('journey:workspace.label.publicDiary')};
// 公开日记无需登录即可阅读；其余页面属于个人内容
const PUBLIC_PAGES=new Set(['public']);
let pageSeq=0;
const entryOf=(page,params={})=>({key:`${page}-${++pageSeq}`,page,params});
function readPalette(){
    const primary=getThemeColor()||DEFAULT_PRIMARY,secondary=getThemeSecondary()||DEFAULT_SECONDARY;
    return {primary,secondary,onPrimary:pickContrastTextColor(primary),onSecondary:pickContrastTextColor(secondary)};
}

/**
 * 日记导航协调层：入口操作弹窗 → 三个独立的全屏页面（图文生成、日历、同好）及其下级页面。
 * 页面栈与系统返回 / Esc / 页面返回按钮共用：先关闭最上层浮层，再逐页返回，最后回到地图。
 * 下层页面保持挂载（隐藏且不可交互），返回时保留月份、选中日期与滚动位置。
 */
export default React.forwardRef(function JourneyWorkspace({backendUrl:base,token,isAuthenticated,onRequireAuth,mapRef,mapReady,selectedPlace,feedback,onOpen,onShowPlace,onOpenFeedback,initialPublic,mapPicker:MapPicker},ref) {
    const [palette,setPalette]=useState(readPalette);
    useEffect(()=>{const update=()=>setPalette(readPalette());window.addEventListener('themechange',update);return()=>window.removeEventListener('themechange',update);},[]);
    const confirm=useConfirm(),tip=useTips();
    const [entryOpen,setEntryOpen]=useState(false),[counts,setCounts]=useState(null);
    const [stack,setStack]=useState([]),[mapView,setMapView]=useState(null);
    const [cap,setCap]=useState({});
    const backHandlers=useRef(new Map());
    const authed=!!(isAuthenticated&&token);
    const api=useCallback((path,options)=>request(base,token,`/api/journeys${path}`,options),[base,token]);
    useEffect(()=>{if(authed)api('/capabilities').then(setCap).catch(()=>{});},[authed,api]);
    const requireAuth=useCallback(page=>{if(PUBLIC_PAGES.has(page)||authed)return true;onRequireAuth?.();return false;},[authed,onRequireAuth]);

    const close=useCallback(()=>{setStack([]);setMapView(null);},[]);
    const navFor=useCallback(key=>({
        push:(page,params)=>{if(requireAuth(page))setStack(s=>[...s,entryOf(page,params)]);},
        replace:(page,params)=>{if(requireAuth(page))setStack(s=>{const i=s.findIndex(e=>e.key===key);return i<0?s:[...s.slice(0,i),entryOf(page,params)];});},
        reset:(page,params)=>{if(requireAuth(page))setStack([entryOf(page,params)]);},
        pop:()=>setStack(s=>{const i=s.findIndex(e=>e.key===key);return i<0?s:s.slice(0,i);}),
        setParams:patch=>setStack(s=>s.map(e=>e.key===key?{...e,params:{...e.params,...patch}}:e)),
        // 返回到栈中已有的某页（例如详情 → 对应日期）；没有时以它为新的起点
        backTo:(page,params)=>setStack(s=>{
            const i=s.map(e=>e.page).lastIndexOf(page);
            return i<0?[entryOf(page,params)]:[...s.slice(0,i),{...s[i],params:{...s[i].params,...params}}];
        }),
        setBack:fn=>{if(fn)backHandlers.current.set(key,fn);else backHandlers.current.delete(key);},
        close
    }),[requireAuth,close]);
    const navs=useRef(new Map());
    const nav=key=>{if(!navs.current.has(key))navs.current.set(key,navFor(key));return navs.current.get(key);};
    useEffect(()=>{navs.current.clear();},[navFor]);
    useEffect(()=>{const keys=new Set(stack.map(e=>e.key));for(const key of navs.current.keys())if(!keys.has(key))navs.current.delete(key);},[stack]);

    const showPlace=useCallback(placeId=>{close();onShowPlace?.(placeId);},[close,onShowPlace]);
    const showJourneyOnMap=useCallback(journey=>setMapView(journey),[]);
    // 全屏地图选点：与地图首页相同的标记与搜索。结果为 {kind:'place',place} / {kind:'point',point}，取消为 null。
    const [picker,setPicker]=useState(null);
    const pickerRef=useRef(null);
    const finishPick=useCallback(result=>{const current=pickerRef.current;pickerRef.current=null;setPicker(null);current?.resolve(result);},[]);
    const pickOnMap=useCallback(options=>new Promise(resolve=>{
        if(!MapPicker){tip(t('journey:workspace.mapPickerUnavailable'));resolve(null);return;}
        pickerRef.current?.resolve(null);
        pickerRef.current={title:options?.title||t('common:action.pickOnMap'),center:options?.center&&Number.isFinite(options.center.lng)&&Number.isFinite(options.center.lat)?{lng:options.center.lng,lat:options.center.lat}:null,resolve};
        setPicker(pickerRef.current);
    }),[MapPicker,tip]);
    useEffect(()=>()=>pickerRef.current?.resolve(null),[]);
    // report：举报住民或公开日记，打开预填好的意见反馈表（叠在日记页面之上，提交或关闭后回到原页面）
    const ctx=useMemo(()=>({api,base,token,cap,mapRef,mapReady,selectedPlace,feedback,confirm,tip,showPlace,showJourneyOnMap,pickOnMap,report:onOpenFeedback,userId:getTokenUserId(token)}),
        [api,base,token,cap,mapRef,mapReady,selectedPlace,feedback,confirm,tip,showPlace,showJourneyOnMap,pickOnMap,onOpenFeedback]);

    const openEntry=useCallback(()=>{
        if(!authed){onRequireAuth?.();return;}
        setEntryOpen(true);onOpen?.();
        loadUnfinished(api,getTokenUserId(token)).then(r=>setCounts({count:r.total,material:r.material})).catch(()=>{});
    },[authed,onRequireAuth,onOpen,api,token]);
    // 同一篇已在最上层时不再叠一层（地址里保留着 ?diary=，重复处理同一链接也只打开一次）
    const openPublic=useCallback((publicId,stopId)=>{setEntryOpen(false);setMapView(null);setStack(s=>{const top=s[s.length-1];return top?.page==='public'&&top.params.publicId===publicId?s:[...s,entryOf('public',{publicId,stopId})];});},[]);
    React.useImperativeHandle(ref,()=>({open:openEntry,openPublic}),[openEntry,openPublic]);
    useEffect(()=>{if(initialPublic?.publicId)openPublic(initialPublic.publicId,initialPublic.stopId);},[initialPublic,openPublic]);
    // 地图上的地点详情等模块通过事件进入日记，避免层层传递回调
    useEffect(()=>{
        const handler=e=>{
            const detail=e.detail||{};
            if(detail.kind==='public')openPublic(detail.publicId,detail.stopId);
            if(detail.kind==='record-place'&&detail.place){
                if(!authed){onRequireAuth?.();return;}
                const p=detail.place;
                setStack(s=>[...s,entryOf('composer',{preset:{center:{name:p.name,city:'',lng:Number(p.longitude),lat:Number(p.latitude),source:'place'}}})]);
            }
        };
        const blocked=()=>tip(t('journey:workspace.unsyncedBlocked'));
        const changed=()=>invalidatePlaceDiaries();
        window.addEventListener('journey:open',handler);window.addEventListener('journey:leave-blocked',blocked);window.addEventListener('journey:places-changed',changed);
        return()=>{window.removeEventListener('journey:open',handler);window.removeEventListener('journey:leave-blocked',blocked);window.removeEventListener('journey:places-changed',changed);};
    },[openPublic,authed,onRequireAuth,tip]);

    const selectEntry=id=>{setEntryOpen(false);setStack([entryOf(id,{})]);};
    const top=stack[stack.length-1];
    // 系统返回 / Esc：交给当前页（例如素材落盘、未同步确认），默认返回上一页
    const onPanelClose=()=>{
        if(!top)return;
        const handler=backHandlers.current.get(top.key);
        if(handler)return handler();
        setStack(s=>s.slice(0,-1));
    };

    // 「在地图中查看」：在主地图上叠加编号与顺序虚线，与餐馆标记层相互独立
    useEffect(()=>{
        const map=mapRef?.current,AMap=window.AMap;
        if(!mapView||!mapReady||!map||!AMap)return undefined;
        const overlays=[],stops=mapView.document.stops;
        stops.forEach((s,index)=>{
            if(!Number.isFinite(s.lng)||!Number.isFinite(s.lat))return;
            const content=window.document.createElement('div');content.textContent=String(index+1);content.title=s.name;content.className='jw-map-dot';
            Object.assign(content.style,{background:palette.primary,color:palette.onPrimary});
            overlays.push(new AMap.Marker({position:[s.lng,s.lat],content,offset:new AMap.Pixel(-15,-15),zIndex:300}));
            const previous=stops.slice(0,index).reverse().find(p=>Number.isFinite(p.lng)&&Number.isFinite(p.lat));
            if(previous)overlays.push(new AMap.Polyline({path:[[previous.lng,previous.lat],[s.lng,s.lat]],strokeColor:palette.primary,strokeWeight:4,strokeStyle:'dashed',zIndex:150}));
        });
        map.add(overlays);
        try{map.setFitView?.(overlays.filter(o=>o instanceof AMap.Marker),false,[80,80,120,80],16);}catch{/* 旧版 SDK */}
        return()=>{try{map.remove(overlays);}catch{/* 地图已销毁 */}};
    },[mapView,mapReady,mapRef,palette]);
    useOverlayEntry(mapView?{onClose:()=>setMapView(null),modal:false,kind:'journey-map-view',label:t('journey:workspace.mapViewLabel'),suspendNative:false}:false);

    const style={'--journey-on-primary':palette.onPrimary};
    return <>
        {!entryOpen&&!stack.length&&!mapView&&<button type="button" className="journey-launch" data-tour="journey" style={style} onClick={openEntry}>{t('journey:workspace.launcher')}</button>}
        {mapView&&<button type="button" className="journey-launch journey-launch--visible" style={style} onClick={()=>setMapView(null)}>{tx('journey:workspace.backToDiary', { title: mapView.document.title })}</button>}
        <JourneyEntrySheet open={entryOpen} counts={counts} onSelect={selectEntry} onClose={()=>setEntryOpen(false)}/>
        <ResponsivePanel open={stack.length>0&&!mapView} onClose={onPanelClose} label={top?LABELS[top.page]:t('journey:common.feature.diary')} kind="journey" desktop="full" mobile="full"
            draggable={false} plain showClose={false} dismissOnBackdrop={false} bodyStyle={{padding:0,overflow:'hidden',display:'flex',flexDirection:'column'}}>
            <div className="jw-root" style={style}>
                {stack.map((entry,index)=>{
                    const Page=PAGES[entry.page],isTop=index===stack.length-1;
                    return <div key={entry.key} className={`jw-layer${isTop?' is-top':''}`} inert={isTop?undefined:''} aria-hidden={isTop?undefined:true}
                        data-native-back-content={isTop&&stack.length>1?'':undefined} data-native-back-previous={index===stack.length-2?'':undefined}>
                        <Page ctx={ctx} nav={nav(entry.key)} params={entry.params} active={isTop}/>
                    </div>;
                })}
            </div>
        </ResponsivePanel>
        {MapPicker&&<MapPicker open={!!picker&&stack.length>0} title={picker?.title} center={picker?.center} backendUrl={base} token={token} isAuthenticated={isAuthenticated} onRequireAuth={onRequireAuth}
            onPickPlace={place=>finishPick({kind:'place',place})} onPickPoint={point=>finishPick({kind:'point',point})} onClose={()=>finishPick(null)}/>}
    </>;
});
