const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../../../infrastructure/logger');
const imageStorage = require('../services/imageStorage');

// 先收进内存，校验真实格式后再写本地或 OSS
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // 20MB limit
    fileFilter: function (req, file, cb) {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('仅允许上传图片文件'));
        }
        cb(null, true);
    }
});

router.post('/', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: '图片过大，最大支持 20MB' });
            }
            return res.status(400).json({ error: err.message || '上传失败' });
        }

        if (!req.file) {
            return res.status(400).json({ error: '上传失败或未提供文件' });
        }

        // 校验真实格式，并去掉拍摄位置等元数据（图片公开可下载）
        const prepared = await imageStorage.prepareImage(req.file.buffer).catch(() => null);
        if (!prepared) {
            return res.status(400).json({ error: '仅支持 JPG、PNG、WebP、GIF 图片' });
        }

        try {
            // 本地模式返回 /uploads/... 相对地址，OSS 模式返回完整地址（前端两种都兼容）
            const url = await imageStorage.saveImage(prepared.buffer, prepared.format);
            res.json({ url });
        } catch (error) {
            logger.error('Image upload failed', {
                storage: imageStorage.isOssEnabled() ? 'oss' : 'local',
                bytes: req.file.size,
                error: error.message,
                code: error.code
            });
            res.status(502).json({ error: '图片保存失败，请稍后重试' });
        }
    });
});

module.exports = router;
