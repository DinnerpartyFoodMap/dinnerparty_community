import React,{useEffect,useRef,useState} from 'react';
import {getApiBaseUrl} from '../platform/runtimeConfig';
import {peekToken,getTokenUserId} from '../platform/credentialStore';
import {PublicPhoto,MarkdownText,formatRange} from './shared';
import './journey.css';
import { t, tx } from '../i18n/index.js';

// 地点详情中的「相关日记」：只读取仍公开的日记片段；计数按不同日记计算。
// 打开整篇日记、记录这家店都交给日记模块（通过窗口事件，不经地图组件层层传递）。
export function openJourney(detail) {window.dispatchEvent(new CustomEvent('journey:open',{detail}));}

// 登录时带上身份：后端按读者过滤其屏蔽的住民写的日记。缓存按读者分开，切换账号或退出后不会沿用别人的结果。
function viewer() {
    const token=peekToken();
    return {key:getTokenUserId(token)||'guest',headers:token?{Authorization:`Bearer ${token}`}:{}};
}
const cache=new Map();
const cacheKey=(placeId,who)=>`${who}:${placeId}`;
/** 地点小卡用的相关日记数量；同一地点短时间内复用结果。 */
export function usePlaceDiaryCount(placeId,base=getApiBaseUrl()) {
    const [count,setCount]=useState(()=>cache.get(cacheKey(placeId,viewer().key))?.total??0);
    useEffect(()=>{
        if(placeId==null||!Number.isSafeInteger(Number(placeId))||String(placeId).startsWith('amap_')){setCount(0);return undefined;}
        const who=viewer(),key=cacheKey(placeId,who.key);
        const hit=cache.get(key);
        if(hit&&Date.now()-hit.at<60000){setCount(hit.total);return undefined;}
        const controller=new AbortController();
        fetch(`${base}/places/${placeId}/diaries?limit=1`,{signal:controller.signal,headers:who.headers}).then(r=>r.ok?r.json():null)
            .then(data=>{if(data){cache.set(key,{total:data.total,at:Date.now()});setCount(data.total);}}).catch(()=>{});
        return()=>controller.abort();
    },[placeId,base]);
    return count;
}
export function invalidatePlaceDiaries() {cache.clear();}

export default function PlaceDiaryList({place,sectionRef,base=getApiBaseUrl()}) {
    const placeId=place?.id;
    const [state,setState]=useState({placeId,items:[],total:0,next:null,loading:true,error:''});
    const controller=useRef(null);
    // Every response is bound to the place it was requested for: switching places aborts the old request,
    // clears the list, and a late answer for another place (or page) is ignored.
    const load=async(cursor=null)=>{
        controller.current?.abort();
        const request=new AbortController();controller.current=request;
        setState(s=>({...s,placeId,loading:true,error:''}));
        try{
            const who=viewer();
            const response=await fetch(`${base}/places/${placeId}/diaries?limit=${cursor?10:3}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:request.signal,headers:who.headers});
            const data=await response.json();
            if(!response.ok)throw new Error(data.error||t('journey:placeDiaries.loadFailed'));
            if(controller.current!==request)return;
            cache.set(cacheKey(placeId,who.key),{total:data.total,at:Date.now()});
            setState(s=>s.placeId!==placeId?s:{placeId,items:cursor?[...s.items,...data.items]:data.items,total:data.total,next:data.next_cursor,loading:false,error:''});
        }catch(e){
            if(request.signal.aborted||controller.current!==request)return;
            setState(s=>s.placeId!==placeId?s:{...s,loading:false,error:e.message});
        }
    };
    useEffect(()=>{
        setState({placeId,items:[],total:0,next:null,loading:true,error:''});
        if(placeId!=null&&place.isMarked!==false)load();
        return()=>controller.current?.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[placeId,base]);
    if(!place||place.isMarked===false)return null;
    // Never render another place's list during the render before the reset effect runs.
    const view=state.placeId===placeId?state:{items:[],total:0,next:null,loading:true,error:''};
    return <section ref={sectionRef} className="jw-place-diaries" aria-label={t('journey:placeDiaries.label')}>
        <div className="jw-row-between"><strong>{tx('journey:placeDiaries.title', { count: view.total?t('journey:placeDiaries.count', { total: view.total }):'' })}</strong></div>
        {view.error&&<p className="jw-muted" role="alert">{view.error}</p>}
        {view.items.map(item=><article key={item.public_id} className="jw-diary-card">
            <div className="jw-author">
                {item.author.has_avatar?<img src={`${base}/users/${encodeURIComponent(item.author.id)}/avatar`} alt="" className="jw-avatar"/>:<span className="jw-avatar jw-avatar--empty" aria-hidden="true">{item.author.username.slice(0,1)}</span>}
                <span>{item.author.username}</span><small className="jw-muted">{item.record_date?formatRange(item.record_date):formatRange(item.start_date,item.end_date)}</small>
            </div>
            <strong>{item.title}</strong>
            {item.stops.map(s=>s.excerpt.map((e,i)=><MarkdownText key={`${s.stop_id}-${i}`} className={`jw-diary-card__excerpt${e.kind==='edited'?' is-edited':''}`} text={e.text}/>))}
            {!!item.media_ids.length&&<div className="jw-strip">{item.media_ids.map(id=><PublicPhoto key={id} publicId={item.public_id} id={id} base={base} className="jw-strip__img"/>)}</div>}
            <button type="button" className="jw-link" onClick={()=>openJourney({kind:'public',publicId:item.public_id,stopId:item.stops[0]?.stop_id})}>{t('journey:placeDiaries.viewFull')}</button>
        </article>)}
        {view.next&&<button type="button" disabled={view.loading} onClick={()=>load(view.next)}>{view.loading?t('journey:placeDiaries.loading'):t('journey:placeDiaries.viewAll')}</button>}
        {!view.loading&&!view.error&&!view.items.length&&<p className="jw-muted">{t('journey:placeDiaries.empty')} <button type="button" className="jw-link" onClick={()=>openJourney({kind:'record-place',place})}>{t('journey:placeDiaries.recordThis')}</button></p>}
    </section>;
}
