import React,{useEffect,useState} from 'react';
import {makeCover} from './cover';
import {copyText,saveBlob,saveImageBlob,shareContent} from '../platform/share';
import {PageHeader,Notice} from './shared';
import { t, tx } from '../i18n/index.js';
import { AiTag, withAiLabel } from '../components/primitives/AiLabel';

/** 生成分享图文：只处理选中且确认到访的站点；默认不提供私人描述与账目。与站内公开阅读是两项独立能力。 */
export default function JourneyShare({ctx,nav,params}) {
    const {api,base,token,cap,tip}=ctx;
    const [journal,setJournal]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const [options,setOptions]=useState({platform:'小红书',style:'自然',min:100,max:500,include_notes:false,include_expenses:false,stop_ids:[]});
    const [share,setShare]=useState(null),[coverStyle,setCoverStyle]=useState('主站'),[caption,setCaption]=useState(''),[useBasemap,setUseBasemap]=useState(false);
    const [coverBlob,setCoverBlob]=useState(null),[coverUrl,setCoverUrl]=useState('');
    useEffect(()=>{
        api(`/${params.journeyId}`).then(j=>{setJournal(j);setOptions(o=>({...o,stop_ids:j.document.stops.filter(s=>s.confirmed&&s.visit_status==='visited').map(s=>s.id)}));}).catch(e=>setError(e.message));
    },[api,params.journeyId]);
    useEffect(()=>{if(!coverBlob){setCoverUrl('');return undefined;}const url=URL.createObjectURL(coverBlob);setCoverUrl(url);return()=>URL.revokeObjectURL(url);},[coverBlob]);
    const run=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const generate=()=>run(async()=>{
        const data=await api(`/${journal.id}/share`,{method:'POST',body:JSON.stringify({...options,base_revision:journal.revision})});
        setShare(data);setCaption(data.cover.caption);setCoverBlob(await makeCover(data.cover,coverStyle,data.cover.caption));
    });
    const refreshCover=()=>run(async()=>{
        let mapBlob=null;
        if(useBasemap){
            const response=await fetch(`${base}/api/journeys/${journal.id}/cover-map`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({base_revision:share.revision,stop_ids:share.stop_ids})});
            if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||t('journey:share.coverFailed'));}
            mapBlob=await response.blob();
        }
        setCoverBlob(await makeCover(share.cover,coverStyle,caption,mapBlob));
    });
    const visited=journal?.document.stops.filter(s=>s.confirmed&&s.visit_status==='visited')||[];
    const length=share?Array.from(share.text).length:0;
    // 模型写的贴文：复制、保存、系统分享时末尾附上“AI 辅助生成”的显式标识
    const exportText=share?(share.generated?withAiLabel(share.text):share.text):'';
    return <div className="jw-page">
        <PageHeader title={t('journey:common.action.generateShare')} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {error&&<Notice tone="error" onClose={()=>setError('')}>{error}</Notice>}
            {!journal?<p className="jw-muted">{t('journey:common.status.fetching')}</p>:<>
                <h3 className="jw-section-title">{t('journey:share.selectStops')}</h3>
                {!visited.length&&<Notice>{t('journey:share.noVisited')}</Notice>}
                {visited.map(s=><label key={s.id} className="jw-check"><input type="checkbox" checked={options.stop_ids.includes(s.id)} onChange={e=>{setShare(null);setOptions(o=>({...o,stop_ids:e.target.checked?[...o.stop_ids,s.id]:o.stop_ids.filter(id=>id!==s.id)}));}}/><span>{s.name}</span></label>)}
                <div className="jw-actions">
                    <label className="jw-field"><span className="jw-field__label">{t('journey:share.platform')}</span><select value={options.platform} onChange={e=>setOptions({...options,platform:e.target.value})}>{[['小红书',t('journey:share.platformOption.xiaohongshu')],['朋友圈',t('journey:share.platformOption.moments')],['手账',t('journey:share.platformOption.journal')],['日记',t('journey:share.platformOption.diary')]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="jw-field"><span className="jw-field__label">{t('journey:share.style')}</span><select value={options.style} onChange={e=>setOptions({...options,style:e.target.value})}>{[['自然',t('journey:share.styleOption.natural')],['活泼',t('journey:share.styleOption.lively')],['简洁',t('journey:share.styleOption.concise')],['文艺',t('journey:share.styleOption.literary')]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                </div>
                <div className="jw-actions">
                    <label className="jw-field"><span className="jw-field__label">{t('journey:share.minChars')}</span><input type="number" min="30" max="1000" value={options.min} onChange={e=>setOptions({...options,min:Number(e.target.value)})}/></label>
                    <label className="jw-field"><span className="jw-field__label">{t('journey:share.maxChars')}</span><input type="number" min="30" max="1500" value={options.max} onChange={e=>setOptions({...options,max:Number(e.target.value)})}/></label>
                </div>
                <label className="jw-check"><input type="checkbox" checked={options.include_notes} onChange={e=>setOptions({...options,include_notes:e.target.checked})}/><span>{t('journey:share.includeNotes')}</span></label>
                <label className="jw-check"><input type="checkbox" checked={options.include_expenses} onChange={e=>setOptions({...options,include_expenses:e.target.checked})}/><span>{t('journey:share.includeExpenses')}</span></label>
                <button type="button" className="jw-primary" disabled={busy||!options.stop_ids.length} onClick={generate}>{t('journey:share.generate')}</button>
                {share&&<>
                    <label className="jw-field"><span className="jw-field__label">{t('journey:share.postLabel')}{share.generated&&<AiTag style={{marginLeft:6}}/>}</span><textarea rows={9} maxLength={4000} value={share.text} onChange={e=>setShare({...share,text:e.target.value})}/></label>
                    <p className="jw-muted">{tx('journey:share.lengthInfo', { length, min: share.min, max: share.max, rangeHint: length<share.min||length>share.max?t('journey:share.lengthOutOfRange'):'', aiNote: !share.generated?t('journey:share.noAiNote'):'' })}</p>
                    {share.generated&&<p className="jw-muted">{t('journey:share.aiExportNote')}</p>}
                    <div className="jw-actions">
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.coverStyle')}</span><select value={coverStyle} onChange={e=>setCoverStyle(e.target.value)}>{[['主站',t('journey:share.coverOption.site')],['奶油',t('journey:share.coverOption.cream')],['薄荷',t('journey:share.coverOption.mint')],['夜色',t('journey:share.coverOption.night')]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                        <label className="jw-field"><span className="jw-field__label">{t('journey:share.caption')}</span><input value={caption} maxLength={100} onChange={e=>setCaption(e.target.value)}/></label>
                    </div>
                    <label className="jw-check"><input type="checkbox" disabled={!cap.amap_export} checked={useBasemap} onChange={e=>setUseBasemap(e.target.checked)}/><span>{tx('journey:share.useAmapBase', { pendingNote: !cap.amap_export?t('journey:share.amapPending'):'' })}</span></label>
                    <button type="button" disabled={busy} onClick={refreshCover}>{t('journey:share.refreshCover')}</button>
                    {coverUrl&&<img className="jw-cover" src={coverUrl} alt={t('journey:share.coverAlt')}/>}
                    <p className="jw-muted">{t('journey:share.exportHint')}</p>
                    <div className="jw-actions">
                        <button type="button" onClick={()=>run(async()=>{if(!await copyText(exportText))throw new Error(t('journey:share.copyFailed'));tip(t('journey:share.postCopied'));})}>{t('journey:share.copyPost')}</button>
                        <button type="button" disabled={!coverBlob} onClick={()=>run(async()=>{const r=await saveImageBlob(coverBlob,t('journey:share.coverFilename'));if(r==='failed')throw new Error(t('journey:share.coverSaveFailed'));})}>{t('journey:share.saveCover')}</button>
                        <button type="button" onClick={()=>run(async()=>{const r=await saveBlob(new Blob([exportText],{type:'text/plain;charset=utf-8'}),t('journey:share.postFilename'));if(r==='failed')throw new Error(t('journey:share.postSaveFailed'));})}>{t('journey:share.savePost')}</button>
                        <button type="button" disabled={!coverBlob} onClick={()=>run(async()=>{const file=new File([coverBlob],t('journey:share.coverFilename'),{type:'image/png'});const r=await shareContent({files:[file],text:exportText,title:share.cover.title});if(r==='unsupported')throw new Error(t('journey:share.shareUnsupported'));if(r==='failed')throw new Error(t('journey:share.shareFailed'));})}>{t('journey:share.systemShare')}</button>
                    </div>
                </>}
            </>}
        </div></div>
    </div>;
}
