const router = require('express').Router();
const { requireAuth } = require('../../accounts/middleware/auth');
const skins = require('../services/skinService');
const logger = require('../../../infrastructure/logger');

function sendError(res, error, fallback) {
    if (error instanceof skins.SkinError) return res.status(error.status).json({ error: error.message, reason: error.reason });
    res.locals.unhandledError = error;
    return res.status(500).json({ error: fallback });
}

router.use(requireAuth);
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// 当前使用的皮肤与已解锁的皮肤
router.get('/me', (req, res) => {
    try {
        return res.json(skins.getSkinState(req.user.id));
    } catch (error) {
        return sendError(res, error, '读取皮肤失败，请稍后重试');
    }
});

// 输入兑换码解锁皮肤（默认立即换上；activate: false 只解锁）
router.post('/redeem', (req, res) => {
    try {
        const result = skins.redeemCode(req.user.id, req.body && req.body.code, { activate: !(req.body && req.body.activate === false) });
        logger.info('Skin code redeemed', {
            event: 'skins.code.redeemed',
            skinId: result.skin.id,
            codeId: result.codeId,
            alreadyOwned: result.alreadyOwned
        });
        return res.json({ ...result.state, unlocked: result.skin, already_owned: result.alreadyOwned });
    } catch (error) {
        if (error instanceof skins.SkinError) {
            logger.warn('Skin code rejected', { event: 'skins.code.rejected', reason: error.reason });
        }
        return sendError(res, error, '兑换失败，请稍后重试');
    }
});

// 切换正在使用的皮肤：'default' 或已解锁的皮肤
router.put('/active', (req, res) => {
    try {
        return res.json(skins.setActiveSkin(req.user.id, req.body && req.body.skin_id));
    } catch (error) {
        return sendError(res, error, '切换皮肤失败，请稍后重试');
    }
});

module.exports = router;
