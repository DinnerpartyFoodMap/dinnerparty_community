import React,{useCallback,useEffect,useState} from 'react';
import MergePreview from './MergePreview';
import {PageHeader,Notice,PrivatePhoto,Empty,formatRange,visibilityBadge,today} from './shared';
import {newDocument} from './reviewUtils';
import {loadUnfinished} from './JourneyUnfinished';
import { t, tx } from '../i18n/index.js';

const WEEK=[t('journey:calendar.week.sun'),t('journey:calendar.week.mon'),t('journey:calendar.week.tue'),t('journey:calendar.week.wed'),t('journey:calendar.week.thu'),t('journey:calendar.week.fri'),t('journey:calendar.week.sat')];
const monthRange=month=>{const [y,m]=month.split('-').map(Number);const last=new Date(y,m,0).getDate();return [`${month}-01`,`${month}-${String(last).padStart(2,'0')}`];};
const shiftMonth=(month,delta)=>{const [y,m]=month.split('-').map(Number);const d=new Date(y,m-1+delta,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};

/**
 * 日历：月份导航 → 月历 → 选中日期的日记列表。未完成内容统一从「未完成 · N」进入。
 * 搜索（店名、城市、关键词）与公开状态筛选跨月份查找；「管理」里可多选删除，选两篇可合并。
 */
export default function JourneyCalendar({ctx,nav,params,active}) {
    const {api,base,token,confirm,tip}=ctx;
    const month=params.month||today().slice(0,7),day=params.day||'';
    const [data,setData]=useState(null),[error,setError]=useState('');
    const [manage,setManage]=useState(false),[selected,setSelected]=useState([]),[merge,setMerge]=useState(null),[unfinished,setUnfinished]=useState(null);
    const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[results,setResults]=useState(null),[busy,setBusy]=useState(false);
    const searching=!!query.trim()||!!filter;
    const load=useCallback(async()=>{
        const [from,to]=monthRange(month);
        try{setData(await api(`/calendar?from=${from}&to=${to}`));setError('');}catch(e){setError(e.message);}
    },[api,month]);
    useEffect(()=>{if(active)load();},[active,load]);
    // 未完成计数单独读取并合并本机内容，服务器失败也不影响本机草稿的入口
    useEffect(()=>{if(active)loadUnfinished(api,ctx.userId).then(r=>setUnfinished(r.total)).catch(()=>{});},[active,api,ctx.userId]);
    const runSearch=useCallback(async()=>{
        if(!searching){setResults(null);return;}
        try{setResults(await api(`/search?q=${encodeURIComponent(query.trim())}&visibility=${filter}`));setError('');}catch(e){setError(e.message);}
    },[api,query,filter,searching]);
    useEffect(()=>{if(!active)return undefined;const timer=setTimeout(runSearch,300);return()=>clearTimeout(timer);},[active,runSearch]);
    const setMonth=m=>nav.setParams({month:m,day:''});
    const entries=data?.entries||[];
    const listed=searching?results||[]:day?entries.filter(j=>j.start_date<=day&&j.end_date>=day):entries;
    const [y,m]=month.split('-').map(Number);
    const days=Array.from({length:new Date(y,m,0).getDate()},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
    const lead=new Date(y,m-1,1).getDay();
    const toggle=id=>setSelected(v=>v.includes(id)?v.filter(x=>x!==id):[...v,id]);
    const chosen=selected.map(id=>listed.find(j=>j.id===id)).filter(Boolean);
    // 逐篇删除并如实汇总：已删除的不再显示，失败的保留勾选并说明原因
    const removeSelected=async()=>{
        if(!chosen.length||!(await confirm(t('journey:calendar.confirmDelete', { count: chosen.length, publicCount: chosen.filter(j=>j.visibility==='public').length?t('journey:calendar.confirmDeletePublic'):'' }))))return;
        setBusy(true);setError('');
        const failed=[];
        for(const j of chosen){
            try{await api(`/${j.id}`,{method:'DELETE',body:JSON.stringify({base_revision:j.revision})});}
            catch(e){failed.push({id:j.id,title:j.title,message:e.message});}
        }
        setBusy(false);setSelected(failed.map(f=>f.id));setMerge(null);
        const done=chosen.length-failed.length;
        if(done)tip(t('journey:calendar.deleted', { count: done }));
        if(failed.length)setError(t('journey:calendar.deleteFailed', { items: failed.map(f=>`「${f.title}」${f.message}`).join(t('common:punctuation.listSeparator')) }));
        await load();if(searching)await runSearch();
    };
    return <div className="jw-page">
        <PageHeader title={t('journey:common.feature.calendar')} onBack={nav.pop} right={<button type="button" className="jw-header__action" aria-pressed={manage} onClick={()=>{setManage(v=>!v);setSelected([]);setMerge(null);}}>{manage?t('journey:calendar.done'):t('journey:calendar.manage')}</button>}/>
        <div className="jw-scroll"><div className="jw-content jw-stack">
            {error&&<Notice tone="error">{error}</Notice>}
            <button type="button" className="jw-pill" onClick={()=>nav.push('unfinished')}>{tx('journey:calendar.unfinished', { badge: unfinished?` · ${unfinished}`:'' })}</button>
            <div className="jw-calendar-search" role="search">
                <label className="jw-field"><span className="jw-visually-hidden">{t('journey:calendar.searchLabel')}</span>
                    <input type="search" value={query} maxLength={100} placeholder={t('journey:calendar.searchPlaceholder')} onChange={e=>{setQuery(e.target.value);setSelected([]);}}/></label>
                <div className="jw-segmented" role="radiogroup" aria-label={t('journey:calendar.filterLabel')}>
                    {[['',t('journey:calendar.filterAll')],['public',t('journey:common.label.public')],['private',t('journey:common.label.private')]].map(([value,label])=>
                        <button type="button" key={value||'all'} role="radio" aria-checked={filter===value} onClick={()=>{setFilter(value);setSelected([]);}}>{label}</button>)}
                </div>
            </div>
            {!searching&&<>
            <div className="jw-month">
                <button type="button" aria-label={t('journey:calendar.prevMonth')} onClick={()=>setMonth(shiftMonth(month,-1))}>‹</button>
                <label><span className="jw-visually-hidden">{t('journey:calendar.chooseMonth')}</span><input type="month" value={month} onChange={e=>e.target.value&&setMonth(e.target.value)}/></label>
                <button type="button" aria-label={t('journey:calendar.nextMonth')} onClick={()=>setMonth(shiftMonth(month,1))}>›</button>
            </div>
            <div className="jw-calendar" role="grid" aria-label={t('journey:calendar.monthLabel', { y, m })}>
                {WEEK.map(t=><small key={t} role="columnheader">{t}</small>)}
                {Array.from({length:lead},(_,i)=><span key={`blank${i}`}/>)}
                {days.map(d=>{
                    const n=entries.filter(j=>j.start_date<=d&&j.end_date>=d).length,draft=data?.draft_dates?.includes(d);
                    return <button type="button" key={d} role="gridcell" aria-selected={d===day} data-today={d===today()} onClick={()=>nav.setParams({day:d===day?'':d})}
                        aria-label={t('journey:calendar.dayLabel', { day: Number(d.slice(-2)), entries: n?t('journey:calendar.dayEntries', { n }):'', draft: draft?t('journey:calendar.dayHasDraft'):'' })}>
                        <span>{Number(d.slice(-2))}</span><small>{n?t('journey:calendar.dayCount', { n }):draft?t('journey:calendar.draft'):''}</small>
                    </button>;
                })}
            </div>
            </>}
            <div className="jw-row-between"><strong>{searching?tx('journey:calendar.searchTitle', { count: results?results.length:'…' }):tx('journey:calendar.listTitle', { range: day?formatRange(day):t('journey:calendar.monthShort', { m }) })}</strong>{manage&&<small className="jw-muted">{t('journey:calendar.manageHint')}</small>}</div>
            {listed.map(j=><div key={j.id} className="jw-entry-row">
                {manage&&<input type="checkbox" aria-label={t('journey:calendar.selectEntry', { title: j.title })} checked={selected.includes(j.id)} onChange={()=>toggle(j.id)}/>}
                <button type="button" className="jw-entry" onClick={()=>manage?toggle(j.id):nav.push('detail',{journeyId:j.id})}>
                    {j.cover_media_id?<PrivatePhoto id={j.cover_media_id} base={base} token={token} className="jw-entry__cover" alt=""/>:<span className="jw-entry__cover jw-entry__cover--empty" aria-hidden="true">✦</span>}
                    <span className="jw-entry__body"><strong>{j.title}</strong><small>{tx('journey:calendar.entryMeta', { range: formatRange(j.start_date,j.end_date), stop_count: j.stop_count, extra: j.places.length?` · ${j.places.join(t('common:punctuation.listSeparator'))}`:'' })}</small></span>
                    <span>{visibilityBadge(j)}</span>
                </button>
            </div>)}
            {searching&&results&&!results.length&&<Empty title={t('journey:calendar.searchEmpty')}/>}
            {!searching&&data&&!listed.length&&(day?<Empty title={t('journey:calendar.emptyDayTitle')}>
                <div className="jw-actions">
                    <button type="button" className="jw-primary" onClick={()=>nav.push('composer',{preset:{date:day}})}>{t('journey:common.feature.generate')}</button>
                    <button type="button" onClick={()=>nav.push('review',{mode:'create',journal:{id:null,revision:0,document:newDocument(day)}})}>{t('journey:calendar.createManually')}</button>
                </div>
            </Empty>:<Empty title={t('journey:calendar.emptyMonthTitle')}>{t('journey:calendar.emptyMonthHint')}</Empty>)}
            {manage&&!!chosen.length&&<div className="jw-actions">
                <button type="button" className="jw-danger" disabled={busy} onClick={removeSelected}>{busy?t('journey:calendar.deleting'):t('journey:calendar.deleteSelected', { count: chosen.length })}</button>
                {chosen.length===2&&!merge&&<button type="button" disabled={busy} onClick={()=>setMerge({first_id:chosen[0].id,second_id:chosen[1].id,revisions:chosen.map(j=>j.revision)})}>{t('journey:calendar.previewMerge')}</button>}
            </div>}
            {merge&&<MergePreview base={base} token={token} selection={merge} onClose={()=>setMerge(null)} onMerged={async result=>{setMerge(null);setSelected([]);setManage(false);nav.push('detail',{journeyId:result.id,message:t('journey:calendar.merged')});}}/>}
            {manage&&<button type="button" onClick={()=>nav.push('media')}>{t('journey:common.feature.privateImages')}</button>}
        </div></div>
        {!manage&&<footer className="jw-footer"><div className="jw-footer__actions">
            <button type="button" className="jw-primary jw-wide" onClick={()=>nav.push('composer',{preset:day?{date:day}:undefined})}>{t('journey:common.feature.generate')}</button>
            <button type="button" className="jw-wide" onClick={()=>nav.push('review',{mode:'create',journal:{id:null,revision:0,document:newDocument(day||today())}})}>{t('journey:calendar.createManually')}</button>
        </div></footer>}
    </div>;
}
