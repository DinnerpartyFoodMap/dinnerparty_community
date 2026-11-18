const router = require('express').Router();
const multer = require('multer');
const { requireAuth } = require('../../accounts/middleware/auth');
const { prepareImage } = require('../../media/services/imageStorage');
const checkIns = require('../services/placeCheckIns');
const { ratePlace } = require('../../ratings/services/placeRatings');

const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 3 * 1024 * 1024, fields: 1, fieldSize: 8192 } });

router.get('/check-in-photos/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
    const photo = checkIns.readPhoto(req.params.id, req.query.expires, req.query.token);
    if (!photo) return res.sendStatus(404);
    return res.type(photo.content_type).set('X-Content-Type-Options', 'nosniff').send(photo.bytes);
});

router.post('/:id/check-ins', requireAuth, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    upload.array('photos', 3)(req, res, async error => {
        if (error) return res.status(400).json({ code: 'CHECK_IN_PHOTO_INVALID', error: '最多上传 3 张照片，每张不超过 3 MB' });
        const now = Date.now();
        let body;
        try {
            body = req.is('multipart/form-data') ? JSON.parse(req.body.payload) : req.body;
        } catch {
            return res.status(400).json({ code: 'CHECK_IN_REQUEST_INVALID', error: '打卡内容格式无效' });
        }
        try {
            const prepared = await Promise.all((req.files || []).map(({ buffer }) => prepareImage(buffer).catch(() => null)));
            if (prepared.some(image => !image)) {
                return res.status(400).json({ code: 'CHECK_IN_PHOTO_INVALID', error: '仅支持 JPG、PNG、WebP、GIF 图片' });
            }
            const images = prepared.map(image => ({ bytes: image.buffer, contentType: image.format.contentType }));
            const checkIn = checkIns.createCheckIn(req.user.id, Number(req.params.id), body, now, images);
            if (checkIn.score !== null && !checkIn.rating_saved) {
                try {
                    await ratePlace(req.user, checkIn.place_id, checkIn.score,
                        { requestId: checkIns.ratingRequestId(checkIn.id), confirm: true, surface: 'check_in',
                            expectedRevision: checkIn.rating_base_revision, checkInId: checkIn.id });
                    checkIn.rating_saved = true;
                } catch (ratingError) {
                    if (!ratingError.committed) {
                        checkIn.rating_error = ratingError.publicMessage || '评分暂未保存，可重试提交';
                        checkIn.rating_retryable = ratingError.code !== 'CHECK_IN_RATING_STALE';
                    }
                }
            }
            require('../services/placeMarkers').invalidateMarkerSnapshot();
            require('../services/placeTiles').invalidateTileSnapshot();
            delete checkIn.rating_base_revision;
            return res.json(checkIn);
        } catch (failure) {
            if (failure.publicMessage) return res.status(failure.status || 400).json({ error: failure.publicMessage, code: failure.code });
            return next(failure);
        }
    });
});

module.exports = router;
