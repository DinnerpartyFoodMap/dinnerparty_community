import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import useJourneyDraft from './useJourneyDraft';
import JourneyStopCard from './JourneyStopCard';
import {useAutoRank} from './JourneyResolution';
import {applyResolutionPatch} from './resolution.mjs';
import {StopMapPreview,reverseGeocode} from './maps';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import {requestActionSheet,hasActionSheetHost} from '../components/overlay/ActionSheet';
import {pickImages,prepareImageForUpload,UPLOAD_LIMITS,MediaError} from '../platform/mediaPicker';
import {PageHeader,Notice,PrivatePhoto,Badge,centerLabel,formatRange} from './shared';
import {newStop,needsReview,issueOf,unassignedSentences,addExcerpt,located,distanceMeters,formatDistance,placeToStop,pointToStop} from './reviewUtils';
import { t, tx } from '../i18n/index.js';
import { AiTag } from '../components/primitives/AiLabel';

const SYNC_TEXT={idle:'',saved:t('journey:review.sync.saved'),saving:t('journey:review.sync.saving'),offline:t('journey:review.sync.offline'),conflict:t('journey:review.sync.conflict'),pending:t('journey:review.sync.unconfirmed')};

/**
 * 「核对行程」（新建）与「修改日记」（历史日记）共用的编辑页：
 * 按顺序的站点卡片、最多两个需要处理的问题、可见性与公开预览，一次保存完成正式日记与地图关联。
 */
export default function JourneyReview({ctx,nav,params}) {
    const {api,base,token,cap,confirm,tip,pickOnMap}=ctx;
    const [journal,setJournal]=useState(null),[dirty,setDirty]=useState(false),[loadError,setLoadError]=useState('');
    const [publication,setPublication]=useState(null);
    const drafts=useJourneyDraft(base,token,journal,dirty);
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(params.notice||'');
    const [expanded,setExpanded]=useState(null);
    const [preview,setPreview]=useState(null),[previewState,setPreviewState]=useState('none'),[previewOpen,setPreviewOpen]=useState(false);
    const [shopFor,setShopFor]=useState(null),[mapOpen,setMapOpen]=useState(false);
    const journalRef=useRef(journal);journalRef.current=journal;
    const restored=useRef(false);
    const document=journal?.document;
    const visibility=document?.intended_visibility==='public'?'public':'private';
    const editingSaved=!!journal?.id;
    const perform=useCallback(async(fn,{quiet=false}={})=>{
        if(!quiet)setBusy(true);
        if(!quiet)setError('');
        try{return await fn();}catch(e){setError(e.message);}finally{if(!quiet)setBusy(false);}
    },[]);
    const loadPublication=useCallback(async journeyId=>{
        try{const j=await api(`/${journeyId}`);setPublication(j.publication?{...j.publication,visibility:j.visibility}:{visibility:'private'});return j;}catch{return null;}
    },[api]);
    const openDraft=useCallback(loaded=>{
        drafts.start(loaded);
        setJournal({id:loaded.journey_id,revision:loaded.base_revision,compose_draft_id:loaded.compose_draft_id||null,document:loaded.document});
        setDirty(true);
        if(loaded.journey_id)loadPublication(loaded.journey_id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[loadPublication]);
    useEffect(()=>{
        let alive=true;
        (async()=>{
            try{
                if(params.draftId){const loaded=await api(`/drafts/${params.draftId}`);if(alive)openDraft(loaded);}
                else if(params.journeyId){
                    // 同一篇日记已有未保存的修改草稿时，继续那一份，不再另开
                    const pending=await api('/unfinished');
                    const existing=pending.editing.find(d=>d.journey_id===params.journeyId);
                    if(existing){const loaded=await api(`/drafts/${existing.id}`);if(alive){openDraft(loaded);setMessage(t('journey:review.restoredServer'));}return;}
                    const loaded=await loadPublication(params.journeyId);
                    if(!loaded)throw new Error(t('journey:review.notFound'));
                    if(!alive)return;
                    drafts.start(null);
                    setJournal({id:loaded.id,revision:loaded.revision,document:{...loaded.document,intended_visibility:params.visibility||loaded.visibility}});
                    setDirty(!!params.visibility&&params.visibility!==loaded.visibility);
                }else if(params.journal){drafts.start(null);setJournal(params.journal);setDirty(true);}
            }catch(e){if(alive)setLoadError(e.message);}
        })();
        return()=>{alive=false;};
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[]);
    // 恢复本机未同步的修改
    useEffect(()=>{
        if(!params.restoreLocal||restored.current||!drafts.localDraft)return;
        restored.current=true;
        const record=drafts.restoreLocal();
        if(record){setJournal(record);setDirty(true);setMessage(t('journey:review.restoredLocal'));if(record.id)loadPublication(record.id);}
    },[params.restoreLocal,drafts.localDraft,drafts,loadPublication]);

    const edit=useCallback(patch=>{setJournal(j=>({...j,document:{...j.document,...(typeof patch==='function'?patch(j.document):patch)}}));setDirty(true);},[]);
    const editStop=useCallback((id,patch)=>edit(d=>({stops:d.stops.map(s=>s.id===id?{...s,...patch}:s)})),[edit]);
    const applyResolution=useCallback(result=>{
        if(result.draft_id!==drafts.currentId())throw new Error(t('journey:review.wrongDraft'));
        const current=journalRef.current.document,next=applyResolutionPatch(current,result);
        if(JSON.stringify(current)!==JSON.stringify(next))edit({stops:next.stops});
        setMessage(t('journey:review.suggestionsUpdated'));
    },[drafts,edit]);
    useAutoRank({document,drafts,api,applyResult:applyResolution,perform,busy});

    // 草稿同步后，按该版本取得公开与地图操作预览（只读，不产生任何公共写入）
    const syncedKey=drafts.state.kind;
    useEffect(()=>{
        if(!journal)return;
        const id=drafts.currentId();
        if(!id){setPreviewState('none');return;}
        if(!drafts.isSynced()){setPreviewState('stale');return;}
        let alive=true;
        setPreviewState('loading');
        const timer=setTimeout(()=>api(`/drafts/${id}/map-preview`,{method:'POST',body:JSON.stringify({draft_revision:drafts.currentRevision(),visibility})})
            .then(p=>{if(alive){setPreview(p);setPreviewState('ready');}}).catch(e=>{if(alive)setPreviewState(e.status===409?'stale':'error');}),300);
        return()=>{alive=false;clearTimeout(timer);};
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[journal,syncedKey,visibility]);

    const save=()=>perform(async()=>{
        const snapshot=journalRef.current;
        let outcome;
        try{outcome=await drafts.commit(snapshot,{visibility,previewHash:preview?.visibility===visibility?preview.preview_hash:null,asCopy:false});}
        catch(e){
            if(e.code==='preview_stale'){if(e.preview){setPreview(e.preview);setPreviewState('ready');}setPreviewOpen(true);throw new Error(t('journey:review.previewStale'));}
            if(e.code==='duplicate_conflict'){setPreviewState('stale');setPreview(null);}
            throw e;
        }
        const {result,snapshot:saved}=outcome;
        if(result.created_place_ids?.length)window.dispatchEvent(new CustomEvent('journey:places-changed',{detail:{ids:result.created_place_ids}}));
        if(journalRef.current!==saved){
            // 保存期间又有修改：保留修改并以新版本为基础继续编辑
            setJournal(current=>({...current,id:result.journey_id,revision:result.revision}));setDirty(true);
            setMessage(t('journey:review.savedWithPending'));return;
        }
        setDirty(false);
        const detail={journeyId:result.journey_id,message:result.visibility==='public'
            ?t('journey:review.savedPublic', { linked: result.linked, created: result.created_place_ids?.length?t('journey:review.savedPublicCreated', { count: result.created_place_ids.length }):'' })
            :t('journey:review.savedPrivate')};
        // 从详情进入的修改：保存后回到原详情；新建与未完成草稿则进入新的详情页
        if(params.journeyId)nav.backTo('detail',detail);else nav.replace('detail',detail);
    });
    const back=async()=>{
        if(busy)return;
        if(!drafts.isSynced()&&!(await confirm(t('journey:review.confirmLeave'))))return;
        if(dirty&&drafts.currentId())tip(t('journey:review.draftSaved'));
        nav.pop();
    };
    useEffect(()=>{nav.setBack(back);return()=>nav.setBack(null);});
    const addEntryPhotos=()=>perform(async()=>{
        const list=journalRef.current.document.entry_media_ids||[];
        if(list.length>=60)throw new Error(t('journey:review.maxPhotos'));
        const source=hasActionSheetHost()?await requestActionSheet({title:t('common:action.addImage'),actions:[{value:'library',label:t('common:action.chooseFromAlbum')},{value:'camera',label:t('common:action.takePhoto')}]}):'library';
        if(!source)return;
        let files;
        try{files=await pickImages({multiple:source==='library',source,limit:Math.min(12,60-list.length)});}
        catch(e){throw new Error(e instanceof MediaError?e.message:t('journey:review.openFailed'));}
        const ids=[];
        for(const file of files){
            const prepared=await prepareImageForUpload(file,UPLOAD_LIMITS.journeyMedia);
            const form=new FormData();form.append('image',prepared);
            ids.push((await api('/media',{method:'POST',body:form})).id);
            edit(d=>({entry_media_ids:[...(d.entry_media_ids||[]),...ids.slice(-1)]}));
        }
    });
    const center=document?.source_input?.center||null;
    // 全屏地图选点（与地图首页相同的标记与搜索）：选中站内标记或搜索结果，或用图钉选择任意位置
    const pickedPatch=result=>result.kind==='place'?placeToStop(result.place,{amapAllowed:!!cap.amap_search}):pointToStop(result.point);
    // 图钉位置的地址只属于这组坐标：读取完成时坐标已变化就丢弃
    const fillAddress=(id,point)=>reverseGeocode(point.lng,point.lat,base).then(r=>{
        if(r.address)edit(d=>({stops:d.stops.map(s=>s.id===id&&s.lng===point.lng&&s.lat===point.lat&&!s.address?{...s,address:r.address}:s)}));
    });
    const pickFor=id=>perform(async()=>{
        const stop=journalRef.current.document.stops.find(s=>s.id===id);if(!stop)return;
        const result=await pickOnMap({title:t('journey:review.pickForStop', { name: stop.name }),center:located(stop)?stop:center});
        if(!result)return;
        editStop(id,pickedPatch(result));
        if(result.kind==='point')fillAddress(id,result.point);
    },{quiet:true});
    const addBelow=index=>perform(async()=>{
        const list=journalRef.current.document.stops;
        if(list.length>=60)throw new Error(t('journey:review.maxStops'));
        const after=list[index]||null;
        const result=await pickOnMap({title:after?t('journey:review.addAfter', { name: after.name }):t('journey:review.addPlace'),center:located(after)?after:center});
        if(!result)return;
        const stop=newStop(pickedPatch(result));
        edit(d=>{const stops=[...d.stops],k=after?stops.findIndex(s=>s.id===after.id):-1;stops.splice(after?(k<0?stops.length:k+1):0,0,stop);return {stops};});
        // 图钉选点没有店名：展开补充信息，方便直接填写
        if(result.kind==='point'){fillAddress(stop.id,result.point);setExpanded(stop.id);}
        requestAnimationFrame(()=>window.document.getElementById(`jw-stop-${stop.id}`)?.scrollIntoView({behavior:'smooth',block:'center'}));
    },{quiet:true});
    const links=useMemo(()=>new Map((preview?.links||[]).map(l=>[l.stop_id,l])),[preview]);
    const unassigned=useMemo(()=>document?unassignedSentences(document.source_input?.text||'',document.stops):[],[document]);
    if(loadError)return <div className="jw-page"><PageHeader title={t('journey:review.title')} onBack={nav.pop}/><div className="jw-scroll"><div className="jw-content"><Notice tone="error">{loadError}</Notice></div></div></div>;
    if(!document)return <div className="jw-page"><PageHeader title={t('journey:review.title')} onBack={nav.pop}/><div className="jw-scroll"><div className="jw-content"><p className="jw-muted">{t('journey:common.status.fetching')}</p></div></div></div>;
    const stops=document.stops;
    const pendingStops=stops.filter(needsReview);
    const issues=pendingStops.slice(0,2);
    const wasPublic=publication?.status==='active';
    const primaryLabel=visibility==='public'?(wasPublic?t('journey:review.save.updatePublic'):t('journey:review.save.publish')):t('journey:review.save.private');
    const total=stops.reduce((n,s)=>n+s.expenses.reduce((a,e)=>a+(Number(e.amount)||0),0),0);
    const counts=preview?.visibility==='public'?preview.counts:null;
    const stopShop=stops.find(s=>s.id===shopFor);
    return <div className="jw-page">
        <PageHeader title={editingSaved?t('journey:review.editTitle'):t('journey:review.title')} onBack={back} subtitle={SYNC_TEXT[drafts.state.kind]&&dirty?SYNC_TEXT[drafts.state.kind]:''}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {message&&<Notice onClose={()=>setMessage('')}>{message}</Notice>}
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {document.ai_assisted&&<Notice><AiTag label={t('common:ai.assisted')} style={{marginRight:6}}/>{t('journey:review.aiAssisted')}</Notice>}
            {dirty&&['offline','conflict','pending'].includes(drafts.state.kind)&&<Notice tone="warn" role="status">
                <span aria-label={t('journey:review.syncStatusLabel')}>{drafts.state.message||SYNC_TEXT[drafts.state.kind]}</span>
                <span className="jw-inline-actions">
                    {['offline','conflict'].includes(drafts.state.kind)&&<button type="button" disabled={busy} onClick={()=>perform(()=>drafts.flush())}>{t('journey:review.retrySync')}</button>}
                    {drafts.state.kind==='conflict'&&<button type="button" disabled={busy} onClick={()=>perform(()=>drafts.fork())}>{t('journey:review.forkDraft')}</button>}
                </span>
            </Notice>}
            {!!issues.length&&<section className="jw-issues" aria-label={t('journey:review.issuesLabel')}>
                <strong>{t('journey:review.issuesLabel')}</strong>
                {issues.map(s=><button type="button" key={s.id} onClick={()=>window.document.getElementById(`jw-stop-${s.id}`)?.scrollIntoView({behavior:'smooth',block:'start'})}>
                    {tx('journey:review.issueItem', { issueOf: issueOf(s), name: s.name })}</button>)}
                {pendingStops.length>2&&<small className="jw-muted">{tx('journey:review.morePending', { count: pendingStops.length-2 })}</small>}
            </section>}
            <section className="jw-card jw-stack" aria-label={t('journey:review.titleSectionLabel')}>
                <label className="jw-field"><span className="jw-field__label">{t('journey:review.field.title')}</span><input value={document.title} maxLength={120} onChange={e=>edit({title:e.target.value})}/></label>
                <p className="jw-muted">{tx('journey:review.summaryLine', { range: formatRange(document.start_date,document.end_date), stops: stops.length, pending: pendingStops.length, center: center?t('journey:review.summaryCenter', { centerLabel: centerLabel(center) }):'' })}</p>
                <details className="jw-more">
                    <summary>{t('journey:review.datesSummary')}</summary>
                    <div className="jw-stack">
                        <div className="jw-actions">
                            <label className="jw-field"><span className="jw-field__label">{t('journey:review.field.startDate')}</span><input type="date" value={document.start_date} onChange={e=>edit(d=>({start_date:e.target.value,end_date:d.end_date<e.target.value?e.target.value:d.end_date}))}/></label>
                            <label className="jw-field"><span className="jw-field__label">{t('journey:review.field.endDate')}</span><input type="date" min={document.start_date} value={document.end_date} onChange={e=>edit({end_date:e.target.value})}/></label>
                        </div>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:review.field.summary')}</span><textarea rows={3} maxLength={5000} value={document.summary} onChange={e=>edit({summary:e.target.value})}/></label>
                    </div>
                </details>
            </section>
            {stops.map((s,i)=><JourneyStopCard key={s.id} stop={s} index={i} total={stops.length} document={document} expanded={expanded===s.id}
                onToggle={open=>setExpanded(open?s.id:null)} editStop={patch=>editStop(s.id,patch)} editingSaved={editingSaved}
                removeStop={async()=>{if(await confirm(t('journey:review.confirmRemoveStop', { name: s.name })))edit(d=>({stops:d.stops.filter(x=>x.id!==s.id)}));}}
                moveStop={delta=>edit(d=>{const list=[...d.stops],k=list.findIndex(x=>x.id===s.id);if(k+delta<0||k+delta>=list.length)return {};[list[k],list[k+delta]]=[list[k+delta],list[k]];return {stops:list};})}
                addBelow={()=>addBelow(i)} link={links.get(s.id)} visibility={visibility} ctx={ctx}
                center={center} onPickPoint={()=>pickFor(s.id)} onChooseShop={()=>setShopFor(s.id)}/>)}
            {!stops.length&&<section className="jw-card jw-stack" aria-label={t('journey:review.noStopsLabel')}>
                <p className="jw-muted">{t('journey:review.noStopsHint')}</p>
                <div className="jw-actions"><button type="button" onClick={()=>addBelow(-1)}>{t('journey:review.addOnMap')}</button></div>
            </section>}
            <EntryPhotos document={document} base={base} token={token} busy={busy} onAdd={addEntryPhotos}
                onRemove={id=>edit(d=>({entry_media_ids:(d.entry_media_ids||[]).filter(m=>m!==id),public_media_ids:(d.public_media_ids||[]).filter(m=>m!==id),stops:d.stops.map(s=>({...s,media_ids:s.media_ids.filter(m=>m!==id)}))}))}
                onAssign={(ids,stopId)=>edit(d=>({stops:d.stops.map(s=>s.id===stopId?{...s,media_ids:[...new Set([...s.media_ids,...ids])].slice(0,12)}:s)}))}/>
            {!!unassigned.length&&<details className="jw-card jw-more">
                <summary>{tx('journey:review.unassignedTitle', { count: unassigned.length })}</summary>
                <p className="jw-muted">{t('journey:review.unassignedHint')}</p>
                {unassigned.map(span=><div key={span.start} className="jw-unassigned">
                    <span>{span.text}</span>
                    <select aria-label={t('journey:review.assignSentence', { text: span.text.slice(0,12) })} value="" onChange={e=>{const target=stops.find(s=>s.id===e.target.value);if(target)editStop(target.id,addExcerpt(target,span,document.source_input?.text||''));}}>
                        <option value="">{t('journey:review.assignTo')}</option>{stops.map((s,i)=><option key={s.id} value={s.id}>{i+1}. {s.name}</option>)}
                    </select>
                </div>)}
            </details>}
            <details className="jw-card jw-more" onToggle={e=>setMapOpen(e.currentTarget.open)}>
                <summary>{t('journey:review.mapPreview')}</summary>
                {mapOpen&&<StopMapPreview stops={stops} activeId={expanded} onSelect={id=>{setExpanded(id);window.document.getElementById(`jw-stop-${id}`)?.scrollIntoView({behavior:'smooth'});}}/>}
            </details>
            <section className="jw-card jw-stack" aria-label={t('journey:review.saveSectionLabel')}>
                <strong>{t('journey:review.visibility')}</strong>
                <div className="jw-segmented" role="radiogroup" aria-label={t('journey:review.visibility')}>
                    {[['public',t('journey:common.label.public')],['private',t('journey:common.label.private')]].map(([value,label])=><button type="button" key={value} role="radio" aria-checked={visibility===value} onClick={()=>edit({intended_visibility:value})}>{label}</button>)}
                </div>
                {visibility==='public'?<>
                    <p role="status">{counts?t('journey:review.publicCounts', { link: counts.link, create: counts.create, conflicts: counts.conflict?t('journey:review.publicConflicts', { conflict: counts.conflict }):'' }):previewState==='loading'||previewState==='stale'?t('journey:review.previewUpdating'):t('journey:review.previewOnSave')}</p>
                    {counts&&<p className="jw-muted">{tx('journey:review.publicScope', { public_stops: counts.public_stops, public_photos: counts.public_photos, private_photos: counts.private_photos })}</p>}
                    <label className="jw-field"><span className="jw-field__label">{t('journey:review.field.publicText')}</span>
                        <textarea rows={4} maxLength={5000} value={document.public_text||''} placeholder={t('journey:review.field.publicTextPlaceholder')} onChange={e=>edit({public_text:e.target.value})}/></label>
                    {!!document.source_input?.text&&!document.public_text&&<button type="button" onClick={()=>edit({public_text:document.source_input.text.slice(0,5000)})}>{t('journey:review.useOriginalText')}</button>}
                    {!!(document.entry_media_ids||[]).length&&<div className="jw-field"><span className="jw-field__label">{t('journey:review.publicPhotosLabel')}</span>
                        <div className="jw-photo-choice">{document.entry_media_ids.map(id=>{const on=(document.public_media_ids||[]).includes(id);return <button type="button" key={id} aria-pressed={on} aria-label={on?t('journey:review.unpublishPhoto'):t('journey:review.publishPhoto')}
                            onClick={()=>edit(d=>({public_media_ids:on?(d.public_media_ids||[]).filter(m=>m!==id):[...(d.public_media_ids||[]),id]}))}><PrivatePhoto id={id} base={base} token={token} alt=""/>{on&&<span aria-hidden="true">✓</span>}</button>;})}</div></div>}
                    {counts?.empty_public&&<Notice tone="warn">{t('journey:review.emptyPublicWarning')}</Notice>}
                    {preview?.body&&<details className="jw-more" open={previewOpen} onToggle={e=>setPreviewOpen(e.currentTarget.open)}>
                        <summary>{t('journey:review.viewPublicContent')}</summary>
                        <PublicPreview body={preview.body} links={links}/>
                    </details>}
                </>:<p className="jw-muted">{tx('journey:review.privateScope', { unpublishNote: wasPublic?t('journey:review.unpublishNote'):'' })}</p>}
                {wasPublic&&publication?.outdated&&visibility==='public'&&<p className="jw-muted">{t('journey:review.publicOutdated')}</p>}
            </section>
            <p className="jw-muted">{tx('journey:review.totals', { count: stops.length, total: total.toFixed(2) })}</p>
        </div></div>
        {/* 输入时键盘盖住底部：操作区收起，不随 WebView 缩小被顶到键盘上方（index.html .keyboard-open） */}
        <footer className="jw-footer" data-hide-when-keyboard="">
            {visibility==='public'&&counts?.conflict>0&&<small className="jw-muted" role="status">{t('journey:review.resolveConflictsFirst')}</small>}
            <div className="jw-footer__actions"><button type="button" className="jw-primary jw-wide" disabled={busy||(visibility==='public'&&counts?.conflict>0)} onClick={save}>{busy?t('journey:review.saving'):primaryLabel}</button></div>
        </footer>
        <ResponsivePanel open={!!stopShop} onClose={()=>setShopFor(null)} title={t('journey:common.action.chooseShop')} kind="journey-shop" desktop="center" mobile="sheet" width="min(480px, calc(100vw - 24px))">
            {stopShop&&<div className="jw-stack jw-pad">
                <p className="jw-muted">{t('journey:review.candidateHint')}</p>
                {stopShop.candidate_basis==='broad'&&<Notice>{t('journey:review.broadCandidates')}</Notice>}
                <ul className="jw-result-list" aria-label={t('journey:review.candidatesLabel')}>{(stopShop.candidates||[]).map(c=>{const d=distanceMeters(center,c);return <li key={c.id}>
                    <button type="button" onClick={()=>{editStop(stopShop.id,{name:c.name,lng:c.lng,lat:c.lat,place_id:c.place_id||null,source:c.source,address:c.address||'',external_id:c.source==='amap'?c.id:'',candidates:[],needs_choice:false,location_resolution:'pending',visit_status:'visited',confirmed:true});setShopFor(null);}}>
                        <strong>{c.name}{c.suggested&&<Badge tone="primary">{t('journey:review.suggested')}</Badge>}</strong>
                        <small>{c.address||(c.source==='local'?t('journey:review.localMarker'):t('common:label.amapPlace'))}{d!=null?t('journey:review.distanceFromCenter', { distance: formatDistance(d) }):''}</small>
                    </button></li>;})}</ul>
                <div className="jw-actions"><button type="button" onClick={()=>{const id=stopShop.id;setShopFor(null);pickFor(id);}}>{t('journey:review.noneOfThese')}</button><button type="button" onClick={()=>setShopFor(null)}>{t('common:action.cancel')}</button></div>
            </div>}
        </ResponsivePanel>
    </div>;
}
function EntryPhotos({document,base,token,busy,onAdd,onRemove,onAssign}) {
    const ids=document.entry_media_ids||[];
    const used=new Set(document.stops.flatMap(s=>s.media_ids));
    // 一次用餐的多张照片可以一起归到某一站，不必逐站展开选择
    const [picking,setPicking]=useState(null);
    const toggle=id=>setPicking(list=>list.includes(id)?list.filter(x=>x!==id):[...list,id]);
    return <section className="jw-card jw-stack" aria-label={t('journey:review.photos.label')}>
        <div className="jw-row-between"><strong>{tx('journey:review.photos.title', { count: ids.length })}</strong>
            <span className="jw-inline-actions">
                {!!ids.length&&!!document.stops.length&&<button type="button" aria-pressed={!!picking} onClick={()=>setPicking(p=>p?null:[])}>{picking?t('journey:review.photos.cancelSelect'):t('journey:review.photos.batchAssign')}</button>}
                <button type="button" disabled={busy||ids.length>=60} onClick={onAdd}>{t('journey:review.photos.add')}</button>
            </span>
        </div>
        {ids.length?<div className="jw-photo-choice">{ids.map(id=>picking
            ?<button type="button" key={id} aria-pressed={picking.includes(id)} aria-label={picking.includes(id)?t('journey:review.photos.deselectOne'):t('journey:review.photos.selectOne')} onClick={()=>toggle(id)}>
                <PrivatePhoto id={id} base={base} token={token} alt=""/>{picking.includes(id)&&<span aria-hidden="true">✓</span>}</button>
            :<figure key={id} className="jw-entry-photo">
                <PrivatePhoto id={id} base={base} token={token} alt=""/>
                {!used.has(id)&&<figcaption>{t('journey:review.photos.unassigned')}</figcaption>}
                <button type="button" className="jw-entry-photo__remove" aria-label={t('journey:review.photos.removeFromEntry')} onClick={()=>onRemove(id)}>×</button>
            </figure>)}</div>:<p className="jw-muted">{t('journey:review.photos.empty')}</p>}
        {picking&&<label className="jw-field"><span className="jw-field__label">{tx('journey:review.photos.assignSelected', { count: picking.length })}</span>
            <select aria-label={t('journey:review.photos.assignSelectLabel')} value="" disabled={!picking.length} onChange={e=>{if(e.target.value){onAssign(picking,e.target.value);setPicking(null);}}}>
                <option value="">{t('journey:review.photos.chooseStop')}</option>{document.stops.map((s,i)=><option key={s.id} value={s.id}>{i+1}. {s.name}</option>)}
            </select></label>}
        {!picking&&ids.some(id=>!used.has(id))&&<p className="jw-muted">{t('journey:review.photos.unassignedHint')}</p>}
    </section>;
}
function PublicPreview({body,links}) {
    return <div className="jw-public-preview">
        <strong>{body.title}</strong>
        {body.summary&&<p>{body.summary}</p>}
        {body.text&&<p>{body.text}</p>}
        {!!body.entry_media_ids?.length&&<small className="jw-muted">{tx('journey:review.preview.morePhotos', { count: body.entry_media_ids.length })}</small>}
        {body.stops.map(s=><div key={s.id} className="jw-public-preview__stop">
            <span>{s.index+1}. {s.name}</span>
            {s.excerpt.length?s.excerpt.map((e,i)=><blockquote key={i} className={`jw-excerpt${e.kind==='edited'?' is-edited':''}`}>{e.text}<small>{e.kind==='edited'?t('journey:common.label.authorEdited'):t('journey:common.label.originalExcerpt')}</small></blockquote>):<small className="jw-muted">{t('journey:review.preview.noText')}</small>}
            <small className="jw-muted">{tx('journey:review.preview.stopMeta', { count: s.media_ids.length, mapAction: ({link:t('journey:review.preview.mapLink'),create:t('journey:review.preview.mapCreate')})[links.get(s.id)?.action]||t('journey:review.preview.mapNone') })}</small>
        </div>)}
        {!body.stops.length&&<p className="jw-muted">{t('journey:review.preview.noStops')}</p>}
    </div>;
}
