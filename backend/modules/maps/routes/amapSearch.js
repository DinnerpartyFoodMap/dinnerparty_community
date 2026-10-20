'use strict';
const express = require('express');
const { createAmapSearch } = require('../services/amapSearch');

function createAmapSearchRouter(service = createAmapSearch()) {
    const router = express.Router();
    const recent = new Map();
    router.post('/', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const now = Date.now();
        // Bound accidental repeat submissions as well as abuse; the persistent global
        // budget is still authoritative across processes and client/IP changes.
        if (recent.size > 5000) for (const [ip, value] of recent) if (now - value.start >= 60000) recent.delete(ip);
        const ip = req.ip || 'unknown';
        let bucket = recent.get(ip);
        if (!bucket || now - bucket.start >= 60000) { bucket = { start: now, count: 0 }; recent.set(ip, bucket); }
        if (++bucket.count > 10) {
            res.set('Retry-After', String(Math.ceil((60000 - now + bucket.start) / 1000)));
            return res.status(429).json({ code: 'AMAP_SEARCH_RATE_LIMIT', error: '搜索过于频繁，请稍后重试。' });
        }
        try { return res.json(await service.search(req.body)); }
        catch (error) {
            if (error.status === 429) res.set('Retry-After', '3600');
            return res.status(error.status || 503).json({ code: error.code || 'AMAP_SEARCH_UNAVAILABLE', error: error.code ? error.message : '外部地点搜索暂时不可用。' });
        }
    });
    return router;
}
module.exports = { createAmapSearchRouter };
