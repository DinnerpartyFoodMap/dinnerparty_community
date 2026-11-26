const express = require('express');
const { db } = require('../../../infrastructure/database');
const { requireAuth } = require('../../accounts/middleware/auth');
const { rateLimit } = require('../../../http/middleware/rateLimit');
const { getMe, nameRoom, saveProfile } = require('../services/roomProfile');
const { getDay, getMoments } = require('../services/roomDay');
const { RoomError, roomNotFound } = require('../services/roomErrors');
const { allowsRooms, canReadRoom } = require('../services/roomAccess');
const { getNeighbors } = require('../services/roomNeighbors');

const router = express.Router();

function sendError(res, error) {
    return res.status(error.status).json({ error: error.publicMessage, code: error.code, errors: error.errors });
}

router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    return requireAuth(req, res, next, true, (user) => allowsRooms(user) ? null : roomNotFound());
});
router.use((req, res, next) => req.user.is_banned && req.method !== 'GET'
    ? sendError(res, new RoomError(403, 'AUTH_USER_BANNED', '通行凭证已受限，仅允许查看内容')) : next());
router.use(express.json());

const respond = (read) => async (req, res, next) => {
    try {
        res.json(await read(req));
    } catch (error) {
        next(error);
    }
};

router.get('/me', respond((req) => getMe(db._raw, req.user.id)));
router.post('/me/name', respond((req) => nameRoom(db._raw, req.user.id, req.body)));
router.put('/me', respond((req) => saveProfile(db._raw, req.user.id, req.body)));
router.get('/me/neighbors', respond((req) => getNeighbors(db._raw, req.user.id)));
const limitPeople = rateLimit('people', { member: (req) => req.params.userId });
const limitVisitors = (req, res, next) => {
    if (req.user.id === req.params.userId) return next();
    if (!canReadRoom(db._raw, req.user.id, req.params.userId)) return next(roomNotFound());
    return limitPeople(req, res, next);
};
router.get('/:userId/day', limitVisitors, respond((req) => getDay(db._raw, {
    viewerId: req.user.id, ownerId: req.params.userId, day: req.query.date
})));
router.get('/:userId/moments', limitVisitors, respond((req) => getMoments(db._raw, {
    viewerId: req.user.id, ownerId: req.params.userId, before: req.query.before
})));

router.use((_req, res) => sendError(res, roomNotFound()));
router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof RoomError) return sendError(res, error);
    if ([400, 413, 415].includes(error.status)) {
        return sendError(res, new RoomError(error.status, 'room_invalid', '请求格式无效或超出大小限制'));
    }
    res.locals.unhandledError = error;
    return sendError(res, new RoomError(500, 'room_failed', '暂时无法打开小伙伴页面，请稍后重试'));
});

module.exports = router;
