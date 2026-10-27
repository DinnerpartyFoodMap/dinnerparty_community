import React,{useEffect,useRef,useState} from 'react';
import {copyText} from '../platform/share';
import {buildPublicUrl} from '../platform/runtimeConfig';
import {PageHeader,Notice,PublicPhoto,formatRange} from './shared';
import {diaryReportPrefill} from '../feedback/feedbackTypes';
import { t, tx } from '../i18n/index.js';
import { AiTag } from '../components/primitives/AiLabel';

/** 整篇公开日记：未登录也可阅读（举报需要登录）；打开时定位到相关站点；有标记的站点可反向查看地图标记。 */
export default function PublicJourneyView({ctx,nav,params}) {
    const {base,showPlace,tip,report,userId}=ctx;
    const [journey,setJourney]=useState(null),[error,setError]=useState('');
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
    useEffect(()=>{
        if(!journey||!params.stopId||scrolled.current)return;
        scrolled.current=true;
        requestAnimationFrame(()=>document.getElementById(`jw-public-${params.stopId}`)?.scrollIntoView({block:'start'}));
    },[journey,params.stopId]);
    const author=journey?.author;
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
                {journey.summary&&<p className="jw-detail-summary">{journey.summary}</p>}
                {journey.text&&<p className="jw-detail-summary">{journey.text}</p>}
                {!!journey.entry_media_ids?.length&&<div className="jw-strip">{journey.entry_media_ids.map(id=><PublicPhoto key={id} publicId={journey.public_id} id={id} base={base} className="jw-strip__img"/>)}</div>}
                <ol className="jw-detail-stops">{journey.stops.map(s=><li key={s.id} id={`jw-public-${s.id}`} className={s.id===params.stopId?'is-focus':''}>
                    <strong>{s.index+1}. {s.name}</strong>
                    {s.excerpt.map((e,i)=><blockquote key={i} className={`jw-excerpt${e.kind==='edited'?' is-edited':''}`}>{e.text}<small>{e.kind==='edited'?t('journey:common.label.authorEdited'):t('journey:common.label.originalExcerpt')}</small></blockquote>)}
                    {!!s.media_ids.length&&<div className="jw-strip">{s.media_ids.map(id=><PublicPhoto key={id} publicId={journey.public_id} id={id} base={base} className="jw-strip__img"/>)}</div>}
                    {s.place_id&&<button type="button" className="jw-link" onClick={()=>showPlace(s.place_id)}>{t('journey:public.viewMarker')}</button>}
                </li>)}</ol>
            </>}
        </div></div>
    </div>;
}
