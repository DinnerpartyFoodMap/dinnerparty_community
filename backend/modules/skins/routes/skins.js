const router = require('express').Router();
const { requireAuth } = require('../../accounts/middleware/auth');
const skins = require('../services/skinService');
const logger = require('../../../infrastructure/logger');
const { findPack, packFile, grantPack, readGrant, readAvatarGrant } = require('../services/resourcePacks');

function sendError(res, error, fallback) {
    if (error instanceof skins.SkinError) return res.status(error.status).json({ error: error.message, reason: error.reason });
    res.locals.unhandledError = error;
    return res.status(500).json({ error: fallback });
}

router.get(/^\/packs\/access\/([^/]+)\/(.+)$/, (req, res) => {
    const grant = readGrant(req.params[0]);
    if (!grant || !skins.ownsResource(grant.sub, grant.type, grant.id)) return res.status(403).json({ error: '下载授权已失效' });
    const pack = findPack(grant.type, grant.id);
    const file = pack?.version === grant.version ? packFile(pack, req.params[1]) : null;
    if (!file) return res.status(404).json({ error: '找不到资源文件' });
    const age = Math.max(0, grant.exp - Math.ceil(Date.now() / 1000));
    res.set('Cache-Control', `private, max-age=${age}`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.sendFile(file, { cacheControl: false });
});

router.get('/packs/avatar/:grant', (req, res) => {
    const grant = readAvatarGrant(req.params.grant);
    if (!grant) return res.status(403).json({ error: '下载授权已失效' });
    const age = Math.max(0, grant.exp - Math.ceil(Date.now() / 1000));
    res.set('Cache-Control', `private, max-age=${age}`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.sendFile(grant.file, { cacheControl: false });
});

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

router.post('/redeem-resource', (req, res) => {
    try {
        const { type, state, unlocked, alreadyOwned } = skins.redeemCode(req.user.id, req.body?.code, {
            allowCompanion: true, activate: req.body?.activate === true
        });
        return res.json({ type, state, unlocked, already_owned: alreadyOwned });
    } catch (error) {
        return sendError(res, error, '兑换失败，请稍后重试');
    }
});

router.get('/companions/me', (req, res) => {
    try { return res.json(skins.getUserCompanions(req.user.id)); }
    catch (error) { return sendError(res, error, '读取角色失败，请稍后重试'); }
});

router.put('/companions/active', (req, res) => {
    try { return res.json(skins.selectCompanion(req.user.id, req.body?.companion_id)); }
    catch (error) { return sendError(res, error, '切换角色失败，请稍后重试'); }
});

router.get('/packs/:type/:id', (req, res) => {
    try {
        const { type, id } = req.params;
        const pack = findPack(type, id);
        if (!pack) return res.status(404).json({ error: '找不到资源包' });
        if (!skins.ownsResource(req.user.id, type, id)) return res.status(403).json({ error: '请先解锁这个资源' });
        if (!packFile(pack, pack.entry)) return res.status(404).json({ error: '资源文件暂时不可用' });
        return res.json(grantPack(pack, req.user.id));
    } catch (error) {
        return sendError(res, error, '读取资源包失败，请稍后重试');
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
