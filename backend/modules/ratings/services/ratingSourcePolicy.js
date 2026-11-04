function classifyRatingEvidence(current,revisions=[]){
    if(!current||current.is_banned||current.source==='migration')return {kind:'legacy_auto',eligible:false,basis:'excluded'};
    const lastWithdrawal=revisions.map(r=>r.action).lastIndexOf('withdraw');
    const explicit=revisions.slice(lastWithdrawal+1).some(r=>['rate','change'].includes(r.action)||r.action==='create'&&r.origin==='creation_explicit');
    return {kind:explicit?'explicit':'unknown',eligible:explicit,basis:explicit?'revision':'unknown_history'};
}
module.exports={classifyRatingEvidence};
