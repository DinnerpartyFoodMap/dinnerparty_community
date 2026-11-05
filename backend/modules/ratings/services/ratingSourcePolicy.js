function classifyRatingEvidence(current,revisions=[]){
    if(!current||current.is_banned)return {kind:'excluded',eligible:false,basis:'excluded'};
    const lastWithdrawal=revisions.map(r=>r.action).lastIndexOf('withdraw');
    const explicit=revisions.slice(lastWithdrawal+1).some(r=>['rate','change'].includes(r.action)||r.action==='create'&&r.origin==='creation_explicit');
    const latest=revisions.at(-1),reassigned=latest?.action==='create'&&latest.origin==='owner_reassign';
    const retainedDefault=(lastWithdrawal<0||reassigned)&&['migration','create','user'].includes(current.source);
    return {kind:explicit?'explicit':retainedDefault?'legacy_default':'unknown',eligible:explicit||retainedDefault,basis:explicit?'revision':reassigned?'administrative_reassignment':retainedDefault?'stored_rating':'unknown_history'};
}
module.exports={classifyRatingEvidence};
