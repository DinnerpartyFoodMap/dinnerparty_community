const router = require('express').Router();
const requireAdmin = require('../middleware/adminAuth');
const skins = require('../../skins/services/skinService');

// 皮肤兑换码沿用旧邀请码的权限 manage_invites（YUYUKO、YOUMU）
router.use(requireAdmin('manage_invites'));

function sendError(res, error, fallback) {
    if (error instanceof skins.SkinError) return res.status(error.status).json({ error: error.message, reason: error.reason });
    res.locals.unhandledError = error;
    return res.status(500).json({ error: fallback });
}

router.get('/', (req, res) => {
    try {
        return res.json({ catalog: skins.listCatalog(), codes: skins.listCodes({ skinId: req.query.skin_id || null }) });
    } catch (error) {
        return sendError(res, error, '读取兑换码失败');
    }
});

// 批量生成：{ skin_id, count, max_uses, expires_days?, note? }
router.post('/', (req, res) => {
    try {
        return res.json({ success: true, codes: skins.createCodes(req.user.id, req.body || {}) });
    } catch (error) {
        return sendError(res, error, '生成兑换码失败，请稍后重试');
    }
});

router.delete('/:id', (req, res) => {
    try {
        return res.json({ success: true, code: skins.revokeCode(req.user.id, req.params.id) });
    } catch (error) {
        return sendError(res, error, '作废兑换码失败，请稍后重试');
    }
});

module.exports = router;
