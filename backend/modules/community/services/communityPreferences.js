const { createHash } = require('crypto');
const { sql, now } = require('../../journeys/services/journeyStore');
const { getUserPreference } = require('../../preferences/services/userPreferenceService');
const { notBlockedSql } = require('../../accounts/services/userRelations');
function consent(userId) {
    sql.prepare(`INSERT OR IGNORE INTO MapConsent(user_id,feedback,research,discovery,tags,version,updated_at)
        SELECT id,1,1,1,'[]',0,? FROM User WHERE id=?`).run(now(), userId);
    const row = sql.prepare('SELECT * FROM MapConsent WHERE user_id=?').get(userId);
    return row ? { feedback: !!row.feedback, research: !!row.research, discovery: !!row.discovery, tags: JSON.parse(row.tags), version: row.version } : { feedback: true, research: true, discovery: true, tags: [], version: 0 };
}
async function neighbors(userId) {
    const settings = consent(userId), algorithm = 'user-preference-cosine-v1';
    if (!settings.discovery) return { neighbors: [], profile_status: 'disabled', signal_count: 0, algorithm, notice: '开启同好发现后，可使用用户向量匹配同好。' };
    const mine = await getUserPreference(userId);
    if (mine?.status !== 'ready' || !mine.vector) return { neighbors: [], profile_status: mine?.status || 'empty', signal_count: mine?.vector_place_count || 0, algorithm, notice: '用户向量尚未就绪；收藏地点或使用地图后，系统会逐步更新偏好。无需公开收藏夹。' };
    const people = sql.prepare(`SELECT u.id,u.username,c.tags FROM User u
        JOIN MapConsent c ON c.user_id=u.id JOIN UserPreference p ON p.user_id=u.id
        WHERE c.discovery=1 AND u.id<>? AND COALESCE(u.is_banned,0)=0 AND ${notBlockedSql('u.id')}
        ORDER BY p.updated_at DESC,u.id LIMIT 1000`).all(userId, userId);
    const results = [];
    for (const user of people) {
        const other = await getUserPreference(user.id);
        if (other?.status !== 'ready' || !other.vector || mine.model !== other.model || mine.dimensions !== other.dimensions || mine.algorithm_version !== other.algorithm_version) continue;
        const cosine = mine.vector.reduce((n, v, i) => n + v * other.vector[i], 0);
        if (!Number.isFinite(cosine) || cosine <= 0) continue;
        const similarity = Math.min(1, Math.max(0, cosine));
        const angle = createHash('sha256').update(user.id).digest().readUInt32BE(0) / 4294967296 * Math.PI * 2;
        const radius = 0.15 + 0.8 * (1 - similarity);
        // Explanations only use explicitly displayed tags, never private source places.
        const tags = JSON.parse(user.tags);
        results.push({
            id: user.id, username: user.username, similarity, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
            confidence: Math.min(mine.vector_place_count, other.vector_place_count) >= 5 ? '参考数据较多' : '参考数据较少',
            shared: settings.tags.filter(t => tags.includes(t)).slice(0, 3).map(t => `共同标签：${t}`)
        });
    }
    // Every profile read above can yield to a withdrawal, ban, deletion or block.
    // Apply the current disclosure rules once more with no await before returning.
    const current=consent(userId);
    const owner=sql.prepare('SELECT is_banned FROM User WHERE id=?').get(userId);
    if(!owner||owner.is_banned||!current.discovery)return {neighbors:[],profile_status:'disabled',signal_count:0,algorithm};
    const visible=new Map(sql.prepare(`SELECT u.id,u.username,c.tags FROM User u JOIN MapConsent c ON c.user_id=u.id
        WHERE c.discovery=1 AND COALESCE(u.is_banned,0)=0 AND ${notBlockedSql('u.id')}`).all(userId).map(u=>[u.id,u]));
    const disclosed=results.filter(r=>visible.has(r.id)).map(r=>{
        const user=visible.get(r.id),tags=JSON.parse(user.tags);
        return {...r,username:user.username,shared:current.tags.filter(t=>tags.includes(t)).slice(0,3).map(t=>`共同标签：${t}`)};
    });
    return { neighbors: disclosed.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, 30), profile_status: 'ready', signal_count: mine.vector_place_count, algorithm };
}
module.exports = { consent, neighbors };
