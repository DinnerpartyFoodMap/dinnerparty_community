const express = require("express");
const router = express.Router();
const requireAdmin = require("../middleware/adminAuth");
const { insertAdminAction } = require("../services/adminAudit");
const { getQQBot, getQQBotStatus } = require("../../qqbot/runtime/index");
const { retryNotification, markNotificationSent } = require("../../qqbot/runtime/notificationWorker");
const { wakeNotificationWorker } = require("../../places/services/placeNotifications");

// QQ Bot operations: connection, whitelist sync results (incl. dry-run diff),
// and new-place notifications. Failed and unknown deliveries are listed separately.
router.get("/status", requireAdmin("manage_invites"), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getQQBotStatus());
});

router.post("/sync", requireAdmin("manage_invites"), async (req, res) => {
    const bot = getQQBot();
    if (!bot || !bot.client.connected) return res.status(503).json({ error: 'QQ Bot 未连接' });
    try {
        const results = await bot.memberSync.syncAll('admin');
        insertAdminAction(req.user.id, 'qq-bot-sync', null, JSON.stringify({ groups: results.map((r) => ({ group_id: r.groupId, status: r.status, added: r.addedCount })) }));
        return res.json({ results });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '同步失败，请稍后重试' });
    }
});

router.post("/notifications/:id/retry", requireAdmin("manage_invites"), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: '通知编号无效' });
    if (!retryNotification(id)) return res.status(404).json({ error: '只有失败或结果未知的通知可以重试' });
    insertAdminAction(req.user.id, 'qq-bot-notification-retry', null, JSON.stringify({ notification_id: id }));
    wakeNotificationWorker();
    return res.json({ success: true });
});

router.post("/notifications/:id/mark-sent", requireAdmin("manage_invites"), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: '通知编号无效' });
    if (!markNotificationSent(id)) return res.status(404).json({ error: '只有失败或结果未知的通知可以标记' });
    insertAdminAction(req.user.id, 'qq-bot-notification-mark-sent', null, JSON.stringify({ notification_id: id }));
    return res.json({ success: true });
});

module.exports = router;
