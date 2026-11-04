function classifyRatingEvidence(current,revisions=[]){
    if(!current||current.is_banned)return {kind:'excluded',eligible:false,basis:'excluded'};
    const lastWithdrawal=revisions.map(r=>r.action).lastIndexOf('withdraw');
    const explicit=revisions.slice(lastWithdrawal+1).some(r=>['rate','change'].includes(r.action)||r.action==='create'&&r.origin==='creation_explicit');
    const retainedDefault=lastWithdrawal<0&&['migration','create','user'].includes(current.source);
    return {kind:explicit?'explicit':retainedDefault?'legacy_default':'unknown',eligible:explicit||retainedDefault,basis:explicit?'revision':retainedDefault?'stored_rating':'unknown_history'};
}
module.exports={classifyRatingEvidence};
