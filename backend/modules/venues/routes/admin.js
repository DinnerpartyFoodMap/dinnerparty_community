'use strict';

// 管理员待办：看待处理的场馆请求、关联到已有地点、或标记不需要。
// 权限与地点管理一致（manage_places）：能改地点的人才能决定场馆落到哪个点。
const express = require('express');
const router = express.Router();
const requireAdmin = require('../../admin/middleware/adminAuth');
const venueRequests = require('../services/venueRequests');

router.use(requireAdmin('manage_places'));

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const pending = venueRequests.pendingRequests();
        return res.json({ pending, count: pending.length });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '待办加载失败，请稍后重试' });
    }
});

// 关联到已有地点：body { place_id }
router.post('/:id/link', (req, res) => {
    const id = Number(req.params.id);
    const placeId = Number(req.body && req.body.place_id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '请求 id 无效' });
    if (!Number.isSafeInteger(placeId) || placeId <= 0) return res.status(400).json({ error: '缺少 place_id' });
    try {
        return res.json(venueRequests.link({ id, placeId, adminId: req.user.id }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.publicMessage || error.message, code: error.code });
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '关联失败，请稍后重试' });
    }
});

// 不需要建档：body { note? }
router.post('/:id/ignore', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '请求 id 无效' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : null;
    try {
        return res.json(venueRequests.ignore({ id, note, adminId: req.user.id }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.publicMessage || error.message, code: error.code });
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '操作失败，请稍后重试' });
    }
});

module.exports = router;
