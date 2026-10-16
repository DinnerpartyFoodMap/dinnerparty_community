const express = require('express');
const publication = require('../services/journeyPublication');

// Public diaries are readable without login, like public places. Every read checks that the
// snapshot is still active, so withdrawn text and photos stop being served immediately.
const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const run = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
router.get('/:publicId', run((req, res) => res.json(publication.publicJourney(req.params.publicId))));
router.get('/:publicId/media/:mediaId', run((req, res) => res.type('webp').send(publication.publicMedia(req.params.publicId, req.params.mediaId))));
router.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.status ? err.message : '日记服务暂时不可用' }));
module.exports = router;
