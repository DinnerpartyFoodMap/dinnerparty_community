const router = require('express').Router();
const { db } = require('../../../infrastructure/database');

const select = `SELECT id, name, description, information, icon_url, location_name, latitude, longitude, event_time, created_time
    FROM SiteExhibition WHERE is_active = 1 ORDER BY event_time IS NULL, event_time, id`;

router.get('/', (req, res) => {
    db.all(select, [], (err, rows) => {
        if (err) return res.status(500).json({ error: '展会加载失败，请稍后重试' });
        res.set('Cache-Control', 'no-store');
        return res.json({ exhibitions: rows });
    });
});

router.get('/current', (req, res) => {
    db.get(`${select} LIMIT 1`, [], (err, row) => {
        if (err) return res.status(500).json({ error: '展会加载失败，请稍后重试' });
        res.set('Cache-Control', 'no-store');
        return res.json({ exhibition: row || null });
    });
});

module.exports = router;
