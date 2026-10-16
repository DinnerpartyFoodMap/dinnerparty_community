import React,{useEffect,useRef,useState} from 'react';
import {eventId} from './feedback';
import {PageHeader,Notice} from './shared';
import { t, tx } from '../i18n/index.js';

// 只展示后端真实的四种状态，不显示虚构的进度百分比。
const STEPS={queued:t('journey:generation.step.queued'),running:t('journey:generation.step.running'),ready:t('journey:generation.step.ready'),failed:t('journey:generation.step.failed')};

/** 生成状态：任务在服务器继续；停留本页时完成后直接进入核对，离开后可在日历继续。 */
export default function JourneyGeneration({ctx,nav,params,active}) {
    const {api}=ctx;
    const [job,setJob]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
    const retryAttempt=useRef(null),opened=useRef(false);
    useEffect(()=>{
        let alive=true,timer;
        const poll=async()=>{
            try{
                const result=await api(`/jobs/${params.jobId}`);
                if(!alive)return;
                setJob(result);setError('');
                if(['queued','running'].includes(result.status))timer=setTimeout(poll,2000);
            }catch(e){
                if(!alive)return;
                if(e.status===404){setError(t('journey:generation.jobMissing'));return;}
                setError(t('journey:generation.progressRetrying'));timer=setTimeout(poll,4000);
            }
        };
        poll();
        return()=>{alive=false;clearTimeout(timer);};
    },[api,params.jobId]);
    // 完成且用户仍停留在本页时直接进入核对；在其他页面时不抢焦点
    useEffect(()=>{
        if(job?.status==='ready'&&job.draft_id&&active&&!opened.current){
            opened.current=true;
            nav.replace('review',{mode:'create',draftId:job.draft_id,notice:job.output?.text_only&&job.input?.media_ids?.length?t('journey:generation.textOnlyNotice'):job.output?.notice});
        }
    },[job,active,nav]);
    const retry=async()=>{
        setBusy(true);setError('');
        try{
            const compose=await api(`/compose-drafts/${params.composeId}`);
            // 失败重试复用原素材；同一次重试的连点与重发沿用同一编号
            const key=`${compose.revision}`;
            if(retryAttempt.current?.key!==key)retryAttempt.current={key,id:eventId()};
            const next=await api(`/compose-drafts/${params.composeId}/generate`,{method:'POST',body:JSON.stringify({compose_revision:compose.revision,request_id:retryAttempt.current.id,text_only:!!job?.input?.text_only})});
            nav.replace('generation',{composeId:params.composeId,jobId:next.id});
        }catch(e){setError(e.message);if([409,410].includes(e.status))retryAttempt.current=null;}
        finally{setBusy(false);}
    };
    const status=job?.status||'queued';
    return <div className="jw-page">
        <PageHeader title={t('journey:common.action.generateDraft')} onBack={nav.pop}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            <div className={`jw-progress jw-progress--${status}`} role="status" aria-live="polite">
                {['queued','running'].includes(status)&&<span className="jw-spinner" aria-hidden="true"/>}
                <strong>{STEPS[status]||status}</strong>
                {['queued','running'].includes(status)&&<p className="jw-muted">{t('journey:generation.waitHint')}</p>}
                {status==='ready'&&!job?.draft_id&&<p className="jw-muted">{t('journey:generation.readyNoDraft')}</p>}
            </div>
            {status==='failed'&&<Notice tone="error">{tx('journey:generation.failedNotice', { error: job?.error||t('journey:generation.step.failed') })}</Notice>}
            {error&&<Notice tone="warn">{error}</Notice>}
            <div className="jw-actions jw-actions--column">
                {status==='failed'&&<button type="button" className="jw-primary" disabled={busy} onClick={retry}>{t('journey:generation.regenerate')}</button>}
                {status==='failed'&&<button type="button" disabled={busy} onClick={()=>nav.replace('composer',{composeId:params.composeId})}>{t('journey:generation.backToMaterial')}</button>}
                {status==='ready'&&job?.draft_id&&<button type="button" className="jw-primary" onClick={()=>nav.replace('review',{mode:'create',draftId:job.draft_id})}>{t('journey:generation.startReview')}</button>}
                <button type="button" onClick={()=>nav.reset('calendar',{})}>{t('journey:generation.backToCalendar')}</button>
            </div>
        </div></div>
    </div>;
}
