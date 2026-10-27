const express = require('express');
const { performance } = require('perf_hooks');
const { fastSearch } = require('../services/placeSearch');
const { attachViewer, requireAuth } = require('../../accounts/middleware/auth');
const {
    searchSemanticPlaces,
    normalizeCenter,
    normalizeBounds
} = require('../services/semanticSearch');

const router = express.Router();
const AI_QUERY_MAX_LENGTH = 300;
const AI_RATE_WINDOW_MS = 60 * 1000;
const AI_RATE_LIMIT = Math.max(1, Number.parseInt(process.env.AI_SEARCH_RATE_LIMIT, 10) || 12);
const aiRateBuckets = new Map();

function parseLimit(rawValue, fallback = 50, max = 100) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function sendFastSearch(req, res) {
    const query = String(req.query.q || '').trim().slice(0, AI_QUERY_MAX_LENGTH);
    if (!query) return res.json([]);
    const startedAt = performance.now();
    const center = { lat: req.query.lat, lng: req.query.lng };
    const rows = fastSearch(query, parseLimit(req.query.limit), { center, viewerId: req.viewer?.id ?? null });
    const duration = performance.now() - startedAt;
    res.set('Server-Timing', `sqlite;dur=${duration.toFixed(1)}`);
    res.set('Cache-Control', 'no-store');
    return res.json(rows);
}

function consumeAiRateLimit(req) {
    const now = Date.now();
    if (aiRateBuckets.size > 1000) {
        for (const [bucketKey, bucket] of aiRateBuckets) {
            if (now - bucket.startedAt >= AI_RATE_WINDOW_MS) aiRateBuckets.delete(bucketKey);
        }
    }
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const previous = aiRateBuckets.get(key);
    if (!previous || now - previous.startedAt >= AI_RATE_WINDOW_MS) {
        aiRateBuckets.set(key, { startedAt: now, count: 1 });
        return true;
    }
    previous.count += 1;
    return previous.count <= AI_RATE_LIMIT;
}

// Request A: local keyword relevance + proximity ranking; no AI calls.
router.get('/places/search/fast', attachViewer, sendFastSearch);

// Backward-compatible alias used by older clients and live suggestions.
router.get('/places/search', attachViewer, sendFastSearch);

// Request B: embedding -> sqlite-vec KNN -> DeepSeek Yuyuko recommendation.
// 需要登录；reason_source 为 deepseek 的推荐语由模型写成，前端标注“AI 生成”（所用模型公示在用户协议）。
router.post('/places/search/ai', requireAuth, async (req, res) => {
    const query = String(req.body?.q || '').trim();
    if (!query) return res.status(400).json({ error: '搜索内容不能为空' });
    if (query.length > AI_QUERY_MAX_LENGTH) {
        return res.status(400).json({ error: `搜索内容不能超过 ${AI_QUERY_MAX_LENGTH} 个字符` });
    }
    if (!consumeAiRateLimit(req)) {
        return res.status(429).json({ error: '幽幽子正在认真品尝，请稍后再问一次吧' });
    }

    try {
        const center = normalizeCenter(req.body?.center);
        const bounds = normalizeBounds(req.body?.bounds);
        const result = await searchSemanticPlaces(query, {
            limit: parseLimit(req.body?.limit, 5, 10),
            center,
            bounds
        });
        return res.json(result);
    } catch (error) {
        console.warn('AI place search unavailable:', error.message);
        return res.status(503).json({
            status: 'unavailable',
            recommendation: null,
            recommendations: [],
            matches: [],
            error: '幽幽子的语义搜索暂时不可用，基础搜索仍可正常使用'
        });
    }
});

module.exports = router;
