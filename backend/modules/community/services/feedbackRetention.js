const DAY_MS=86400000;
const FEEDBACK_RETENTION_DAYS=90,LEGACY_RETENTION_DAYS=30;
const RETENTION_POLICY_VERSION='feedback-90d-v2',RESEARCH_PURPOSE_VERSION='rating-research-v2-90d',LEGACY_PURPOSE_VERSION='rating-research-v1';
function initRetention(db,now=Date.now()){
    db.exec('CREATE TABLE IF NOT EXISTS FeedbackRetentionPolicy(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,effective_at_ms INTEGER NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO FeedbackRetentionPolicy VALUES(1,?,?)').run(RETENTION_POLICY_VERSION,now);
}
function sourceExpiry(db,at,purposeVersion=null){
    const policy=db.prepare('SELECT effective_at_ms FROM FeedbackRetentionPolicy WHERE id=1').get();
    const days=policy&&at>=policy.effective_at_ms&&(!purposeVersion||purposeVersion===RESEARCH_PURPOSE_VERSION)?FEEDBACK_RETENTION_DAYS:LEGACY_RETENTION_DAYS;
    return Number.isFinite(at)?at+days*DAY_MS:0;
}
function isRetained(db,at,now=Date.now(),purposeVersion=null){return Number.isFinite(at)&&at<=now&&sourceExpiry(db,at,purposeVersion)>now;}
function cleanupFeedback(db,now=Date.now()){
    return db.transaction(()=>{
        let deleted=0;
        for(const [table,column,iso] of [['MapInteraction','created_at',true],['MapDecision','created_at',true],['UserBehaviorEvent','occurred_at',false]]){
            const policy=db.prepare('SELECT effective_at_ms FROM FeedbackRetentionPolicy WHERE id=1').get();
            const cutoff=now-FEEDBACK_RETENTION_DAYS*DAY_MS,legacy=Math.min(now-LEGACY_RETENTION_DAYS*DAY_MS,policy.effective_at_ms-1);
            const convert=v=>iso?new Date(v).toISOString():v;
            deleted+=db.prepare(`DELETE FROM ${table} WHERE ${column}<=? OR ${column}<=?`).run(convert(cutoff),convert(legacy)).changes;
        }
        for(const table of ['PlaceVisitView','PlaceVisitEvidence'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))deleted+=db.prepare(`DELETE FROM ${table} WHERE expires_at_ms<=?`).run(now).changes;
        return {deleted};
    })();
}
function clearVisitFeedback(db,userId){
    for(const table of ['PlaceVisitView','PlaceVisitEvidence'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
}
module.exports={clearVisitFeedback,DAY_MS,FEEDBACK_RETENTION_DAYS,LEGACY_RETENTION_DAYS,RETENTION_POLICY_VERSION,RESEARCH_PURPOSE_VERSION,LEGACY_PURPOSE_VERSION,initRetention,sourceExpiry,isRetained,cleanupFeedback};
