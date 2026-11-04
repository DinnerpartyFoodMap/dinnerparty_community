const {createHmac}=require('crypto');
const retention=require('./feedbackRetention');
// This export is deliberately separate from online recommendation weights.
function buildDataset(db,{secret,localDataAllowed=false,now=Date.now()}={}) {
    if(!localDataAllowed)throw new Error('须先确认站内地点数据可用于研究，再设置 TRAINING_LOCAL_PLACE_DATA_ALLOWED=true');
    if(typeof secret!=='string'||secret.length<32)throw new Error('FEEDBACK_EXPORT_SECRET 须至少 32 字符，用于不可逆的账号假名');
    const hash=value=>createHmac('sha256',secret).update(value).digest('hex').slice(0,32);
    const cutoff=new Date(now-retention.FEEDBACK_RETENTION_DAYS*retention.DAY_MS).toISOString();
    const rows=db.prepare(`SELECT e.* FROM MapInteraction e JOIN MapConsent c ON c.user_id=e.user_id
      WHERE c.feedback=1 AND c.research=1 AND e.research_allowed=1 AND e.created_at>=?
        AND EXISTS(SELECT 1 FROM AlgorithmEventContext ec JOIN ResearchConsentEvent rc ON rc.id=ec.consent_ref
          WHERE ec.event_id=e.id AND ec.user_id=e.user_id AND ec.research_allowed=1 AND rc.allowed=1 AND rc.revoked_at_ms IS NULL)
        AND EXISTS(SELECT 1 FROM ResearchConsentEvent latest WHERE latest.user_id=e.user_id AND latest.allowed=1 AND latest.revoked_at_ms IS NULL
          AND latest.rowid=(SELECT MAX(rowid) FROM ResearchConsentEvent WHERE user_id=e.user_id))
      ORDER BY e.created_at,e.id`).all(cutoff);
    return rows.filter(e=>{
        const grant=db.prepare('SELECT rc.* FROM AlgorithmEventContext ec JOIN ResearchConsentEvent rc ON rc.id=ec.consent_ref WHERE ec.event_id=? AND ec.user_id=? AND ec.source_table=?').get(e.id,e.user_id,'MapInteraction');
        return grant&&[retention.RESEARCH_PURPOSE_VERSION,retention.LEGACY_PURPOSE_VERSION].includes(grant.purpose_version)&&grant.recorded_at_ms<=Date.parse(e.created_at)&&retention.isRetained(db,Date.parse(e.created_at),now,grant.purpose_version);
    }).map(e=>{
        const decision=e.decision_id?db.prepare('SELECT snapshot,result,created_at FROM MapDecision WHERE id=? AND user_id=?').get(e.decision_id,e.user_id):null;
        const retainedDecision=decision&&retention.isRetained(db,Date.parse(decision.created_at),now)?decision:null;
        const snapshot=retainedDecision?JSON.parse(retainedDecision.snapshot):null;
        const result=retainedDecision?JSON.parse(retainedDecision.result):null;
        const context=db.prepare('SELECT context FROM MapInteractionContext WHERE event_id=?').get(e.id);
        return {schema_version:2,user:hash(e.user_id),session:hash(`${e.user_id}:${e.session_id}`),event_id:e.id,
            ...(context?JSON.parse(context.context):{}),
            day:e.created_at.slice(0,10),event:e.kind,surface:e.surface,place_id:e.place_id,rank:e.rank,reason:e.reason,
            decision_id:e.decision_id,algorithm:snapshot?.algorithm||null,
            recommendation_session_id:snapshot?.recommendation_session_id?hash(`${e.user_id}:${snapshot.recommendation_session_id}`):null,
            parent_decision_id:snapshot?.parent_decision_id??null,draw_index:snapshot?.draw_index??null,
            decision_surface:snapshot?.surface??null,policy_version:snapshot?.policy_version??null,model_version:snapshot?.model_version??null,
            feature_snapshot_version:snapshot?.feature_snapshot_version??null,feature_snapshot:null,
            display_version:snapshot?.display_version??null,
            selected_place_id:result?.place?.id||null,selected_probability:snapshot?.selected_probability||null,
            candidates:snapshot?.candidates||[],
            label_strength:e.kind==='favorite'?'explicit_preference':e.kind==='confirm_stop'?'user_assertion':e.kind==='correction'?'needs_review':'interaction_only'};
    });
}
function evaluateLoggedRandom(rows){
    const decisions=new Map();
    for(const row of rows) {
        if(row.algorithm!=='random-mixture-v1'||!row.decision_id||!(row.selected_probability>0)||!row.candidates.length)continue;
        if(!decisions.has(row.decision_id))decisions.set(row.decision_id,{...row,exposed:false,clicked:false});
        const item=decisions.get(row.decision_id);
        if(row.place_id===item.selected_place_id){if(row.event==='exposure')item.exposed=true;if(row.event==='click')item.clicked=true;}
    }
    const samples=[...decisions.values()].filter(x=>x.exposed);
    // A simple, explicit counterfactual: uniform policy over the SAME eligible set.
    const weighted=samples.map(s=>({reward:+s.clicked,weight:(1/s.candidates.length)/s.selected_probability}));
    const sum=weighted.reduce((n,x)=>n+x.weight,0),weightedReward=weighted.reduce((n,x)=>n+x.weight*x.reward,0);
    return {exposed_decisions:samples.length,observed_click_rate:samples.length?samples.filter(s=>s.clicked).length/samples.length:null,
        uniform_policy_ips:samples.length?weightedReward/samples.length:null,uniform_policy_snips:sum?weightedReward/sum:null,
        effective_sample_size:sum?sum*sum/weighted.reduce((n,x)=>n+x.weight*x.weight,0):0,
        note:'仅对记录了实际可见曝光的随机推荐估计均匀策略；点击不代表到访。样本少或有效样本量低时不能据此上线新模型。搜索快照没有 propensity，不参与 IPS。'};
}
module.exports={buildDataset,evaluateLoggedRandom};
