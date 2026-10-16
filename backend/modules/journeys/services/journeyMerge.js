const { createHash } = require('node:crypto');
const { getJourney, saveJourney, normalizeDocument, sql, fail } = require('./journeyStore');
const algorithms = require('./journeyAlgorithmClient');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function planMerge(a, b, options = {}) {
    const calculationOptions = { order_policy: options.order_policy || 'constraints', expense_resolutions: options.expense_resolutions || {} };
    const preview = await algorithms.compute('merge', { a, b, options: calculationOptions });
    const sourceVersions = new Map([[a.id, a.revision], [b.id, b.revision]]);
    if (preview.sources.length !== 2 || new Set(preview.sources.map(s => s.id)).size !== 2 || preview.sources.some(s => sourceVersions.get(s.id) !== s.revision)) fail('日记算法返回的合并来源无效', 502);
    const hash = digest({ document: preview.document, sources: preview.sources, policy: preview.order_policy,
        resolutions: Object.entries(calculationOptions.expense_resolutions).sort(), conflicts: preview.conflicts });
    if (hash !== preview.preview_hash || preview.order_policy !== calculationOptions.order_policy) fail('日记算法返回的合并预览无效', 502);
    return preview;
}
function sources(userId, aId, bId, revisions) {
    const a = getJourney(userId, aId), b = getJourney(userId, bId);
    if (a.revision !== revisions?.[0] || b.revision !== revisions?.[1]) fail('来源行程已更新，请重新选择', 409);
    return [a, b];
}
async function previewMerge(userId, aId, bId, revisions, options = {}) {
    const [a, b] = sources(userId, aId, bId, revisions);
    const preview = await planMerge(a, b, options);
    sources(userId, aId, bId, revisions);
    normalizeDocument(preview.document, userId);
    return preview;
}
function previousMerge(userId, requestId, previewHash) {
    const previous = sql.prepare('SELECT journey_id,preview_hash FROM JourneyMergeRequest WHERE user_id=? AND request_id=?').get(userId, requestId);
    if (!previous) return null;
    if (previous.preview_hash !== previewHash) fail('同一合并请求不能用于不同预览，请重新打开预览', 409);
    if (!sql.prepare('SELECT id FROM Journey WHERE id=? AND user_id=?').get(previous.journey_id, userId)) fail('此合并请求的结果已被删除，请重新打开预览', 410);
    return getJourney(userId, previous.journey_id);
}
async function mergeJourneys(userId, aId, bId, revisions, options = {}) {
    const [a, b] = sources(userId, aId, bId, revisions);
    if (!options.preview_hash) fail('请先预览合并结果；来源或选择变化后需要重新预览', 409);
    const requestId = options.request_id || options.preview_hash;
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId || '')) fail('合并请求 ID 无效');
    const preview = await planMerge(a, b, options);
    // The network operation finishes before acquiring the SQLite write lock.
    return sql.transaction(() => {
        sources(userId, aId, bId, revisions);
        if (preview.conflicts.length) fail('请先处理合并预览中的冲突', 409);
        if (options.preview_hash !== preview.preview_hash) fail('请先预览合并结果；来源或选择变化后需要重新预览', 409);
        const replay = previousMerge(userId, requestId, preview.preview_hash);
        if (replay) return replay;
        const merged = saveJourney(userId, preview.document);
        merged.document.sources = preview.sources;
        const encoded = JSON.stringify(merged.document);
        sql.prepare('UPDATE Journey SET document=? WHERE id=?').run(encoded, merged.id);
        sql.prepare('UPDATE JourneyRevision SET document=? WHERE journey_id=? AND revision=1').run(encoded, merged.id);
        sql.prepare('INSERT INTO JourneyMergeRequest VALUES(?,?,?,?,?)').run(userId, requestId, preview.preview_hash, merged.id, merged.created_at);
        return merged;
    }).immediate();
}
module.exports = { planMerge, previewMerge, mergeJourneys };
