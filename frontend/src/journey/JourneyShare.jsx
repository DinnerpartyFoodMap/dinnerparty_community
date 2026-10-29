import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {planPages,renderPages,resolveTemplate,defaultCaption,photoChoices,pagePhotos,COVER_STYLES,TEMPLATES} from './cover';
import {copyText,saveBlob,saveImageBlobs,shareContent,canShare} from '../platform/share';
import {saveLocalDraft,loadLocalDraft} from '../platform/localDraftStore';
import {getTokenUserId} from '../platform/credentialStore';
import {PageHeader,Notice,PrivatePhoto,PhotoViewer,formatRange} from './shared';
import { t, tx } from '../i18n/index.js';
import { AiTag, withAiLabel } from '../components/primitives/AiLabel';

const PLATFORMS=[['小红书',t('journey:share.platformOption.xiaohongshu')],['朋友圈',t('journey:share.platformOption.moments')],['手账',t('journey:share.platformOption.journal')],['日记',t('journey:share.platformOption.diary')]];
const WRITING=[['自然',t('journey:share.styleOption.natural')],['活泼',t('journey:share.styleOption.lively')],['简洁',t('journey:share.styleOption.concise')],['文艺',t('journey:share.styleOption.literary')]];
const COVER_LABEL={主站:t('journey:share.coverOption.site'),奶油:t('journey:share.coverOption.cream'),薄荷:t('journey:share.coverOption.mint'),夜色:t('journey:share.coverOption.night')};
const TEMPLATE_LABEL={single:t('journey:share.templateOption.single'),multi:t('journey:share.templateOption.multi'),collage:t('journey:share.templateOption.collage'),text:t('journey:share.templateOption.text')};
const DEFAULT_DESIGN={template:'auto',style:'主站',caption:null,coverPhoto:null,mainPhoto:{},focus:{},route:true,basemap:false,order:[],removed:[]};
const scope=o=>JSON.stringify({...o,stop_ids:[...(o?.stop_ids||[])].sort()});
// 按句切分（中文句号、问叹号与换行），用于删除没有依据的句子
const sentences=text=>String(text).split(/(?<=[。！？!?\n])/);

/**
 * 生成分享图文：只处理选中且确认到访的站点；默认不提供私人描述与账目。与站内公开阅读是两项独立能力。
 * 贴文、图片与生成时的分享范围绑定在同一份分享稿里（本机按账号保存，含手动修改）：
 * 范围收窄或日记已改动时停止导出旧内容；其他设置改动只标记“待更新”；图片随设置自动重画，画好前不能导出。
 */
export default function JourneyShare({ctx,nav,params}) {
    const {api,base,token,cap,tip}=ctx;
    const userId=getTokenUserId(token),slot=`share:${params.journeyId}`;
    const [journal,setJournal]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const [options,setOptions]=useState({platform:'小红书',style:'自然',min:100,max:500,include_notes:false,include_expenses:false,stop_ids:[]});
    const [share,setShare]=useState(null),[text,setText]=useState(''),[design,setDesign]=useState(DEFAULT_DESIGN);
    const [pages,setPages]=useState(null),[rendering,setRendering]=useState(false),[renderError,setRenderError]=useState('');
    const [done,setDone]=useState({}),[viewer,setViewer]=useState(null);
    const restored=useRef(false),photoCache=useRef(new Map()),mapCache=useRef(new Map());
    useEffect(()=>{
        let alive=true;
        Promise.all([api(`/${params.journeyId}`),loadLocalDraft(userId,slot).catch(()=>null)]).then(([j,record])=>{
            if(!alive)return;
            setJournal(j);
            const saved=record?.journal;
            if(saved?.share){
                // 恢复上次的分享稿：之后若日记已改动，会提示重新生成并停止导出
                setShare(saved.share);setText(saved.text??saved.share.text);setDesign({...DEFAULT_DESIGN,...saved.design});setOptions(saved.options||saved.share.options);
            }else setOptions(o=>({...o,stop_ids:j.document.stops.filter(s=>s.confirmed&&s.visit_status==='visited').map(s=>s.id)}));
            restored.current=true;
        }).catch(e=>{if(alive)setError(e.message);});
        return()=>{alive=false;};
    },[api,params.journeyId,userId,slot]);
    // 自动保存分享稿（手动修改的贴文、图片设置、当前选项）
    useEffect(()=>{
        if(!restored.current||!share||!userId)return undefined;
        const timer=setTimeout(()=>saveLocalDraft(userId,slot,{journal:{share,text,design,options},synced:true}),400);
        return()=>clearTimeout(timer);
    },[share,text,design,options,userId,slot]);

    const visited=journal?.document.stops.filter(s=>s.confirmed&&s.visit_status==='visited')||[];
    const generated=share?.options;
    // 分享范围收窄（少了站点、不再提供文字或支出）或日记已改动：旧贴文与图片可能含有不再分享的内容，停止导出
    const narrowed=!!generated&&((generated.include_notes&&!options.include_notes)||(generated.include_expenses&&!options.include_expenses)||generated.stop_ids.some(id=>!options.stop_ids.includes(id)));
    const outdated=!!share&&!!journal&&share.revision!==journal.revision;
    const blocked=narrowed||outdated;
    const textStale=!!generated&&!blocked&&scope(generated)!==scope(options);
    const exportText=share?(share.generated?withAiLabel(text):text):'';
    const unsupported=(share?.unsupported||[]).filter(c=>text.includes(c.text));

    const run=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const generate=()=>run(async()=>{
        if(share&&text!==share.text&&!(await ctx.confirm(t('journey:share.confirmReplaceEdited'))))return;
        const data=await api(`/${journal.id}/share`,{method:'POST',body:JSON.stringify({...options,base_revision:journal.revision})});
        // 贴文与图片来自同一份结果：图片按新结果重画，画好之前不能导出旧图
        setShare(data);setText(data.text);setDone({});
        setDesign(d=>({...d,caption:null,removed:[],order:[]}));
    });
    const loadPhoto=useCallback(async id=>{
        if(photoCache.current.has(id))return photoCache.current.get(id);
        const promise=fetch(`${base}/api/journeys/media/${id}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>{if(!r.ok)throw Error();return r.blob();})
            .then(blob=>createImageBitmap(blob)).catch(()=>{photoCache.current.delete(id);return null;});
        photoCache.current.set(id,promise);
        return promise;
    },[base,token]);
    const loadBasemap=useCallback(async()=>{
        const key=`${share.revision}:${share.stop_ids.join(',')}`;
        if(!mapCache.current.has(key))mapCache.current.set(key,(async()=>{
            const response=await fetch(`${base}/api/journeys/${journal.id}/cover-map`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({base_revision:share.revision,stop_ids:share.stop_ids})});
            if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||t('journey:share.coverFailed'));}
            return createImageBitmap(await response.blob());
        })().catch(e=>{mapCache.current.delete(key);throw e;}));
        return mapCache.current.get(key);
    },[base,token,share,journal]);
    const plan=useMemo(()=>share?planPages(share.cover,design):[],[share,design]);
    const caption=share?(design.caption??defaultCaption(share.cover,design.template)):'';
    // 设置一变就重画全部页面；失败时清空，不留下与当前设置不符的旧图
    useEffect(()=>{
        if(!share){setPages(null);return undefined;}
        let alive=true;setRendering(true);
        const timer=setTimeout(async()=>{
            try{
                const ids=pagePhotos(plan);
                const images=new Map(await Promise.all(ids.map(async id=>[id,await loadPhoto(id)])));
                let mapImage=null,mapWarning='';
                if(design.basemap&&plan.some(p=>p.kind==='route')){try{mapImage=await loadBasemap();}catch(e){mapWarning=e.message;}}
                const rendered=await renderPages(plan,{cover:share.cover,style:design.style,caption,focus:design.focus,images,mapImage,
                    range:formatRange(share.cover.start_date,share.cover.end_date)});
                if(mapWarning)rendered.filter(p=>p.parent==='route').slice(0,1).forEach(p=>p.warnings.push(t('journey:share.basemapFallback', { message: mapWarning })));
                if(!alive)return;
                setPages(rendered.map(p=>({...p,url:URL.createObjectURL(p.blob)})));setRenderError('');
            }catch(e){if(alive){setPages(null);setRenderError(e.message||t('journey:cover.renderFailed'));}}
            finally{if(alive)setRendering(false);}
        },250);
        return()=>{alive=false;clearTimeout(timer);};
    },[share,plan,design.style,design.focus,design.basemap,caption,loadPhoto,loadBasemap]);
    useEffect(()=>()=>pages?.forEach(p=>URL.revokeObjectURL(p.url)),[pages]);

    const setDesignPatch=patch=>setDesign(d=>({...d,...(typeof patch==='function'?patch(d):patch)}));
    const move=(key,delta)=>setDesignPatch(()=>{
        const keys=plan.map(p=>p.key),i=keys.indexOf(key);
        if(i<0||i+delta<0||i+delta>=keys.length)return {};
        [keys[i],keys[i+delta]]=[keys[i+delta],keys[i]];return {order:keys};
    });
    const removePage=key=>setDesignPatch(d=>({removed:[...new Set([...d.removed,key])]}));
    const filesOf=()=>pages.map((p,i)=>({blob:p.blob,filename:t('journey:share.imageFilename', { index: i+1 })}));
    const imagesReady=!!pages?.length&&!rendering&&!blocked;
    const textReady=!!share&&!blocked&&!!text.trim();
    const mark=(key,value)=>setDone(d=>({...d,[key]:value}));
    const copy=()=>run(async()=>{if(!await copyText(exportText))throw new Error(t('journey:share.copyFailed'));mark('copied',true);tip(t('journey:share.postCopied'));});
    const saveAll=()=>run(async()=>{
        const r=await saveImageBlobs(filesOf(),{title:share.cover.title});
        if(r==='failed')throw new Error(t('journey:share.coverSaveFailed'));
        if(r!=='cancelled')mark('saved',r==='downloaded'?t('journey:share.status.downloaded', { count: pages.length }):t('journey:share.status.savedPanel'));
    });
    const shareFiles=pages?filesOf().map(f=>new File([f.blob],f.filename,{type:'image/png'})):[];
    const canShareFiles=!!shareFiles.length&&canShare({files:shareFiles});
    // 很多应用接收图片时会丢掉文字：先复制文案，再打开系统分享；面板返回不代表已经在目标平台发布
    const systemShare=()=>run(async()=>{
        const copied=await copyText(exportText);if(copied)mark('copied',true);
        const r=await shareContent({files:shareFiles,text:exportText,title:share.cover.title});
        if(r==='unsupported')throw new Error(t('journey:share.shareUnsupported'));
        if(r==='failed')throw new Error(t('journey:share.shareFailed'));
        if(r==='shared')mark('shared',true);
    });
    const removeUnsupported=()=>setText(value=>sentences(value).filter(s=>!unsupported.some(c=>s.includes(c.text))).join('').trim());
    const length=Array.from(text).length;
    const choices=share?photoChoices(share.cover):[];
    const template=share?resolveTemplate(share.cover,design.template):'auto';
    const groups=plan.map(p=>({plan:p,pages:(pages||[]).filter(r=>r.parent===p.key)}));
    const fullPlan=share?planPages(share.cover,{...design,removed:[]}):[];
    const removed=fullPlan.filter(p=>design.removed.includes(p.key));
    const coverId=fullPlan.find(p=>p.kind==='cover')?.photo??fullPlan.find(p=>p.kind==='collage')?.photos[0]??null;
    const viewerPhotos=(pages||[]).map(p=>({id:p.key,caption:p.label,url:p.url}));
    return <div className="jw-page">
        <PageHeader title={t('journey:common.action.generateShare')} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {!journal?<p className="jw-muted">{t('journey:common.status.fetching')}</p>:<>
                <section className="jw-card jw-stack" aria-label={t('journey:share.scopeSection')}>
                    <h3 className="jw-section-title">{t('journey:share.selectStops')}</h3>
                    {!visited.length&&<Notice>{t('journey:share.noVisited')}</Notice>}
                    {visited.map(s=><label key={s.id} className="jw-check"><input type="checkbox" checked={options.stop_ids.includes(s.id)} onChange={e=>setOptions(o=>({...o,stop_ids:e.target.checked?[...o.stop_ids,s.id]:o.stop_ids.filter(id=>id!==s.id)}))}/><span>{s.name}</span></label>)}
                    <label className="jw-check"><input type="checkbox" checked={options.include_notes} onChange={e=>setOptions({...options,include_notes:e.target.checked})}/><span>{t('journey:share.includeNotes')}</span></label>
                    <label className="jw-check"><input type="checkbox" checked={options.include_expenses} onChange={e=>setOptions({...options,include_expenses:e.target.checked})}/><span>{t('journey:share.includeExpenses')}</span></label>
                </section>
                <section className="jw-card jw-stack" aria-label={t('journey:share.postSection')}>
                    <h3 className="jw-section-title">{t('journey:share.postSection')}</h3>
                    <div className="jw-actions">
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.platform')}</span><select value={options.platform} onChange={e=>setOptions({...options,platform:e.target.value})}>{PLATFORMS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.style')}</span><select value={options.style} onChange={e=>setOptions({...options,style:e.target.value})}>{WRITING.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                    </div>
                    <div className="jw-actions">
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.minChars')}</span><input type="number" min="30" max="1000" value={options.min} onChange={e=>setOptions({...options,min:Number(e.target.value)})}/></label>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.maxChars')}</span><input type="number" min="30" max="1500" value={options.max} onChange={e=>setOptions({...options,max:Number(e.target.value)})}/></label>
                    </div>
                    <button type="button" className="jw-primary" disabled={busy||!options.stop_ids.length} onClick={generate}>{share?t('journey:share.regenerate'):t('journey:share.generate')}</button>
                    {blocked&&<Notice tone="warn" role="alert">{outdated?t('journey:share.blockedOutdated'):t('journey:share.blockedNarrowed')}</Notice>}
                    {textStale&&<Notice role="status">{t('journey:share.textStale')}</Notice>}
                    {share&&<>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.postLabel')}{share.generated&&<AiTag style={{marginLeft:6}}/>}</span><textarea rows={9} maxLength={4000} value={text} onChange={e=>setText(e.target.value)}/></label>
                        <p className="jw-muted">{tx('journey:share.lengthInfo', { length, min: share.min, max: share.max, rangeHint: length<share.min||length>share.max?t('journey:share.lengthOutOfRange'):'', aiNote: !share.generated?t('journey:share.noAiNote'):'' })}{text!==share.text&&t('journey:share.editedNote')}</p>
                        {!!unsupported.length&&<Notice tone="warn" role="status">
                            <strong>{t('journey:share.unsupportedTitle')}</strong>
                            <span className="jw-claims">{unsupported.map(c=><mark key={c.text}>{c.text}</mark>)}</span>
                            <span>{t('journey:share.unsupportedHint')}</span>
                            <span className="jw-inline-actions"><button type="button" onClick={removeUnsupported}>{t('journey:share.removeUnsupported')}</button></span>
                        </Notice>}
                        {share.generated&&<p className="jw-muted">{t('journey:share.aiExportNote')}</p>}
                    </>}
                </section>
                {share&&<section className="jw-card jw-stack" aria-label={t('journey:share.imageSection')}>
                    <h3 className="jw-section-title">{t('journey:share.imageSection')}</h3>
                    <div className="jw-actions">
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.template')}</span><select value={design.template} onChange={e=>setDesignPatch({template:e.target.value,order:[],removed:[],caption:null})}>
                            {TEMPLATES.map(value=><option key={value} value={value}>{value==='auto'?t('journey:share.templateAuto', { name: TEMPLATE_LABEL[resolveTemplate(share.cover,'auto')] }):TEMPLATE_LABEL[value]}</option>)}</select></label>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.coverStyle')}</span><select value={design.style} onChange={e=>setDesignPatch({style:e.target.value})}>{COVER_STYLES.map(value=><option key={value} value={value}>{COVER_LABEL[value]}</option>)}</select></label>
                    </div>
                    {template!==design.template&&design.template!=='auto'&&<small className="jw-muted">{t('journey:share.templateFallback')}</small>}
                    <label className="jw-field"><span className="jw-field__label">{template==='single'?t('journey:share.captionSingle'):t('journey:share.caption')}</span><input value={caption} maxLength={100} onChange={e=>setDesignPatch({caption:e.target.value})}/></label>
                    {['single','multi','collage'].includes(template)&&!!choices.length&&<div className="jw-field"><span className="jw-field__label">{t('journey:share.coverPhoto')}</span>
                        <div className="jw-photo-choice">{choices.map(id=>{const on=coverId===id;return <button type="button" key={id} aria-pressed={on} aria-label={on?t('journey:share.coverPhotoCurrent'):t('journey:share.coverPhotoUse')} onClick={()=>setDesignPatch({coverPhoto:id})}>
                            <PrivatePhoto id={id} base={base} token={token} alt=""/>{on&&<span aria-hidden="true">✓</span>}</button>;})}</div></div>}
                    {template==='multi'&&<label className="jw-check"><input type="checkbox" checked={design.route!==false} onChange={e=>setDesignPatch({route:e.target.checked})}/><span>{t('journey:share.routePage')}</span></label>}
                    {plan.some(p=>p.kind==='route')&&<label className="jw-check"><input type="checkbox" disabled={!cap.amap_export} checked={design.basemap} onChange={e=>setDesignPatch({basemap:e.target.checked})}/><span>{tx('journey:share.useAmapBase', { pendingNote: !cap.amap_export?t('journey:share.amapPending'):'' })}</span></label>}
                    <p className="jw-muted" role="status">{rendering?t('journey:share.rendering'):renderError?'':tx('journey:share.pageCount', { count: pages?.length||0 })}</p>
                    {renderError&&<Notice tone="error">{renderError}</Notice>}
                    <ol className="jw-pages" aria-label={t('journey:share.pagesLabel')}>{groups.map((g,i)=>{
                        const photoIds=g.plan.kind==='stop'?g.plan.stop.media_ids:g.plan.kind==='collage'?[]:[];
                        const focusId=g.plan.kind==='collage'?g.plan.photos[0]:g.plan.photo;
                        return <li key={g.plan.key} className="jw-page-item">
                            <div className="jw-page-item__thumbs">{g.pages.map(p=><button type="button" key={p.key} className="jw-page-thumb" aria-label={tx('journey:share.previewPage', { label: p.label })} onClick={()=>setViewer(viewerPhotos.findIndex(v=>v.id===p.key))}><img src={p.url} alt=""/></button>)}
                                {!g.pages.length&&<span className="jw-page-thumb jw-photo-placeholder" aria-hidden="true"/>}</div>
                            <div className="jw-page-item__body">
                                <strong>{i+1}. {g.plan.label}</strong>
                                {g.pages.flatMap(p=>p.warnings).map(w=><small key={w} className="jw-warn-text">{w}</small>)}
                                {photoIds.length>1&&<label className="jw-field"><span className="jw-field__label">{t('journey:share.mainPhoto')}</span>
                                    <select value={g.plan.photo||''} onChange={e=>setDesignPatch(d=>({mainPhoto:{...d.mainPhoto,[g.plan.stop.id]:e.target.value}}))}>{photoIds.map((id,k)=><option key={id} value={id}>{t('journey:share.photoN', { n: k+1 })}</option>)}</select></label>}
                                {focusId&&<label className="jw-field"><span className="jw-field__label">{t('journey:share.crop')}</span>
                                    <input type="range" min="0" max="100" value={design.focus[focusId]??50} onChange={e=>setDesignPatch(d=>({focus:{...d.focus,[focusId]:Number(e.target.value)}}))}/></label>}
                                <span className="jw-inline-actions">
                                    <button type="button" disabled={i===0} onClick={()=>move(g.plan.key,-1)} aria-label={t('journey:share.moveUp')}>↑</button>
                                    <button type="button" disabled={i===groups.length-1} onClick={()=>move(g.plan.key,1)} aria-label={t('journey:share.moveDown')}>↓</button>
                                    <button type="button" className="jw-danger" disabled={groups.length<=1} onClick={()=>removePage(g.plan.key)}>{t('journey:share.removePage')}</button>
                                </span>
                            </div>
                        </li>;})}</ol>
                    {!!removed.length&&<p className="jw-muted">{t('journey:share.removedPages')}{removed.map(p=><button type="button" key={p.key} className="jw-link" onClick={()=>setDesignPatch(d=>({removed:d.removed.filter(k=>k!==p.key)}))}>{tx('journey:share.restorePage', { label: p.label })}</button>)}</p>}
                </section>}
                {share&&<section className="jw-card jw-stack" aria-label={t('journey:share.deliverSection')}>
                    <h3 className="jw-section-title">{t('journey:share.deliverSection')}</h3>
                    <ol className="jw-steps">
                        <li><span>{t('journey:share.step.preview')}</span><button type="button" disabled={!pages?.length||rendering} onClick={()=>setViewer(0)}>{t('journey:share.previewAll')}</button></li>
                        <li><span>{t('journey:share.step.copy')}{done.copied&&<em className="jw-done">{t('journey:share.status.copied')}</em>}</span><button type="button" disabled={busy||!textReady} onClick={copy}>{t('journey:share.copyPost')}</button></li>
                        <li><span>{t('journey:share.step.images')}{done.saved&&<em className="jw-done">{done.saved}</em>}{done.shared&&<em className="jw-done">{t('journey:share.status.sharePanel')}</em>}</span>
                            <span className="jw-inline-actions">
                                <button type="button" disabled={busy||!imagesReady} onClick={saveAll}>{tx('journey:share.saveImages', { count: pages?.length||0 })}</button>
                                {canShareFiles&&<button type="button" disabled={busy||!imagesReady||!textReady} onClick={systemShare}>{t('journey:share.systemShare')}</button>}
                            </span></li>
                        <li><span>{t('journey:share.step.publish')}</span></li>
                    </ol>
                    {!canShareFiles&&!!pages?.length&&<small className="jw-muted">{t('journey:share.shareFallback')}</small>}
                    <button type="button" className="jw-link" disabled={busy||!textReady} onClick={()=>run(async()=>{const r=await saveBlob(new Blob([exportText],{type:'text/plain;charset=utf-8'}),t('journey:share.postFilename'));if(r==='failed')throw new Error(t('journey:share.postSaveFailed'));})}>{t('journey:share.savePost')}</button>
                </section>}
            </>}
        </div></div>
        <PhotoViewer photos={viewerPhotos} index={viewer!=null&&viewer>=0?viewer:null} onIndex={setViewer} render={p=><img className="jw-viewer__img" src={p.url} alt={p.caption}/>}/>
    </div>;
}
