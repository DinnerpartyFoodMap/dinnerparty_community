const express = require("express");
const router = express.Router();
const requireAdmin = require("../middleware/adminAuth");
const { insertAdminAction } = require("../services/adminAudit");
const { getQQBot, getQQBotStatus } = require("../../qqbot/runtime/index");
const { retryNotification, markNotificationSent } = require("../../qqbot/runtime/notificationWorker");
const { wakeNotificationWorker } = require("../../places/services/placeNotifications");
const randomCenter = require("../../qqbot/runtime/randomCenter");
const botConfig = require("../../qqbot/runtime/config");

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

// Per-group !随机 centres: the same rows the group's owner/admins set with !随机中心.
router.get("/random-centers", requireAdmin("manage_invites"), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { center, centerName } = botConfig.get().random;
    res.json({ centers: randomCenter.listGroupCenters(), defaultCenter: { ...center, label: centerName } });
});

router.put("/random-centers/:groupId", requireAdmin("manage_invites"), (req, res) => {
    const groupId = String(req.params.groupId || '');
    if (!botConfig.QQ_PATTERN.test(groupId)) return res.status(400).json({ error: '群号无效' });
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label || label.length > randomCenter.LABEL_MAX_LENGTH) return res.status(400).json({ error: `请填写中心名称（最多 ${randomCenter.LABEL_MAX_LENGTH} 字）` });
    const saved = randomCenter.setGroupCenter(groupId, { lat: req.body?.latitude, lng: req.body?.longitude, label, source: 'admin' }, `admin:${req.user.id}`);
    if (!saved) return res.status(400).json({ error: '中心坐标无效（GCJ-02 纬度、经度）' });
    insertAdminAction(req.user.id, 'qq-bot-random-center', null, JSON.stringify({ group_id: groupId, label: saved.label, latitude: saved.lat, longitude: saved.lng }));
    return res.json({ center: saved });
});

router.delete("/random-centers/:groupId", requireAdmin("manage_invites"), (req, res) => {
    const groupId = String(req.params.groupId || '');
    if (!botConfig.QQ_PATTERN.test(groupId)) return res.status(400).json({ error: '群号无效' });
    const cleared = randomCenter.clearGroupCenter(groupId);
    if (cleared) insertAdminAction(req.user.id, 'qq-bot-random-center-clear', null, JSON.stringify({ group_id: groupId }));
    return res.json({ cleared });
});

module.exports = router;
