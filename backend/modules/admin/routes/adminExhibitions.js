const router = require('express').Router();
const { db } = require('../../../infrastructure/database');
const requireAdmin = require('../middleware/adminAuth');
const { insertAdminAction } = require('../services/adminAudit');

router.use(requireAdmin('manage_announcements'));
router.use(require('../../community/routes/exhibitions'));

const publish = db._raw.transaction(({ id, name, description, information, icon_url, location_name, latitude, longitude, event_time, adminId }) => {
    const values = [name, description, information, icon_url, location_name, latitude, longitude, event_time];
    const editing = id != null;
    if (editing) {
        const result = db._raw.prepare(`UPDATE SiteExhibition SET name = ?, description = ?, information = ?, icon_url = ?,
            location_name = ?, latitude = ?, longitude = ?, event_time = ? WHERE id = ? AND is_active = 1`).run(...values, id);
        if (!result.changes) return null;
    } else {
        const result = db._raw.prepare(`INSERT INTO SiteExhibition (name, description, information, icon_url, location_name, latitude, longitude, event_time, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, adminId);
        id = Number(result.lastInsertRowid);
    }
    insertAdminAction(adminId, editing ? 'edit-exhibition' : 'publish-exhibition', null, JSON.stringify({ exhibition_id: id, name }));
    return id;
});
const unpublish = db._raw.transaction((adminId, id) => {
    const current = id == null
        ? db._raw.prepare('SELECT id, name FROM SiteExhibition WHERE is_active = 1 ORDER BY event_time IS NULL, event_time, id LIMIT 1').get()
        : db._raw.prepare('SELECT id, name FROM SiteExhibition WHERE is_active = 1 AND id = ?').get(id);
    if (!current) return false;
    db._raw.prepare('UPDATE SiteExhibition SET is_active = 0 WHERE id = ?').run(current.id);
    insertAdminAction(adminId, 'clear-exhibition', null, JSON.stringify({ exhibition_id: current.id, name: current.name }));
    return true;
});

function validIconUrl(value) {
    if (!value) return true;
    if (/^\/uploads\/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp|gif)$/i.test(value) && !value.includes('..')) return true;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
}

// 展会地点选填：两个坐标都留空表示没有地点；否则都必须是有效的 GCJ-02 坐标（0,0 视为未选）
function parseLocation(body) {
    const blank = (value) => value === undefined || value === null || value === '';
    if (blank(body?.latitude) && blank(body?.longitude)) return { latitude: null, longitude: null };
    const latitude = Number(body?.latitude);
    const longitude = Number(body?.longitude);
    if (blank(body?.latitude) || blank(body?.longitude) || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
    return { latitude, longitude };
}

// Venue-local date/time, minute precision. Compare a round trip to reject impossible calendar dates.
function validEventTime(value) {
    if (value == null || value === '') return true; // Legacy clients and undated existing activities.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
    const date = new Date(`${value}:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
}

function save(req, res) {
    const id = req.params.id == null ? null : Number(req.params.id);
    if (id != null && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: '展会编号无效' });
    const fields = {};
    for (const key of ['name', 'description', 'information', 'icon_url', 'location_name']) {
        fields[key] = typeof req.body?.[key] === 'string' ? req.body[key].trim() : '';
    }
    if (!fields.name || !fields.description || !fields.information) return res.status(400).json({ error: '请填写展会名称、简介和信息' });
    if (fields.name.length > 80 || fields.description.length > 2000 || fields.information.length > 1000) {
        return res.status(400).json({ error: '展会名称最多 80 字、简介最多 2000 字、信息最多 1000 字' });
    }
    if (fields.icon_url.length > 2048 || !validIconUrl(fields.icon_url)) return res.status(400).json({ error: '展会图标地址无效' });
    if (fields.location_name.length > 80) return res.status(400).json({ error: '展会地点名称最多 80 字' });
    const location = parseLocation(req.body);
    if (!location) return res.status(400).json({ error: '展会地点坐标无效' });
    if (!validEventTime(req.body?.event_time)) return res.status(400).json({ error: '活动时间无效，请填写有效的日期和时间' });
    try {
        const savedId = publish.immediate({ ...fields, ...location, event_time: req.body?.event_time || null, id, adminId: req.user.id });
        if (savedId == null) return res.status(404).json({ error: '展会不存在或已下架' });
        return res.json({ success: true, id: savedId });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '展会发布失败，请稍后重试' });
    }
}
router.post('/', save);
router.put('/:id', save);

router.delete('/:id', (req, res) => {
    const id = req.params.id === 'current' ? null : Number(req.params.id);
    if (id != null && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: '展会编号无效' });
    try {
        return res.json({ success: true, cleared: unpublish.immediate(req.user.id, id) });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '展会下架失败，请稍后重试' });
    }
});

module.exports = router;
