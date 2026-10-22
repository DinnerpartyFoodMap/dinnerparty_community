const router = require('express').Router();
const { db } = require('../../../infrastructure/database');
const requireAdmin = require('../middleware/adminAuth');
const { insertAdminAction } = require('../services/adminAudit');
const feedback = require('../../feedback/services/feedbackService');

router.use(requireAdmin('manage_feedback'));
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.get('/', (req, res) => {
    try {
        return res.json(feedback.listFeedback({ status: req.query.status, type: req.query.type, page: req.query.page, pageSize: req.query.pageSize }));
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '读取反馈失败，请稍后重试' });
    }
});

// 截图只给管理员看：前端带凭证读取后转成本地地址显示
router.get('/images/:imageId', (req, res) => {
    const row = feedback.getImage(req.params.imageId);
    if (!row) return res.status(404).json({ error: '图片不存在' });
    res.set('Cache-Control', 'private, no-store');
    return res.type('webp').send(row.data);
});

const setStatus = db._raw.transaction(({ item, status, adminId }) => {
    db._raw.prepare(`UPDATE UserFeedback SET status = ?, handled_by = ?, handled_time = ${status === 'resolved' ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`)
        .run(status, status === 'resolved' ? adminId : null, item.id);
    insertAdminAction(adminId, status === 'resolved' ? 'resolve-feedback' : 'reopen-feedback', item.user_id, JSON.stringify({ feedback_id: item.id, type: item.type }));
});
const remove = db._raw.transaction(({ item, adminId }) => {
    db._raw.prepare('DELETE FROM UserFeedback WHERE id = ?').run(item.id);
    insertAdminAction(adminId, 'delete-feedback', item.user_id, JSON.stringify({ feedback_id: item.id, type: item.type }));
});

router.put('/:id/status', (req, res) => {
    const status = req.body && req.body.status;
    if (!feedback.FEEDBACK_STATUSES.includes(status)) return res.status(400).json({ error: '状态无效' });
    const item = feedback.getFeedback(req.params.id);
    if (!item) return res.status(404).json({ error: '反馈不存在' });
    try {
        setStatus.immediate({ item, status, adminId: req.user.id });
        return res.json({ success: true, status });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '更新反馈状态失败，请稍后重试' });
    }
});

router.delete('/:id', (req, res) => {
    const item = feedback.getFeedback(req.params.id);
    if (!item) return res.status(404).json({ error: '反馈不存在' });
    try {
        remove.immediate({ item, adminId: req.user.id });
        return res.json({ success: true });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '删除反馈失败，请稍后重试' });
    }
});

module.exports = router;
