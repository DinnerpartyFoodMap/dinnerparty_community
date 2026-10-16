import React,{useCallback,useEffect,useState} from 'react';
import {loadLocalDraft,deleteLocalDraft,listLocalComposes,deleteLocalCompose} from '../platform/localDraftStore';
import {getTokenUserId} from '../platform/credentialStore';
import {PageHeader,Notice,PrivatePhoto,Empty,formatRange} from './shared';
import { t, tx } from '../i18n/index.js';

/**
 * 读取未完成内容。本机记录与服务器列表分别读取：服务器不可达（例如离线冷启动）时，
 * 本机未同步的素材和编辑仍然列出并可继续。
 */
export async function loadUnfinished(api,userId) {
    const [server,editor,composes]=await Promise.allSettled([api('/unfinished'),loadLocalDraft(userId,'active'),listLocalComposes(userId)]);
    const list=server.status==='fulfilled'?server.value:null;
    const known=new Set(list?[...list.material,...list.generating].map(m=>m.id):[]);
    const record=editor.status==='fulfilled'?editor.value:null;
    const local={editor:record&&!record.synced&&record.journal?record:null,
        // 只列出服务器上还没有的、或有未上传图片的本机素材
        composes:(composes.status==='fulfilled'?composes.value:[]).filter(r=>!r.synced&&(!known.has(r.draftId)||r.photos.some(p=>!p.mediaId)))};
    return {list,serverError:list?'':server.reason?.message||t('journey:unfinished.serverUnreachable'),local,
        total:(list?.count||0)+(local.editor?1:0)+local.composes.length,material:(list?.material.length||0)+local.composes.length};
}

/** 未完成：本机未同步、素材草稿、生成中、待核对、编辑草稿，统一在这里继续或丢弃。 */
export default function JourneyUnfinished({ctx,nav,active}) {
    const {api,base,token,confirm}=ctx;
    const userId=getTokenUserId(token);
    const [list,setList]=useState(null),[local,setLocal]=useState({editor:null,composes:[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const [serverError,setServerError]=useState('');
    const load=useCallback(async()=>{
        const result=await loadUnfinished(api,userId);
        setLocal(result.local);setList(result.list);setServerError(result.serverError);
    },[api,userId]);
    useEffect(()=>{if(active)load();},[active,load]);
    const run=async fn=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const discard=(label,fn)=>run(async()=>{if(await confirm(t('journey:unfinished.confirmDiscard', { label })))await fn();});
    const row=(item,{title,meta,open,openLabel,remove})=><div key={`${item.kind||'local'}-${item.id||item.draftId}`} className="jw-entry-row">
        <button type="button" className="jw-entry" onClick={open} aria-label={t('journey:unfinished.openItem', { openLabel, title })}>
            {item.cover_media_id?<PrivatePhoto id={item.cover_media_id} base={base} token={token} className="jw-entry__cover" alt=""/>:<span className="jw-entry__cover jw-entry__cover--empty" aria-hidden="true">✎</span>}
            <span className="jw-entry__body"><strong>{title}</strong><small>{meta}</small></span>
            <span className="jw-entry__go">{openLabel}</span>
        </button>
        {remove&&<button type="button" className="jw-icon-button" disabled={busy} aria-label={t('journey:unfinished.discardItem', { title })} onClick={remove}>×</button>}
    </div>;
    const total=(list?.count||0)+(local.editor?1:0)+local.composes.length;
    return <div className="jw-page">
        <PageHeader title={t('journey:unfinished.title', { total: total?` · ${total}`:'' })} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {serverError&&<Notice tone="warn">{tx('journey:unfinished.serverError', { serverError })}</Notice>}
            {!list&&!serverError&&!error&&<p className="jw-muted">{t('journey:common.status.fetching')}</p>}
            {(local.editor||!!local.composes.length)&&<section className="jw-stack" aria-label={t('journey:unfinished.localLabel')}>
                <h3 className="jw-section-title">{t('journey:unfinished.localLabel')}</h3>
                {local.editor&&row({id:'editor'},{title:local.editor.journal.document?.title||t('journey:unfinished.untitledDiary'),meta:t('journey:unfinished.savedAt', { time: new Date(local.editor.updatedAt).toLocaleString() }),openLabel:t('journey:unfinished.restore'),
                    open:()=>nav.push('review',{mode:'create',restoreLocal:true}),remove:()=>discard(t('journey:unfinished.discard.localEdits'),()=>deleteLocalDraft(userId,'active'))})}
                {local.composes.map(r=>row({id:r.draftId},{title:(r.payload?.text||'').trim().slice(0,30)||t('journey:unfinished.photoCount', { count: r.photos.length }),meta:t('journey:unfinished.localMaterialMeta', { count: r.photos.filter(p=>!p.mediaId).length }),openLabel:t('journey:unfinished.continue'),
                    open:()=>nav.push('composer',{composeId:r.draftId}),remove:()=>discard(t('journey:unfinished.discard.localMaterial'),()=>deleteLocalCompose(userId,r.draftId))}))}
            </section>}
            {list&&<>
                <Section title={t('journey:unfinished.section.material')} items={list.material} render={m=>row(m,{title:m.title,meta:t('journey:unfinished.materialMeta', { range: m.start_date?formatRange(m.start_date):t('journey:unfinished.noDate'), media_count: m.media_count, newer: m.newer_than_review?t('journey:unfinished.newerThanReview'):'', lastError: m.failed?t('journey:unfinished.lastFailed', { error: m.error }):'' }),openLabel:t('journey:unfinished.continue'),
                    open:()=>nav.push('composer',{composeId:m.id}),remove:()=>discard(t('journey:unfinished.discard.material'),async()=>{await api(`/compose-drafts/${m.id}`,{method:'DELETE',body:JSON.stringify({revision:m.revision})});await deleteLocalCompose(userId,m.id);})})}/>
                <Section title={t('journey:unfinished.section.generating')} items={list.generating} render={m=>row(m,{title:m.title,meta:m.job_status==='queued'?t('journey:unfinished.queued'):t('journey:unfinished.section.generating'),openLabel:t('journey:unfinished.view'),
                    open:()=>nav.push('generation',{composeId:m.id,jobId:m.job_id})})}/>
                <Section title={t('journey:unfinished.section.review')} items={list.review} render={d=>row(d,{title:d.title,meta:t('journey:unfinished.reviewMeta', { range: formatRange(d.start_date,d.end_date), stop_count: d.stop_count, pending: d.pending?t('journey:unfinished.reviewPending', { pending: d.pending }):'' }),openLabel:t('journey:unfinished.continueReview'),
                    open:()=>nav.push('review',{mode:'create',draftId:d.id}),remove:()=>discard(t('journey:unfinished.discard.review'),()=>api(`/drafts/${d.id}`,{method:'DELETE',body:JSON.stringify({draft_revision:d.revision})}))})}/>
                <Section title={t('journey:unfinished.section.editing')} items={list.editing} render={d=>row(d,{title:d.title,meta:`${formatRange(d.start_date,d.end_date)}${d.journey_id?t('journey:unfinished.editingExisting'):t('journey:unfinished.editingNew')}`,openLabel:t('journey:unfinished.continueEditing'),
                    open:()=>nav.push('review',{mode:d.journey_id?'edit':'create',draftId:d.id}),remove:()=>discard(t('journey:unfinished.discard.editing'),()=>api(`/drafts/${d.id}`,{method:'DELETE',body:JSON.stringify({draft_revision:d.revision})}))})}/>
            </>}
            {(list||serverError)&&!total&&<Empty title={t('journey:unfinished.emptyTitle')}>{t('journey:unfinished.emptyHint')}</Empty>}
        </div></div>
    </div>;
}
function Section({title,items,render}) {
    if(!items.length)return null;
    return <section className="jw-stack" aria-label={title}><h3 className="jw-section-title">{title} · {items.length}</h3>{items.map(render)}</section>;
}

/** 私人图片空间：可删除未被日记、版本、草稿、生成任务或公开内容引用的图片。 */
export function JourneyMedia({ctx,nav,active}) {
    const {api,base,token,confirm}=ctx;
    const [media,setMedia]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const load=useCallback(async()=>{try{setMedia(await api('/media'));}catch(e){setError(e.message);}},[api]);
    useEffect(()=>{if(active)load();},[active,load]);
    const used=media?media.reduce((n,m)=>n+m.bytes,0):0;
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.privateImages')} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            <p className="jw-muted">{tx('journey:unfinished.media.usage', { summary: media?t('journey:unfinished.media.summary', { count: media.length, used: (used/1024/1024).toFixed(1) }):'' })}</p>
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            <div className="jw-photo-choice">{(media||[]).map(m=><figure key={m.id} className="jw-entry-photo">
                <PrivatePhoto id={m.id} base={base} token={token} alt=""/>
                <button type="button" className="jw-entry-photo__remove" disabled={busy} aria-label={t('journey:unfinished.media.deleteLabel')} onClick={async()=>{
                    if(!await confirm(t('journey:unfinished.media.confirmDelete')))return;
                    setBusy(true);setError('');
                    try{await api(`/media/${m.id}`,{method:'DELETE'});await load();}catch(e){setError(e.message);}finally{setBusy(false);}
                }}>×</button>
            </figure>)}</div>
            {media&&!media.length&&<Empty title={t('journey:unfinished.media.empty')}/>}
        </div></div>
    </div>;
}
