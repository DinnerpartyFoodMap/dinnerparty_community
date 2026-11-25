const express = require("express");
const router = express.Router();
const { db } = require("../../../infrastructure/database");
const { requireAuthWithCode } = require("../../accounts/middleware/auth");
const requireAdmin = require("../../admin/middleware/adminAuth");
const { submitComment, deleteOwnComment } = require('../services/residentComments');

// 地点修改记录仅供管理员查看，包括不带 kind 的旧客户端请求。
router.get("/place/:placeId", requireAuthWithCode, requireAdmin("manage_comments", { codedErrors: true }), (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { placeId } = req.params;
    db.all(`SELECT c.*, u.username FROM Comment c JOIN Place p ON p.id = c.place_id LEFT JOIN User u ON u.id = c.user_id
        WHERE c.place_id = ? AND p.moderation_status = 'visible' AND c.source IS NULL
        ${req.query.kind === 'edit' ? 'AND c.place_revision_id IS NOT NULL' : ''} ORDER BY c.time DESC, c.id DESC`, [placeId], (err, rows) => {
        if (err) {
            res.locals.unhandledError = err;
            return res.status(500).json({ error: '修改记录读取失败，请稍后重试', code: 'COMMENT_READ_FAILED' });
        }
        res.json(rows);
    });
});

function writeError(res, error, fallback, code) {
    if (error.publicMessage) {
        const authCode = error.status === 403 ? 'AUTH_USER_BANNED' : 'AUTH_USER_NOT_FOUND';
        return res.status(error.status).json({ error: error.publicMessage, code: error.code || authCode });
    }
    res.locals.unhandledError = error;
    return res.status(500).json({ error: fallback, code });
}

router.post('/', requireAuthWithCode, (req, res) => {
    try {
        return res.json({ comment: submitComment(req.user.id, req.body) });
    } catch (error) {
        return writeError(res, error, '评论保存失败，请稍后重试', 'COMMENT_SAVE_FAILED');
    }
});

router.delete('/:id', requireAuthWithCode, (req, res) => {
    try {
        deleteOwnComment(req.params.id, req.user.id);
        return res.json({ success: true });
    } catch (error) {
        return writeError(res, error, '评论删除失败，请稍后重试', 'COMMENT_DELETE_FAILED');
    }
});

module.exports = router;
