import React,{useEffect,useRef,useState} from 'react';
import {request,eventId} from './feedback';
import { t, tx } from '../i18n/index.js';

export default function MergePreview({base,token,selection,onMerged,onClose}) {
    const [policy,setPolicy]=useState('constraints'),[resolutions,setResolutions]=useState({});
    const [preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
    const attempt=useRef(null);
    useEffect(()=>{
        const controller=new AbortController();setLoading(true);setError('');
        request(base,token,'/api/journeys/merge/preview',{method:'POST',signal:controller.signal,body:JSON.stringify({...selection,order_policy:policy,expense_resolutions:resolutions})})
            .then(result=>{if(!controller.signal.aborted){setPreview(result);setLoading(false);}}).catch(e=>{if(!controller.signal.aborted){setError(e.message);setLoading(false);}});
        return()=>controller.abort();
    },[base,token,selection,policy,resolutions]);
    const commit=async()=>{
        setBusy(true);setError('');
        if(attempt.current?.hash!==preview.preview_hash)attempt.current={hash:preview.preview_hash,id:eventId()};
        try {const result=await request(base,token,'/api/journeys/merge',{method:'POST',body:JSON.stringify({...selection,order_policy:policy,expense_resolutions:resolutions,preview_hash:preview.preview_hash,request_id:attempt.current.id})});await onMerged(result);}
        catch(e){setError(e.message);}finally{setBusy(false);}
    };
    return <section className="journey-card journey-stack" aria-label={t('journey:mergePreview.label')}>
        <h3>{t('journey:mergePreview.label')}</h3>
        <label>{t('journey:mergePreview.policyLabel')}<select disabled={busy||loading} value={policy} onChange={e=>{setLoading(true);setPolicy(e.target.value);}}>
            <option value="constraints">{t('journey:mergePreview.policy.constraints')}</option><option value="time">{t('journey:mergePreview.policy.time')}</option><option value="source">{t('journey:mergePreview.policy.keep')}</option>
        </select></label>
        {error&&<p role="alert">{error}</p>}
        {!preview&&!error&&<p>{t('journey:mergePreview.checking')}</p>}
        {preview&&<>
            <ol>{preview.document.stops.map(s=><li key={s.id}>{s.at?.replace('T',' ')||t('journey:mergePreview.timeTbd')} · {s.name}</li>)}</ol>
            {preview.warnings.map((w,i)=><p key={i} className="journey-muted">{w}</p>)}
            {preview.conflicts.map((c,i)=><div key={i}><p>{c.message}</p>{c.type==='expense'&&<label>{t('journey:mergePreview.expenseChoice')}<select disabled={busy||loading} value={resolutions[c.id]||''} onChange={e=>{setLoading(true);setResolutions(r=>({...r,[c.id]:e.target.value}));}}>
                <option value="" disabled>{t('journey:mergePreview.choose')}</option>{c.options.map(o=><option key={o.ref} value={o.ref}>{o.title} · {o.place} · ¥{o.amount} · {o.note}</option>)}<option value="separate">{t('journey:mergePreview.keepBoth')}</option>
            </select></label>}</div>)}
            <strong>{tx('journey:mergePreview.total', { total: (preview.total_minor/100).toFixed(2) })}</strong>
            <p className="journey-muted">{t('journey:mergePreview.resultNote')}</p>
        </>}
        <div className="journey-actions"><button disabled={busy||loading||!!error||!preview||!!preview.conflicts.length} onClick={commit}>{t('journey:mergePreview.confirm')}</button><button disabled={busy} onClick={onClose}>{t('journey:mergePreview.cancel')}</button></div>
    </section>;
}
