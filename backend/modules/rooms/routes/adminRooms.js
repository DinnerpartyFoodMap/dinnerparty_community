const router = require('express').Router();
const { db } = require('../../../infrastructure/database');
const requireAdmin = require('../../admin/middleware/adminAuth');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { clearTexts } = require('../services/roomProfile');
const { RoomError } = require('../services/roomErrors');

router.post('/:userId/clear-texts', requireAdmin('manage_comments'), (req, res, next) => {
    const { userId } = req.params;
    try {
        db._raw.transaction(() => {
            clearTexts(db._raw, userId);
            insertAdminAction(req.user.id, 'room-clear-texts', userId);
        }).immediate();
        return res.json({ ok: true });
    } catch (error) {
        if (error instanceof RoomError) return res.status(error.status).json({ error: error.publicMessage, code: error.code });
        return next(error);
    }
});

module.exports = router;
