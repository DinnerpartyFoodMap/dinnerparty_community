const router = require('express').Router();
const multer = require('multer');
const { requireAuth } = require('../../accounts/middleware/auth');
const feedback = require('../services/feedbackService');
const logger = require('../../../infrastructure/logger');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: feedback.LIMITS.imageBytes, files: feedback.LIMITS.images, fields: 10, fieldSize: 64 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new feedback.FeedbackError('仅允许上传图片文件'));
        cb(null, true);
    }
});

router.use(requireAuth);

// 提交反馈：multipart，字段 type / content / platform / app_version，图片字段 images（最多 4 张）
router.post('/', (req, res) => {
    upload.array('images', feedback.LIMITS.images)(req, res, async (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '单张图片最大 10MB' });
            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `最多上传 ${feedback.LIMITS.images} 张图片` });
            return res.status(400).json({ error: err instanceof feedback.FeedbackError ? err.message : '上传失败' });
        }
        try {
            const id = await feedback.submitFeedback({ userId: req.user.id, body: req.body, files: req.files || [], userAgent: req.get('User-Agent') });
            logger.info('Feedback submitted', { event: 'feedback.submitted', feedbackId: id, type: req.body.type, images: (req.files || []).length });
            return res.status(201).json({ id });
        } catch (error) {
            if (error instanceof feedback.FeedbackError) return res.status(error.status).json({ error: error.message });
            res.locals.unhandledError = error;
            return res.status(500).json({ error: '反馈提交失败，请稍后重试' });
        }
    });
});

module.exports = router;
