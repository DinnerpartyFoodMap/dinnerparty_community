const router = require('express').Router();
const { db } = require('../../../infrastructure/database');
const requireAdmin = require('../middleware/adminAuth');
const { insertAdminAction } = require('../services/adminAudit');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const taste = require('../../preferences/services/tasteAxes');

// 六类餐饮偏好的店铺分类人工纠正（preferences/doc/TASTE_AXES.md）：列出规则判断不了的店（模型结果或未知），
// 管理员勾选所属的类；人工结果优先于规则和模型，可撤销
router.use(requireAdmin('manage_places'));
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const PAGE_SIZE = 30;

// filter：unknown（规则、模型都没分出来）/ llm（模型分的，待人工确认）/ manual（已人工纠正）
router.get('/places', (req, res) => {
    try {
        const filter = ['unknown', 'llm', 'manual'].includes(req.query.filter) ? req.query.filter : 'unknown';
        const query = String(req.query.q || '').trim().slice(0, 40);
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const stored = taste.storedClasses();
        const rows = db._raw.prepare(`SELECT id, name, category, description FROM Place p WHERE ${publicPlaceSql('p')}
            ${query ? 'AND (p.name LIKE ? OR p.category LIKE ?)' : ''} ORDER BY p.id DESC`)
            .all(...(query ? [`%${query}%`, `%${query}%`] : []));
        const matched = [];
        for (const row of rows) {
            const resolved = taste.resolvePlaceAxes(row, stored.get(row.id));
            if (resolved.source === filter) matched.push({ place_id: row.id, name: row.name, category: row.category || '', ...resolved });
        }
        res.json({ axes: taste.TASTE_AXES, total: matched.length, page, page_size: PAGE_SIZE, items: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) });
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '读取店铺分类失败，请稍后重试' });
    }
});

// body.axes：数组为人工分类（[] = 不属于任何一类），null 为撤销人工分类
router.put('/places/:id', (req, res) => {
    const axes = req.body ? req.body.axes : undefined;
    if (axes !== null && !Array.isArray(axes)) return res.status(400).json({ error: '分类无效' });
    if (Array.isArray(axes) && axes.some((axis) => !taste.TASTE_AXES.includes(axis))) return res.status(400).json({ error: '分类无效' });
    try {
        const place = db._raw.prepare('SELECT id, creator_id FROM Place WHERE id = ?').get(req.params.id);
        if (!place) return res.status(404).json({ error: '地点不存在' });
        const result = taste.setManualPlaceAxes(place.id, axes);
        insertAdminAction(req.user.id, axes === null ? 'reset-taste-axes' : 'set-taste-axes', null, JSON.stringify({ place_id: place.id, axes }));
        res.json(result);
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '保存店铺分类失败，请稍后重试' });
    }
});

module.exports = router;
