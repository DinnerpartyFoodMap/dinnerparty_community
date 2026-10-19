const router = require('express').Router();
const { db } = require('../../../infrastructure/database');
const requireAdmin = require('../middleware/adminAuth');
const { insertAdminAction } = require('../services/adminAudit');

router.use(requireAdmin('manage_announcements'));
router.use(require('../../community/routes/exhibitions'));

const publish = db._raw.transaction(({ name, description, information, icon_url, adminId }) => {
    db._raw.prepare('UPDATE SiteExhibition SET is_active = 0 WHERE is_active = 1').run();
    const result = db._raw.prepare('INSERT INTO SiteExhibition (name, description, information, icon_url, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(name, description, information, icon_url, adminId);
    const id = Number(result.lastInsertRowid);
    insertAdminAction(adminId, 'publish-exhibition', null, JSON.stringify({ exhibition_id: id, name }));
    return id;
});
const unpublish = db._raw.transaction(adminId => {
    const current = db._raw.prepare('SELECT id, name FROM SiteExhibition WHERE is_active = 1').get();
    if (!current) return false;
    db._raw.prepare('UPDATE SiteExhibition SET is_active = 0 WHERE is_active = 1').run();
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

router.post('/', (req, res) => {
    const fields = {};
    for (const key of ['name', 'description', 'information', 'icon_url']) {
        fields[key] = typeof req.body?.[key] === 'string' ? req.body[key].trim() : '';
    }
    if (!fields.name || !fields.description || !fields.information) return res.status(400).json({ error: '请填写展会名称、简介和信息' });
    if (fields.name.length > 80 || fields.description.length > 2000 || fields.information.length > 1000) {
        return res.status(400).json({ error: '展会名称最多 80 字、简介最多 2000 字、信息最多 1000 字' });
    }
    if (fields.icon_url.length > 2048 || !validIconUrl(fields.icon_url)) return res.status(400).json({ error: '展会图标地址无效' });
    try {
        return res.json({ success: true, id: publish.immediate({ ...fields, adminId: req.user.id }) });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '展会发布失败，请稍后重试' });
    }
});

router.delete('/current', (req, res) => {
    try {
        return res.json({ success: true, cleared: unpublish.immediate(req.user.id) });
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '展会下架失败，请稍后重试' });
    }
});

module.exports = router;
