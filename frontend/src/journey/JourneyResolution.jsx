import React,{useEffect,useRef} from 'react';

/**
 * 已确认且到访的地点作为固定锚点：锚点变化后自动重新评估其他站点的候选顺序。
 * 只更新候选与建议，不改动名称、描述、照片、时间或账目。
 */
export function useAutoRank({document,drafts,api,applyResult,perform,busy}) {
    const latest=useRef(null);
    const rank=async()=>{
        const draft=await drafts.prepare();if(!draft.id)return;
        const result=await api(`/drafts/${draft.id}/rank`,{method:'POST',body:JSON.stringify({draft_revision:draft.revision})});
        applyResult(result);
    };
    latest.current={rank,perform,busy};
    const anchors=document?JSON.stringify(document.stops.map(s=>[s.id,s.confirmed,s.confirmed?s.lng:null,s.confirmed?s.lat:null,s.visit_status,s.location_resolution])):'';
    useEffect(()=>{
        if(!document||!document.stops.some(s=>!s.confirmed&&s.candidates?.length))return;
        const timer=setTimeout(()=>{if(!latest.current.busy)latest.current.perform(latest.current.rank,{quiet:true});},650);
        return()=>clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[anchors]);
    return rank;
}
