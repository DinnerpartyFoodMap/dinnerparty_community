const express = require("express");
const router = express.Router();
const { db } = require("../../../infrastructure/database");
const requireAdmin = require("../middleware/adminAuth");
const { hasPermission } = require('../services/adminPermissions');
const { insertAdminAction } = require("../services/adminAudit");
const { WHITELIST_QQ_PATTERN } = require('../../accounts/services/qqWhitelist');

const ALLOWED_LEVELS = new Set(["YUYUKO", "YOUMU", "KOMACHI", ""]);
const SUPER_LEVEL = "YUYUKO";

function adminMutationFailure(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.publicMessage = message;
    return error;
}

function sendMutationError(res, error) {
    if (error && error.publicMessage) {
        return res.status(error.status || 400).json({ error: error.publicMessage, code: error.code });
    }
    res.locals.unhandledError = error;
    return res.status(500).json({ error: '管理员操作失败，请稍后重试' });
}

const setLevelTransaction = db._raw.transaction(({ actingAdminId, userId, newLevel }) => {
    const target = db._raw.prepare('SELECT id, admin_level FROM User WHERE id = ?').get(userId);
    if (!target) throw adminMutationFailure(404, 'USER_NOT_FOUND', '用户不存在');
    const currentLevel = target.admin_level || '';
    if (currentLevel === SUPER_LEVEL && newLevel !== SUPER_LEVEL) {
        const count = db._raw.prepare('SELECT COUNT(*) AS cnt FROM User WHERE admin_level = ?').get(SUPER_LEVEL).cnt;
        if (count <= 1) throw adminMutationFailure(403, 'LAST_SUPER_ADMIN', '不可降级最后一位 Y 级管理员');
    }
    db._raw.prepare('UPDATE User SET admin_level = ? WHERE id = ?')
        .run(newLevel || null, userId);
    insertAdminAction(
        actingAdminId,
        'set-level',
        userId,
        JSON.stringify({ from: currentLevel || null, to: newLevel || null })
    );
});

const banStateTransaction = db._raw.transaction(({ actingAdminId, userId, mode, reason, banExpires, canManageAdmins }) => {
    const target = db._raw.prepare('SELECT id, admin_level, is_banned FROM User WHERE id = ?').get(userId);
    if (!target) throw adminMutationFailure(404, 'USER_NOT_FOUND', '用户不存在');
    if (target.admin_level && !canManageAdmins) {
        throw adminMutationFailure(403, 'ADMIN_TARGET_FORBIDDEN', '只能封禁或解封普通用户');
    }
    if (mode === 'ban' && target.is_banned) throw adminMutationFailure(400, 'USER_ALREADY_BANNED', '用户已被封禁');
    if (mode === 'unban' && !target.is_banned) throw adminMutationFailure(400, 'USER_NOT_BANNED', '用户未被封禁');

    if (mode === 'ban') {
        db._raw.prepare('UPDATE User SET is_banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?')
            .run(reason || null, banExpires, userId);
        insertAdminAction(
            actingAdminId,
            'ban-user',
            userId,
            JSON.stringify({ reason: reason || null, ban_expires: banExpires })
        );
    } else {
        db._raw.prepare('UPDATE User SET is_banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?')
            .run(userId);
        insertAdminAction(actingAdminId, 'unban-user', userId, null);
    }
});

// 改绑 QQ 号：qq 为空表示解绑。一个 QQ 号只能绑定一个账号（User.qq 唯一索引），不要求在白名单中。
const setQqTransaction = db._raw.transaction(({ actingAdminId, userId, qq }) => {
    const target = db._raw.prepare('SELECT id, qq FROM User WHERE id = ?').get(userId);
    if (!target) throw adminMutationFailure(404, 'USER_NOT_FOUND', '用户不存在');
    const current = target.qq || null;
    if (current === qq) return;
    if (qq && db._raw.prepare('SELECT id FROM User WHERE qq = ? AND id <> ?').get(qq, userId)) {
        throw adminMutationFailure(409, 'QQ_IN_USE', '该 QQ 号已绑定其他账号');
    }
    db._raw.prepare('UPDATE User SET qq = ? WHERE id = ?').run(qq, userId);
    insertAdminAction(actingAdminId, 'set-qq', userId, JSON.stringify({ from: current, to: qq }));
});

const deleteUserTransaction = db._raw.transaction(({ actingAdminId, targetId }) => {
    const target = db._raw.prepare('SELECT id, admin_level FROM User WHERE id = ?').get(targetId);
    if (!target) throw adminMutationFailure(404, 'USER_NOT_FOUND', '用户不存在');
    if ((target.admin_level || '') === SUPER_LEVEL) {
        const count = db._raw.prepare('SELECT COUNT(*) AS cnt FROM User WHERE admin_level = ?').get(SUPER_LEVEL).cnt;
        if (count <= 1) throw adminMutationFailure(403, 'LAST_SUPER_ADMIN', '不可删除最后一位 Y 级管理员');
    }
    db._raw.prepare('DELETE FROM User WHERE id = ?').run(targetId);
    // Preserve the deleted UUID in the immutable audit row for traceability.
    insertAdminAction(actingAdminId, 'delete-user', targetId, null);
});

// 获取所有用户（仅Y级管理员）
router.get("/", requireAdmin("manage_users"), (req, res) => {
    db.all("SELECT id, username, avatar, admin_level, is_banned, ban_reason, ban_expires, qq, (avatar_blob IS NOT NULL) AS has_avatar FROM User", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        rows.forEach(r => r.has_avatar = !!r.has_avatar);
        res.json(rows);
    });
});

// 修改用户权限等级（仅Y级管理员）
router.post("/set-level", requireAdmin("manage_users"), (req, res) => {
    const { userId, admin_level } = req.body;
    const actingAdminId = req.user && req.user.id;

    if (!userId || typeof admin_level !== "string")
        return res.status(400).json({ error: "缺少参数" });

    // 验证 admin_level 是否有效
    if (!ALLOWED_LEVELS.has(admin_level)) {
        return res.status(400).json({ error: "无效的 admin_level 值" });
    }

    // 不能修改自身权限
    if (String(userId) === String(actingAdminId)) {
        return res.status(403).json({ error: "不可操作自身管理员权限" });
    }

    try {
        setLevelTransaction.immediate({ actingAdminId, userId, newLevel: admin_level || '' });
        return res.json({ success: true });
    } catch (error) {
        return sendMutationError(res, error);
    }
});

// YOUMU 仅可封禁普通用户，YUYUKO 保留原有目标范围。
router.post('/ban', requireAdmin('manage_bans'), (req, res) => {
    const { userId, reason, durationDays } = req.body;
    const actingAdminId = req.user && req.user.id;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    if (String(userId) === String(actingAdminId)) return res.status(403).json({ error: '不可封禁自身账号' });

    let banExpires = null;
    if (typeof durationDays === 'number' && durationDays > 0) {
        const dt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
        banExpires = dt.toISOString();
    }
    try {
        banStateTransaction.immediate({ actingAdminId, userId, mode: 'ban', reason, banExpires,
            canManageAdmins: hasPermission(req.user, 'manage_users') });
        return res.json({ success: true });
    } catch (error) {
        return sendMutationError(res, error);
    }
});

// 解封沿用与封禁相同的权限和目标范围。
router.post('/unban', requireAdmin('manage_bans'), (req, res) => {
    const { userId } = req.body;
    const actingAdminId = req.user && req.user.id;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });

    try {
        banStateTransaction.immediate({ actingAdminId, userId, mode: 'unban', reason: null, banExpires: null,
            canManageAdmins: hasPermission(req.user, 'manage_users') });
        return res.json({ success: true });
    } catch (error) {
        return sendMutationError(res, error);
    }
});

// 修改住民绑定的 QQ 号（仅Y级管理员）：{ userId, qq }，qq 为空字符串表示解绑
router.post('/set-qq', requireAdmin('manage_users'), (req, res) => {
    const { userId } = req.body || {};
    const qq = typeof req.body?.qq === 'string' ? req.body.qq.trim() : null;
    if (!userId || qq === null) return res.status(400).json({ error: '缺少参数' });
    if (qq && !WHITELIST_QQ_PATTERN.test(qq)) return res.status(400).json({ error: 'QQ 号格式不正确' });
    try {
        setQqTransaction.immediate({ actingAdminId: req.user && req.user.id, userId, qq: qq || null });
        return res.json({ success: true, qq: qq || null });
    } catch (error) {
        return sendMutationError(res, error);
    }
});

// 删除用户（仅 Y 级管理员）
router.delete("/:id", requireAdmin("manage_users"), (req, res) => {
    const targetId = req.params.id;
    const actingAdminId = req.user && req.user.id;

    if (String(targetId) === String(actingAdminId)) {
        return res.status(403).json({ error: "不可删除自身账号" });
    }

    try {
        deleteUserTransaction.immediate({ actingAdminId, targetId });
        return res.json({ success: true });
    } catch (error) {
        return sendMutationError(res, error);
    }
});

module.exports = router;
