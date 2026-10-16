const express = require('express');
const { requireAuth } = require('../../accounts/middleware/auth');
const { ratingState, ratePlace, withdrawRating } = require('../services/placeRatings');

const router = express.Router();
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Guests can read the public summary. A supplied token must still pass the full
// JWT/session check; the viewer is never taken from the query or body.
function optionalAuth(req, res, next) {
    if (req.get('Authorization')) return requireAuth(req, res, next);
    return next();
}

function handle(fn) {
    return (req, res) => {
        try {
            res.json(fn(req));
        } catch (error) {
            if (error && error.publicMessage) return res.status(error.status || 400).json({ error: error.publicMessage });
            res.locals.unhandledError = error;
            res.status(500).json({ error: '评价服务暂不可用，请稍后重试' });
        }
    };
}

// GET /api/ratings/places/:placeId — summary, own rating, taste-weighted average and today's quota
router.get('/places/:placeId', optionalAuth, handle((req) => ratingState(req.params.placeId, req.user || null)));

// PUT /api/ratings/places/:placeId { score: 1–4 } — rate or change; counts toward the daily limit
router.put('/places/:placeId', requireAuth, handle((req) => ratePlace(req.user, req.params.placeId, req.body && req.body.score)));

// DELETE /api/ratings/places/:placeId — withdraw own rating (used quota is not returned)
router.delete('/places/:placeId', requireAuth, handle((req) => withdrawRating(req.user, req.params.placeId)));

module.exports = router;
