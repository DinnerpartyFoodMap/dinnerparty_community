const { db } = require('../../../infrastructure/database');

// 住民之间的关系。屏蔽（UserBlock）只影响屏蔽者自己看到的内容：Ta 创建的地点（附近、全部地点、快速搜索）、
// 地点下 Ta 的公开日记、同好里 Ta 的名片；Ta 的地点列表还能打开，但不列出地点，只用来解除屏蔽。

/** SQL 条件：column 指向的住民没有被观看者屏蔽；参数是观看者 id（游客传 null，条件恒为真） */
function notBlockedSql(column) {
    return `NOT EXISTS (SELECT 1 FROM UserBlock ub WHERE ub.user_id = ? AND ub.blocked_id = ${column})`;
}

function isBlocked(viewerId, userId, database = db._raw) {
    if (!viewerId || !userId) return false;
    return !!database.prepare('SELECT 1 FROM UserBlock WHERE user_id = ? AND blocked_id = ?').get(String(viewerId), String(userId));
}

/**
 * 观看者与另一位住民的关系，随住民的地点列表（GET /users/:id/places）和屏蔽接口返回。
 * self：就是自己；blocked：观看者屏蔽了 Ta；can_block：已登录且不是自己，可以屏蔽 / 解除屏蔽。
 */
function viewerRelation(viewer, userId) {
    const self = !!viewer && String(viewer.id) === String(userId);
    return { self, blocked: !!viewer && !self && isBlocked(viewer.id, userId), can_block: !!viewer && !self };
}

function setBlocked(userId, blockedId, blocked, database = db._raw) {
    if (blocked) database.prepare('INSERT OR IGNORE INTO UserBlock (user_id, blocked_id) VALUES (?, ?)').run(String(userId), String(blockedId));
    else database.prepare('DELETE FROM UserBlock WHERE user_id = ? AND blocked_id = ?').run(String(userId), String(blockedId));
}

module.exports = { notBlockedSql, isBlocked, viewerRelation, setBlocked };
