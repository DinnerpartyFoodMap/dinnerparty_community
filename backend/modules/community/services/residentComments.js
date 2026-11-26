const { createHash } = require('node:crypto');
const { db } = require('../../../infrastructure/database');
const logger = require('../../../infrastructure/logger');
const { requireWritableUser } = require('../../accounts/services/userAccess');
const { notBlockedSql } = require('../../accounts/services/userRelations');
const { hasPermission } = require('../../admin/services/adminPermissions');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { checkComment, readConfig } = require('../../places/services/placeModeration');
const { queueComment } = require('../../ratings/services/ratingTextEvidence');

const MAX_PER_DAY = 20;
const sql = db._raw;
const openReview = `request_type = 'comment' AND status = 'pending' AND json_extract(proposed, '$.comment_id') = ?`;

function fail(status, code, publicMessage) {
    throw Object.assign(new Error(publicMessage), { status, code, publicMessage });
}

function normalizeContent(content) {
    if (typeof content !== 'string') fail(400, 'COMMENT_INVALID', '评论内容格式无效');
    const normalized = content.replace(/[\s\p{White_Space}]+/gu, ' ').trim();
    if (Array.from(normalized.replaceAll(' ', '')).length < 2) fail(400, 'COMMENT_TOO_SHORT', '评论至少需要 2 个字');
    if (Array.from(normalized).length > 200) fail(400, 'COMMENT_TOO_LONG', '评论不能超过 200 个字');
    return normalized;
}

function withdrawReview(commentId) {
    sql.prepare(`UPDATE PlaceRequest SET status = 'withdrawn', reviewed_time = CURRENT_TIMESTAMP WHERE ${openReview}`).run(commentId);
}

function openOrUpdateReview(comment, report, note) {
    const proposed = JSON.stringify({ comment_id: comment.id, content: comment.content });
    const updated = sql.prepare(`UPDATE PlaceRequest SET proposed = ?, note = ?, moderation = ? WHERE ${openReview}`)
        .run(proposed, note, report, comment.id);
    if (!updated.changes) {
        sql.prepare(`INSERT INTO PlaceRequest (place_id, requester_id, proposed, note, request_type, moderation)
            VALUES (?, ?, ?, ?, 'comment', ?)`).run(comment.place_id, comment.user_id, proposed, note, report);
    }
}

function queueVisibleEvidence(comment) {
    queueComment({ commentId: comment.id, userId: comment.user_id, placeId: comment.place_id,
        text: comment.content, ratingRevision: comment.rating_revision });
}

function nextStatus(previous, user, config) {
    if (previous?.moderation_status === 'rejected') return 'pending';
    if (previous?.moderation_status === 'pending') {
        return config.enabled && (previous.checks ?? 0) < config.maxChecks ? 'checking' : 'pending';
    }
    return !config.enabled || hasPermission(user, 'manage_places') ? 'visible' : 'checking';
}

const submitTransaction = sql.transaction((userId, placeId, input, now) => {
    const user = requireWritableUser(userId);
    const place = sql.prepare(`SELECT p.id FROM Place p WHERE p.id = ? AND p.moderation_status = 'visible'
        AND ${notBlockedSql('p.creator_id')}`).get(placeId, userId);
    if (!place) fail(404, 'COMMENT_PLACE_NOT_FOUND', '地点不存在');
    const content = normalizeContent(input);
    const rating = sql.prepare(`SELECT r.score, s.revision FROM PlaceRating r LEFT JOIN RatingStream s
        ON s.user_id = r.user_id AND s.place_id = r.place_id WHERE r.place_id = ? AND r.user_id = ?`).get(place.id, userId);
    if (!rating) fail(400, 'COMMENT_RATING_REQUIRED', '请先为这家店评分');

    const previous = sql.prepare(`SELECT c.*, m.checks, m.report FROM Comment c
        LEFT JOIN CommentModeration m ON m.comment_id = c.id
        WHERE c.place_id = ? AND c.user_id = ? AND c.source = 'resident'`).get(place.id, userId);
    if (previous?.content === content) return { row: previous, changed: false };

    const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const usage = sql.prepare(`INSERT INTO ResidentCommentQuota (user_id, local_day, writes) VALUES (?, ?, 1)
        ON CONFLICT(user_id) DO UPDATE SET local_day = excluded.local_day,
            writes = CASE WHEN local_day = excluded.local_day THEN writes + 1 ELSE 1 END
        WHERE local_day <> excluded.local_day OR writes < ?`).run(userId, day, MAX_PER_DAY);
    if (!usage.changes) fail(429, 'COMMENT_QUOTA', '每天最多发表或修改评论 20 次');

    const status = nextStatus(previous, user, readConfig());
    // Distinguish edits within the same millisecond, including A → B → A during an AI call.
    const updatedAt = new Date(Math.max(now, (Date.parse(previous?.updated_at) || 0) + 1)).toISOString();
    const row = previous
        ? sql.prepare(`UPDATE Comment SET content = ?, rating = ?, rating_revision = ?, moderation_status = ?, updated_at = ?
            WHERE id = ? RETURNING *`).get(content, rating.score, rating.revision, status, updatedAt, previous.id)
        : sql.prepare(`INSERT INTO Comment (place_id, user_id, content, rating, rating_revision, source, moderation_status, time, updated_at)
            VALUES (?, ?, ?, ?, ?, 'resident', ?, ?, ?) RETURNING *`)
            .get(place.id, userId, content, rating.score, rating.revision, status, updatedAt, updatedAt);

    if (status === 'pending') {
        if (previous.moderation_status === 'rejected') withdrawReview(row.id);
        openOrUpdateReview(row, previous.report ?? null, '评论已修改，等待人工复核');
    } else {
        withdrawReview(row.id);
        if (status === 'visible') queueVisibleEvidence(row);
    }
    return { row, changed: true };
});

function submitComment(userId, body, now = Date.now()) {
    const rawId = body?.place_id;
    const placeId = typeof rawId === 'number' || (typeof rawId === 'string' && /^\d+$/.test(rawId)) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(placeId) || placeId < 1) fail(404, 'COMMENT_PLACE_NOT_FOUND', '地点不存在');
    const { row, changed } = submitTransaction.immediate(userId, placeId, body.content, now);
    if (changed && row.moderation_status === 'checking') scheduleCommentModeration([row.id]);
    return { id: row.id, place_id: row.place_id, content: row.content, status: row.moderation_status,
        time: row.time, updated_at: row.updated_at };
}

function deleteOwnComment(id, userId) {
    const result = sql.prepare("DELETE FROM Comment WHERE id = ? AND user_id = ? AND source = 'resident'").run(id, userId);
    if (!result.changes) fail(404, 'COMMENT_NOT_FOUND', '评论不存在');
}

function commentsForPlace(placeId, viewerId = null) {
    const fields = 'c.id, c.user_id, u.username, c.content, c.moderation_status AS status, c.time, c.updated_at';
    const fromPlace = `FROM Comment c JOIN User u ON u.id = c.user_id WHERE c.place_id = ? AND c.source = 'resident'`;
    return sql.prepare(`WITH latest AS (
        SELECT ${fields}, 0 AS mine ${fromPlace} AND c.user_id IS NOT ? AND c.moderation_status = 'visible'
            AND COALESCE(u.is_banned, 0) = 0 AND ${notBlockedSql('c.user_id')}
            ORDER BY c.time DESC, c.id DESC LIMIT 50
        )
        SELECT * FROM latest
        UNION ALL
        SELECT ${fields}, 1 AS mine ${fromPlace} AND c.user_id = ?
        ORDER BY time, id`).all(placeId, viewerId, viewerId, placeId, viewerId).map(row => ({ ...row, mine: Boolean(row.mine) }));
}

function commentForReview(request, commentId) {
    if (!Number.isSafeInteger(commentId)) return null;
    return sql.prepare(`SELECT c.id, c.content, c.moderation_status AS status, u.username, p.name AS place_name
        FROM Comment c JOIN User u ON u.id = c.user_id JOIN Place p ON p.id = c.place_id
        WHERE c.id = ? AND c.place_id = ? AND c.user_id = ? AND c.source = 'resident'`)
        .get(commentId, request.place_id, request.requester_id) ?? null;
}

function applyCommentReview(request, proposed, action, adminId) {
    const comment = commentForReview(request, proposed?.comment_id);
    if (!comment || comment.content !== proposed.content || request.status === 'withdrawn') {
        fail(409, 'COMMENT_REVIEW_STALE', '评论已修改或删除，请刷新审核列表');
    }
    if (request.status !== 'pending') fail(409, 'PLACE_REQUEST_ALREADY_REVIEWED', '此申请已被处理');
    if (comment.status !== 'pending') fail(409, 'COMMENT_REVIEW_STALE', '评论已修改或删除，请刷新审核列表');

    const approve = action === 'approve';
    const saved = sql.prepare('UPDATE Comment SET moderation_status = ? WHERE id = ? RETURNING *')
        .get(approve ? 'visible' : 'rejected', comment.id);
    sql.prepare('UPDATE PlaceRequest SET status = ?, reviewed_by = ?, reviewed_time = CURRENT_TIMESTAMP WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', adminId, request.id);
    insertAdminAction(adminId, 'place-request-review', request.requester_id,
        JSON.stringify({ request_id: request.id, comment_id: comment.id, action }));
    if (approve) queueVisibleEvidence(saved);
    return { action, placeId: request.place_id, semanticChanged: false };
}

function commentHash(content) {
    return createHash('sha256').update(content).digest('hex');
}

const applyModeration = sql.transaction((id, hash, updatedAt, report) => {
    const comment = sql.prepare("SELECT * FROM Comment WHERE id = ? AND source = 'resident' AND moderation_status = 'checking'").get(id);
    if (!comment) return 'stale';

    const usedAi = Number(['ok', 'error'].includes(report.text.status));
    if (commentHash(comment.content) !== hash || comment.updated_at !== updatedAt) {
        if (usedAi) sql.prepare(`INSERT INTO CommentModeration (comment_id, checks) VALUES (?, 1)
            ON CONFLICT(comment_id) DO UPDATE SET checks = checks + 1`).run(id);
        return 'changed';
    }

    const serialized = JSON.stringify(report);
    sql.prepare(`INSERT INTO CommentModeration (comment_id, checks, content_hash, report) VALUES (?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET checks = checks + excluded.checks,
            content_hash = excluded.content_hash, report = excluded.report`).run(id, usedAi, hash, serialized);
    const status = report.decision.flagged ? 'pending' : 'visible';
    sql.prepare('UPDATE Comment SET moderation_status = ? WHERE id = ?').run(status, id);
    if (status === 'pending') openOrUpdateReview(comment, serialized, '评论未通过 AI 初筛');
    else {
        withdrawReview(id);
        queueVisibleEvidence(comment);
    }
    return status;
});

const queued = new Set();
let draining = null;

function scheduleCommentModeration(ids) {
    for (const id of ids) queued.add(id);
    if (!draining && queued.size) draining = new Promise(resolve => setImmediate(resolve)).then(drain);
    return draining;
}

async function drain() {
    try {
        for (const id of queued) {
            queued.delete(id);
            try {
                const row = sql.prepare(`SELECT c.content, c.updated_at, p.name, p.category FROM Comment c
                    JOIN Place p ON p.id = c.place_id WHERE c.id = ? AND c.source = 'resident' AND c.moderation_status = 'checking'`).get(id);
                if (!row) continue;
                const hash = commentHash(row.content);
                const report = await checkComment(row, row.content, readConfig());
                if (applyModeration.immediate(id, hash, row.updated_at, report) === 'changed') queued.add(id);
            } catch (error) {
                logger.error('Comment moderation failed', { event: 'comment.moderation.failed', commentId: id, error });
            }
        }
    } finally {
        draining = null;
    }
}

function resumeCommentModeration() {
    const rows = sql.prepare("SELECT id FROM Comment WHERE source = 'resident' AND moderation_status = 'checking' ORDER BY id").all();
    scheduleCommentModeration(rows.map(row => row.id));
    return rows.length;
}

async function waitForCommentModerationIdle() {
    while (draining) await draining;
}

module.exports = { submitComment, deleteOwnComment, commentsForPlace, commentForReview, applyCommentReview,
    resumeCommentModeration, waitForCommentModerationIdle };
