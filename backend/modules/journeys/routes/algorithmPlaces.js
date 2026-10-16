const express = require('express');
const { createHash, timingSafeEqual } = require('crypto');
const { db } = require('../../../infrastructure/database');

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function authenticated(authorization, expected) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization || '');
    const supplied = match ? match[1] : '';
    // Comparing fixed-size digests also avoids a timing branch on token length.
    const digest = value => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(supplied), digest(expected)) && !!match;
}

router.post('/', (req, res) => {
    const token = String(process.env.JOURNEY_ALGORITHM_CALLBACK_TOKEN || '').trim();
    if (!token || /[\u0000-\u0020\u007f]/.test(token)) return res.status(503).json({error:'地点检索回调未配置'});
    if (!authenticated(req.get('Authorization'), token)) return res.status(401).json({error:'地点检索回调鉴权失败'});
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.name !== 'string' ||
        body.name.length > 100 || /[\u0000-\u001f\u007f]/.test(body.name)) return res.status(400).json({error:'请提供有效地点名称'});
    const name = body.name.trim().replace(/[%_]/g, '').trim();
    if (!name) return res.status(400).json({error:'请提供有效地点名称'});
    try {
        const places = db._raw.prepare('SELECT id,name,longitude,latitude,address FROM Place WHERE name LIKE ? LIMIT 400').all(`%${name}%`);
        return res.json({places});
    } catch {
        return res.status(503).json({error:'地点检索暂不可用'});
    }
});

module.exports = router;
