'use strict';

// 管理员视角：看待处理的场馆（pending）、在地图上落点、或标记不需要。
// 权限与地点管理一致（manage_places）：能改地点的人才决定场馆落在哪。
// 路由用 /admin/venues，不叫 requests —— 待办只是 pending 状态，不是另一种资源。
const express = require('express');
const router = express.Router();
const requireAdmin = require('../../admin/middleware/adminAuth');
const venues = require('../services/venues');

router.use(requireAdmin('manage_places'));

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const pending = venues.pendingVenues();
        return res.json({ pending, count: pending.length });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '待办加载失败，请稍后重试' });
    }
});

// 落点：body { latitude, longitude }（GCJ-02，管理员在地图上选的）
router.post('/:id/place', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '场馆 id 无效' });
    const { latitude, longitude } = req.body || {};
    try {
        return res.json(venues.place({ id, latitude, longitude, adminId: req.user.id }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.publicMessage || error.message, code: error.code });
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '保存位置失败，请稍后重试' });
    }
});

// 不需要落点：body { note? }
router.post('/:id/ignore', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '场馆 id 无效' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : null;
    try {
        return res.json(venues.ignore({ id, note, adminId: req.user.id }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.publicMessage || error.message, code: error.code });
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '操作失败，请稍后重试' });
    }
});

module.exports = router;
