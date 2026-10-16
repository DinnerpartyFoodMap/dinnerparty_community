import React,{useEffect,useRef,useState} from 'react';
import {eventId} from './feedback';
import useComposeDraft from './useComposeDraft';
import JourneyPhotoPicker from './JourneyPhotoPicker';
import {LocationPicker} from './maps';
import {PageHeader,SettingRow,Notice,centerLabel,formatRange,today} from './shared';
import { t, tx } from '../i18n/index.js';

const TEXT_LIMIT=12000;
const SYNC_TEXT={empty:'',local:t('journey:composer.sync.local'),saving:t('journey:composer.sync.saving'),synced:t('journey:composer.sync.synced'),offline:t('journey:composer.sync.offline'),error:t('journey:composer.sync.error'),conflict:t('journey:composer.sync.conflict')};

/** 全屏图文生成：图片 → 描述 → 地址（搜索中心）→ 日期 → 可见性 → 生成行程草稿。 */
export default function JourneyComposer({ctx,nav,params}) {
    const {api,base,token,cap,mapRef,tip}=ctx;
    const draft=useComposeDraft({base,token,composeId:params.composeId,preset:params.preset});
    const {payload,setPayload,photos,sync}=draft;
    const [error,setError]=useState(''),[busy,setBusy]=useState(false),[locationOpen,setLocationOpen]=useState(false);
    const [dateOpen,setDateOpen]=useState(false),[visibilityOpen,setVisibilityOpen]=useState(false),[others,setOthers]=useState(null);
    const attempt=useRef(null);
    useEffect(()=>{
        // 有未完成内容时只提示，不自动覆盖当前的新输入
        if(params.composeId)return;
        let active=true;
        api('/unfinished').then(list=>{if(active)setOthers(list);}).catch(()=>{});
        return()=>{active=false;};
    },[api,params.composeId]);
    const run=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const multiDay=payload.end_date&&payload.end_date!==payload.start_date;
    const dateValid=/^\d{4}-\d{2}-\d{2}$/.test(payload.start_date)&&(!payload.end_date||payload.end_date>=payload.start_date);
    const unfinishedPhotos=photos.filter(p=>p.status!=='uploaded').length;
    const hasPhotos=photos.length>0,hasText=!!payload.text.trim();
    const textOnlyMode=cap.text_ai&&hasPhotos&&!cap.vision_ai;
    const blocker=!draft.hasContent?t('journey:composer.blocker.empty'):unfinishedPhotos?t('journey:composer.blocker.uploading', { unfinishedPhotos }):!dateValid?t('journey:composer.blocker.checkDate'):draft.closed?draft.closed:'';
    const generate=textOnly=>run(async()=>{
        const saved=await draft.flush();
        const key=`${saved.id}:${saved.revision}:${textOnly}`;
        // 连点、断网重发与响应丢失沿用同一请求编号；素材变化后才使用新编号
        if(attempt.current?.key!==key)attempt.current={key,id:eventId()};
        try{
            const job=await api(`/compose-drafts/${saved.id}/generate`,{method:'POST',body:JSON.stringify({compose_revision:saved.revision,request_id:attempt.current.id,text_only:textOnly})});
            nav.replace('generation',{composeId:saved.id,jobId:job.id});
        }catch(e){if([409,410].includes(e.status))attempt.current=null;throw e;}
    });
    // 不经 AI：用当前素材直接新建可编辑的日记草稿；原始描述与全部照片随之保留
    const manual=()=>run(async()=>{
        const saved=draft.hasContent?await draft.flush():null;
        const content=draft.content;
        const media_meta=Object.fromEntries(Object.entries(content.media_notes).map(([id,v])=>[id,{kind:v.kind,kind_source:'user'}]));
        nav.replace('review',{mode:'create',journal:{id:null,revision:0,compose_draft_id:saved?.id||null,compose_revision:saved?.revision??null,document:{
            title:t('journey:composer.defaultTitle'),start_date:payload.start_date,end_date:payload.end_date||payload.start_date,summary:'',stops:[],
            entry_media_ids:content.media_ids,media_meta,source_input:{text:payload.text,start_date:payload.start_date,end_date:payload.end_date||payload.start_date,center:payload.center},
            intended_visibility:payload.intended_visibility}}});
    });
    const leave=()=>{
        if(draft.hasContent){draft.flush().catch(()=>{});tip(t('journey:composer.leftSaved'));}
        nav.pop();
    };
    // 系统返回与 Esc 走同一出口：先落盘再返回
    useEffect(()=>{nav.setBack(leave);return()=>nav.setBack(null);});
    const saveDraft=()=>run(async()=>{
        if(!draft.hasContent){nav.pop();return;}
        await draft.flush();tip(t('journey:composer.draftSaved'));nav.pop();
    });
    const othersCount=others?others.material.length+others.generating.length+others.review.length:0;
    const latestOther=others?.material[0]||null;
    const generating=['queued','running'].includes(draft.job?.status);
    let primary;
    if(!cap.text_ai)primary=<button type="button" className="jw-primary jw-wide" disabled={busy||!!blocker} onClick={manual}>{t('journey:composer.manualSave')}</button>;
    else if(textOnlyMode)primary=<>
        <button type="button" className="jw-primary jw-wide" disabled={busy||!!blocker||!hasText} onClick={()=>generate(true)}>{busy?t('journey:composer.submitting'):t('journey:composer.generateTextOnly')}</button>
        <button type="button" className="jw-wide" disabled={busy||!!blocker} onClick={manual}>{t('journey:composer.manualRecord')}</button>
    </>;
    else primary=<>
        <button type="button" className="jw-primary jw-wide" disabled={busy||!!blocker||generating} onClick={()=>generate(false)}>{busy?t('journey:composer.submitting'):t('journey:common.action.generateDraft')}</button>
        <button type="button" className="jw-link" disabled={busy||!!blocker} onClick={manual}>{t('journey:composer.manualNoAi')}</button>
    </>;
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.generate')} onBack={leave} right={<button type="button" className="jw-header__action" disabled={busy} onClick={saveDraft}>{t('journey:composer.saveDraft')}</button>}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {!params.composeId&&othersCount>0&&!draft.hasContent&&<Notice>
                {tx('journey:composer.othersUnfinished', { othersCount })}
                <span className="jw-inline-actions">
                    {latestOther&&<button type="button" onClick={()=>nav.replace('composer',{composeId:latestOther.id})}>{t('journey:composer.continueLatest')}</button>}
                    <button type="button" onClick={()=>nav.push('unfinished')}>{t('journey:composer.viewAll')}</button>
                </span>
            </Notice>}
            {draft.closed&&<Notice tone="warn">{draft.closed}</Notice>}
            {generating&&<Notice>{t('journey:composer.generatingNotice')}<span className="jw-inline-actions"><button type="button" onClick={()=>nav.replace('generation',{composeId:draft.id,jobId:draft.job.id})}>{t('journey:composer.viewProgress')}</button></span></Notice>}
            {draft.structured?.status==='active'&&<Notice>{t('journey:composer.draftReadyNotice')}
                <span className="jw-inline-actions"><button type="button" onClick={()=>nav.push('review',{mode:'create',draftId:draft.structured.id})}>{t('journey:composer.goReview')}</button></span></Notice>}
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {!draft.loaded?<p className="jw-muted">{t('journey:composer.loading')}</p>:<>
                <JourneyPhotoPicker draft={draft} base={base} token={token} onError={setError}/>
                <label className="jw-field">
                    <span className="jw-field__label">{t('journey:composer.textLabel')}</span>
                    <textarea rows={6} maxLength={TEXT_LIMIT} value={payload.text} onChange={e=>setPayload({text:e.target.value})}
                        placeholder={t('journey:composer.textPlaceholder')}/>
                    <small className="jw-muted">{tx('journey:composer.textHint', { counter: payload.text.length>TEXT_LIMIT-1000?t('journey:composer.textCounter', { count: payload.text.length, TEXT_LIMIT }):'' })}</small>
                </label>
                <SettingRow label={t('journey:composer.address.label')} value={payload.center?centerLabel(payload.center):t('journey:composer.address.unset')} hint={t('journey:composer.address.hint')} onClick={()=>setLocationOpen(true)} ariaLabel={t('journey:composer.address.ariaLabel')}/>
                <SettingRow label={t('journey:composer.date.label')} value={formatRange(payload.start_date,payload.end_date)} expanded={dateOpen} onClick={()=>setDateOpen(v=>!v)} ariaLabel={t('journey:composer.date.ariaLabel')}>
                    {dateOpen&&<div className="jw-row-body">
                        <label className="jw-field"><span className="jw-field__label">{multiDay?t('journey:composer.date.start'):t('journey:composer.date.single')}</span><input type="date" max={today()} value={payload.start_date} onChange={e=>setPayload(p=>({start_date:e.target.value,end_date:!p.end_date||p.end_date<e.target.value||!multiDay?e.target.value:p.end_date}))}/></label>
                        <MultiDay payload={payload} setPayload={setPayload}/>
                    </div>}
                </SettingRow>
                <div className={`jw-sync jw-sync--${sync.kind}`} role="status" aria-label={t('journey:composer.syncStatusLabel')}>
                    <span>{SYNC_TEXT[sync.kind]||''}{sync.kind==='conflict'||sync.kind==='error'?t('journey:composer.syncDetail', { message: sync.message }):''}</span>
                    {!draft.local.saved&&draft.hasContent&&sync.kind!=='synced'&&<span> {t('journey:composer.notSavedLocally')}</span>}
                    {!draft.local.blobs&&draft.pendingPhotos>0&&<span> {t('journey:composer.photosOnlyInPage')}</span>}
                    {sync.kind==='offline'&&<button type="button" onClick={()=>run(()=>draft.flush())}>{t('journey:composer.retry')}</button>}
                    {sync.kind==='conflict'&&<><button type="button" onClick={()=>run(()=>draft.fork())}>{t('journey:composer.forkDraft')}</button><button type="button" onClick={()=>run(()=>draft.reload())}>{t('journey:composer.loadOtherVersion')}</button></>}
                </div>
                <SettingRow label={t('journey:composer.visibility.label')} value={payload.intended_visibility==='public'?t('journey:common.label.public'):t('journey:common.label.private')} expanded={visibilityOpen} onClick={()=>setVisibilityOpen(v=>!v)} ariaLabel={t('journey:composer.visibility.ariaLabel')}>
                    {visibilityOpen&&<div className="jw-row-body">
                        <div className="jw-segmented" role="radiogroup" aria-label={t('journey:composer.visibility.label')}>
                            {[['public',t('journey:common.label.public')],['private',t('journey:common.label.private')]].map(([value,label])=><button type="button" key={value} role="radio" aria-checked={payload.intended_visibility===value} onClick={()=>setPayload({intended_visibility:value})}>{label}</button>)}
                        </div>
                        <p className="jw-muted">{t('journey:composer.privacyNote')}</p>
                    </div>}
                </SettingRow>
                {!cap.text_ai&&<p className="jw-muted">{t('journey:composer.noAiNote')}</p>}
                {textOnlyMode&&<p className="jw-muted">{t('journey:composer.textOnlyNote')}</p>}
                <p className="jw-muted">{t('journey:composer.aiDataNote')}</p>
            </>}
        </div></div>
        {/* 输入时键盘盖住底部：操作区收起，不随 WebView 缩小被顶到键盘上方（index.html .keyboard-open） */}
        <footer className="jw-footer" data-hide-when-keyboard="">
            {blocker&&draft.loaded&&<small className="jw-muted" role="status">{blocker}</small>}
            <div className="jw-footer__actions">{primary}</div>
        </footer>
        <LocationPicker open={locationOpen} value={payload.center} base={base} mapRef={mapRef} pickOnMap={ctx.pickOnMap}
            onChange={center=>{setPayload({center});setLocationOpen(false);}} onClose={()=>setLocationOpen(false)}/>
    </div>;
}
function MultiDay({payload,setPayload}) {
    const multi=payload.end_date&&payload.end_date!==payload.start_date;
    const [open,setOpen]=useState(!!multi);
    useEffect(()=>{if(multi)setOpen(true);},[multi]);
    return <>
        <label className="jw-check"><input type="checkbox" checked={open} onChange={e=>{setOpen(e.target.checked);if(!e.target.checked)setPayload(p=>({end_date:p.start_date}));}}/><span>{t('journey:composer.multiDay')}</span></label>
        {open&&<label className="jw-field"><span className="jw-field__label">{t('journey:composer.date.end')}</span><input type="date" min={payload.start_date} max={today()} value={payload.end_date||payload.start_date} onChange={e=>setPayload({end_date:e.target.value})}/></label>}
    </>;
}
