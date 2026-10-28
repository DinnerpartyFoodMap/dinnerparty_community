import React,{useCallback,useEffect,useState} from 'react';
import {requestActionSheet} from '../components/overlay/ActionSheet';
import {copyText} from '../platform/share';
import {buildPublicUrl} from '../platform/runtimeConfig';
import {PageHeader,Notice,PrivatePhoto,Badge,MarkdownText,formatRange} from './shared';
import {excerptText,located} from './reviewUtils';
import { t, tx } from '../i18n/index.js';

/** 日记详情：先看内容，点「修改」才进入编辑；历史版本、另存副本、可见性与删除放在「更多」。 */
export default function JourneyDetail({ctx,nav,params,active}) {
    const {api,base,token,confirm,tip,showJourneyOnMap,showPlace}=ctx;
    const [journey,setJourney]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const [message,setMessage]=useState(params.message||''),[revisions,setRevisions]=useState(null);
    const load=useCallback(async()=>{try{setJourney(await api(`/${params.journeyId}`));}catch(e){setError(e.message);}},[api,params.journeyId]);
    // 回到本页时重新读取（修改、恢复版本后显示最新内容）
    useEffect(()=>{if(active)load();},[active,load]);
    useEffect(()=>{if(params.message)setMessage(params.message);},[params.message]);
    const run=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const pub=journey?.publication;
    const isPublic=journey?.visibility==='public';
    const more=async()=>{
        const actions=[{value:'history',label:t('journey:detail.history')},{value:'copy',label:t('journey:detail.saveCopy')}];
        if(isPublic)actions.push({value:'link',label:t('journey:detail.copyPublicLink')},{value:'private',label:t('journey:detail.makePrivate')});
        else actions.push({value:'public',label:t('journey:detail.makePublic')});
        actions.push({value:'delete',label:t('journey:detail.deleteDiary'),tone:'danger'});
        const choice=await requestActionSheet({title:t('common:action.more'),actions});
        if(choice==='history')run(async()=>setRevisions(await api(`/${journey.id}/revisions`)));
        if(choice==='copy')run(async()=>{
            const copy=await api('',{method:'POST',body:JSON.stringify({document:journey.document})});
            tip(t('journey:detail.copySaved'));nav.push('detail',{journeyId:copy.id});
        });
        if(choice==='link')run(async()=>{if(!await copyText(buildPublicUrl(`/?diary=${encodeURIComponent(pub.public_id)}`)))throw new Error(t('journey:detail.copyFailed'));tip(t('journey:detail.linkCopied'));});
        if(choice==='public')nav.push('review',{mode:'edit',journeyId:journey.id,visibility:'public'});
        if(choice==='private'){
            if(!await confirm(t('journey:detail.confirmMakePrivate')))return;
            run(async()=>{await api(`/${journey.id}/publication`,{method:'DELETE',body:JSON.stringify({version:pub.version})});setMessage(t('journey:detail.madePrivate'));await load();});
        }
        if(choice==='delete'){
            if(!await confirm(t('journey:detail.confirmDelete')))return;
            run(async()=>{await api(`/${journey.id}`,{method:'DELETE',body:JSON.stringify({base_revision:journey.revision})});tip(t('journey:detail.deleted'));nav.pop();});
        }
    };
    if(!journey)return <div className="jw-page"><PageHeader title={t('journey:common.feature.diary')} onBack={nav.pop}/><div className="jw-scroll"><div className="jw-content">{error?<Notice tone="error">{error}</Notice>:<p className="jw-muted">{t('journey:common.status.fetching')}</p>}</div></div></div>;
    const d=journey.document;
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.diary')} onBack={nav.pop} right={<button type="button" className="jw-header__action" disabled={busy} onClick={more} aria-label={t('journey:detail.moreActions')}>{t('common:action.more')}</button>}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {message&&<Notice tone="success" onClose={()=>setMessage('')}>{message}</Notice>}
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            <header className="jw-detail-head">
                <h3>{d.title}</h3>
                <p className="jw-muted">{tx('journey:detail.meta', { range: formatRange(d.start_date,d.end_date), count: d.stops.length })}</p>
                <p>{isPublic?<><Badge tone="primary">{t('journey:detail.published')}</Badge> {tx('journey:detail.linkedPlaces', { linked_places: pub.linked_places })}</>:<Badge>{t('journey:detail.privateOnly')}</Badge>}</p>
                {pub?.outdated&&<Notice tone="warn">{t('journey:detail.outdated')}
                    <span className="jw-inline-actions"><button type="button" onClick={()=>nav.push('review',{mode:'edit',journeyId:journey.id,visibility:'public'})}>{t('journey:detail.updatePublic')}</button></span></Notice>}
            </header>
            {d.summary&&<MarkdownText className="jw-detail-summary" text={d.summary}/>}
            <div className="jw-actions">
                <button type="button" className="jw-primary" onClick={()=>nav.push('review',{mode:'edit',journeyId:journey.id})}>{t('journey:detail.edit')}</button>
                <button type="button" disabled={!d.stops.some(located)} onClick={()=>showJourneyOnMap(journey)}>{t('journey:detail.viewOnMap')}</button>
                <button type="button" onClick={()=>nav.push('share',{journeyId:journey.id})}>{t('journey:common.action.generateShare')}</button>
                <button type="button" onClick={()=>nav.backTo('calendar',{month:d.start_date.slice(0,7),day:d.start_date})}>{tx('journey:detail.backTo', { range: formatRange(d.start_date) })}</button>
            </div>
            {revisions&&<section className="jw-card jw-stack" aria-label={t('journey:detail.history')}>
                <div className="jw-row-between"><strong>{t('journey:detail.history')}</strong><button type="button" onClick={()=>setRevisions(null)}>{t('journey:detail.collapse')}</button></div>
                <p className="jw-muted">{tx('journey:detail.restoreHint', { note: isPublic?t('journey:detail.restoreNotePublic'):'' })}</p>
                {revisions.map(r=><button type="button" key={r.revision} disabled={busy||r.revision===journey.revision} onClick={()=>run(async()=>{
                    if(!await confirm(t('journey:detail.confirmRestore', { revision: r.revision })))return;
                    await api(`/${journey.id}/restore`,{method:'POST',body:JSON.stringify({revision:r.revision,base_revision:journey.revision})});
                    setRevisions(null);setMessage(isPublic?t('journey:detail.restoredPublic'):t('journey:detail.restoredPrivate'));await load();
                })}>{tx('journey:detail.revisionLabel', { revision: r.revision, time: r.created_at.slice(0,16).replace('T',' '), current: r.revision===journey.revision?t('journey:detail.current'):'' })}</button>)}
            </section>}
            {!!d.sources?.length&&<p className="jw-muted">{tx('journey:detail.mergedFrom', { count: d.sources.length })}</p>}
            <ol className="jw-detail-stops">{d.stops.map((s,i)=><li key={s.id}>
                <div className="jw-row-between"><strong>{i+1}. {s.name}</strong><span>{!located(s)&&<Badge>{t('journey:detail.pendingLocation')}</Badge>}</span></div>
                {excerptText(s)&&<blockquote className="jw-excerpt"><MarkdownText text={excerptText(s)}/></blockquote>}
                {s.note&&s.note.trim()!==excerptText(s).trim()&&<MarkdownText text={s.note}/>}
                {!!s.media_ids.length&&<div className="jw-strip">{s.media_ids.map(id=><PrivatePhoto key={id} id={id} base={base} token={token} className="jw-strip__img"/>)}</div>}
                {s.place_id&&<button type="button" className="jw-link" onClick={()=>showPlace(s.place_id)}>{t('journey:detail.viewMarker')}</button>}
            </li>)}</ol>
            {!d.stops.length&&<p className="jw-muted">{t('journey:detail.noStops')}</p>}
            {!!(d.entry_media_ids||[]).length&&<section className="jw-stack" aria-label={t('journey:detail.photosLabel')}><strong>{tx('journey:detail.photosTitle', { count: d.entry_media_ids.length })}</strong>
                <div className="jw-photo-choice">{d.entry_media_ids.map(id=><PrivatePhoto key={id} id={id} base={base} token={token}/>)}</div></section>}
            {d.source_input?.text&&<details className="jw-card jw-more"><summary>{t('journey:detail.originalInput')}</summary><p className="jw-pre">{d.source_input.text}</p></details>}
        </div></div>
    </div>;
}
