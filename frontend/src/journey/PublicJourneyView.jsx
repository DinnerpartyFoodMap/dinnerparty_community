import React,{useEffect,useRef,useState} from 'react';
import {copyText} from '../platform/share';
import {buildPublicUrl} from '../platform/runtimeConfig';
import {getQueryParams,removeQueryParams,replaceQueryParams} from '../platform/navigation';
import {PageHeader,Notice,PublicPhoto,PhotoViewer,Badge,MarkdownText,formatRange} from './shared';
import {diaryReportPrefill} from '../feedback/feedbackTypes';
import { t, tx } from '../i18n/index.js';
import { AiTag } from '../components/primitives/AiLabel';

/**
 * 整篇公开日记：未登录也可阅读（举报需要登录）；打开时定位到相关站点；有标记的站点可反向查看地图标记。
 * 打开期间地址栏保留 ?diary=<公开 ID>，刷新、收藏或转发当前地址都能回到这篇；关闭后移除。
 */
export default function PublicJourneyView({ctx,nav,params,active}) {
    const {base,showPlace,tip,report,userId}=ctx;
    const [journey,setJourney]=useState(null),[error,setError]=useState(''),[viewer,setViewer]=useState(null);
    const scrolled=useRef(false);
    useEffect(()=>{
        let alive=true;
        fetch(`${base}/api/public/journeys/${encodeURIComponent(params.publicId)}`).then(async r=>{
            const data=await r.json().catch(()=>({}));
            if(!r.ok)throw new Error(data.error||t('journey:public.unavailable'));
            if(alive)setJourney(data);
        }).catch(e=>{if(alive)setError(e.message);});
        return()=>{alive=false;};
    },[base,params.publicId]);
    // 位于页面栈顶时把公开 ID 写进地址；离开（关闭或被其他页盖住后关闭）时只移除属于这篇的参数
    useEffect(()=>{
        if(!active)return undefined;
        replaceQueryParams({diary:params.publicId,stop:params.stopId||null});
        return()=>{if(getQueryParams().get('diary')===params.publicId)removeQueryParams(['diary','stop']);};
    },[active,params.publicId,params.stopId]);
    useEffect(()=>{
        if(!journey||!params.stopId||scrolled.current)return;
        scrolled.current=true;
        requestAnimationFrame(()=>document.getElementById(`jw-public-${params.stopId}`)?.scrollIntoView({block:'start'}));
    },[journey,params.stopId]);
    const author=journey?.author;
    // 放大查看：整篇照片与各站照片按页面顺序排成一组，说明写明属于哪一站
    const photos=journey?[...(journey.entry_media_ids||[]).map(id=>({id,caption:t('journey:public.entryPhoto')})),
        ...journey.stops.flatMap(s=>s.media_ids.map(id=>({id,caption:`${s.index+1}. ${s.name}`})))]:[];
    const open=(id,caption)=>setViewer(Math.max(0,photos.findIndex(p=>p.id===id&&p.caption===caption)));
    const photo=(id,caption)=><button type="button" key={id} className="jw-photo-button" aria-label={tx('journey:public.enlarge', { caption })} onClick={()=>open(id,caption)}>
        <PublicPhoto publicId={journey.public_id} id={id} base={base} className="jw-strip__img"/></button>;
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.diary')} onBack={nav.pop} right={journey&&<button type="button" className="jw-header__action" onClick={async()=>{if(await copyText(buildPublicUrl(`/?diary=${encodeURIComponent(journey.public_id)}`)))tip(t('journey:public.linkCopied'));}}>{t('journey:public.copyLink')}</button>}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {error&&<Notice tone="error">{error}</Notice>}
            {!journey&&!error&&<p className="jw-muted">{t('journey:common.status.fetching')}</p>}
            {journey&&<>
                <header className="jw-detail-head">
                    <div className="jw-author">
                        {author.has_avatar?<img src={`${base}/users/${encodeURIComponent(author.id)}/avatar`} alt="" className="jw-avatar"/>:<span className="jw-avatar jw-avatar--empty" aria-hidden="true">{author.username.slice(0,1)}</span>}
                        <span>{author.username}</span>
                    </div>
                    <h3>{journey.title}
                        {report&&author.id!==userId&&<button type="button" className="jw-report" style={{marginLeft:8}} aria-label={t('journey:public.reportLabel', { title: journey.title })} onClick={()=>report(diaryReportPrefill(journey))}>{t('journey:public.report')}</button>}
                    </h3>
                    <p className="jw-muted">{tx('journey:public.meta', { range: formatRange(journey.start_date,journey.end_date), count: journey.stops.length })}</p>
                    {journey.ai_assisted&&<p className="jw-muted"><AiTag label={t('common:ai.assisted')} style={{marginRight:6}}/>{t('journey:public.aiAssisted')}</p>}
                </header>
                {journey.summary&&<MarkdownText className="jw-detail-summary" text={journey.summary}/>}
                {journey.text&&<MarkdownText className="jw-detail-summary" text={journey.text}/>}
                {!!journey.entry_media_ids?.length&&<div className="jw-strip">{journey.entry_media_ids.map(id=>photo(id,t('journey:public.entryPhoto')))}</div>}
                <ol className="jw-detail-stops">{journey.stops.map(s=><li key={s.id} id={`jw-public-${s.id}`} className={s.id===params.stopId?'is-focus':''}>
                    <div className="jw-row-between"><strong>{s.index+1}. {s.name}</strong>{s.unverified&&<Badge>{t('journey:public.unverified')}</Badge>}</div>
                    {s.at&&<small className="jw-muted">{formatStopTime(s.at)}</small>}
                    {s.excerpt.map((e,i)=><blockquote key={i} className={`jw-excerpt${e.kind==='edited'?' is-edited':''}`}><MarkdownText text={e.text}/><small>{e.kind==='edited'?t('journey:common.label.authorEdited'):t('journey:common.label.originalExcerpt')}</small></blockquote>)}
                    {!!s.media_ids.length&&<div className="jw-strip">{s.media_ids.map(id=>photo(id,`${s.index+1}. ${s.name}`))}</div>}
                    {s.place_id&&<button type="button" className="jw-link" onClick={()=>showPlace(s.place_id)}>{t('journey:public.viewMarker')}</button>}
                </li>)}</ol>
                {journey.stops.some(s=>s.unverified)&&<p className="jw-muted">{t('journey:public.unverifiedHint')}</p>}
            </>}
        </div></div>
        {journey&&<PhotoViewer photos={photos} index={viewer} onIndex={setViewer} render={p=><PublicPhoto publicId={journey.public_id} id={p.id} base={base} className="jw-viewer__img" alt={p.caption}/>}/>}
    </div>;
}
// 只知道日期的站点（YYYY-MM-DD）不显示时间
export function formatStopTime(at) {return at.length>10?at.replace('T',' '):formatRange(at);}
