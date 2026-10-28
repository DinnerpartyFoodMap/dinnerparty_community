const { randomUUID } = require('crypto');
const { db } = require('../../../infrastructure/database');
const DEDUPE_MS = 30 * 60 * 1000;
// This module owns authenticated business writes. Composition lives in the private service.
const CHANNELS = {
    navigation: ['system-default', 'apple-maps', 'amap', 'tencent', 'google'],
    share: ['place', 'amap'],
    share_copy: ['place', 'amap', 'place_info']
};

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function validPlaceId(value) {
    return (typeof value === 'string' && /^[1-9]\d*$/.test(value) || typeof value === 'number')
        && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validateBehavior(payload) {
    if (!payload || !validPlaceId(payload.place_id)) fail(400, '无效的 place_id');
    if (typeof payload.event_type !== 'string' || !Object.hasOwn(CHANNELS, payload.event_type)) fail(400, '不支持的行为类型');
    if (!CHANNELS[payload.event_type].includes(payload.channel)) fail(400, '无效的行为渠道');
    if (typeof payload.event_id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.event_id)) {
        fail(400, '无效的 event_id');
    }
}

const recordBehaviorTransaction = db._raw.transaction((userId, payload, now) => {
    const placeId = Number(payload.place_id);
    const previous = db._raw.prepare('SELECT place_id, event_type, channel FROM UserBehaviorEvent WHERE user_id = ? AND event_id = ?')
        .get(userId, payload.event_id);
    if (previous) {
        if (previous.place_id !== placeId || previous.event_type !== payload.event_type || previous.channel !== payload.channel) {
            fail(409, 'event_id 已用于其他行为');
        }
        return { recorded: false, reason: 'duplicate' };
    }
    if (!db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) fail(404, '地点不存在');
    const recent = db._raw.prepare(`SELECT id FROM UserBehaviorEvent
        WHERE user_id = ? AND place_id = ? AND event_type = ? AND contributes = 1 AND occurred_at > ? LIMIT 1`)
        .get(userId, placeId, payload.event_type, now - DEDUPE_MS);
    const rate = db._raw.prepare('SELECT COUNT(*) AS count FROM UserBehaviorEvent WHERE user_id = ? AND occurred_at > ?')
        .get(userId, now - 60000);
    if (rate.count >= 60) fail(429, '操作过于频繁，请稍后再试');
    db._raw.prepare(`INSERT INTO UserBehaviorEvent(user_id, place_id, event_id, event_type, channel, occurred_at, contributes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, placeId, payload.event_id, payload.event_type, payload.channel, now, recent ? 0 : 1);
    const evidence=require('../../ratings/services/ratingEvidence');
    evidence.captureEvent('UserBehaviorEvent',userId,payload.event_id,{trigger:payload.trigger,surface:payload.surface==='place_card'?'place_card':null});evidence.queueEvidence(userId);
    return { recorded: true, counted: !recent, ...(recent ? { reason: 'cooldown' } : {}) };
});

function recordBehavior(userId, payload) {
    validateBehavior(payload);
    // The client cannot choose the acting user, timestamp, weight or vector.
    const result = recordBehaviorTransaction.immediate(userId, payload, Date.now());
    if (result.counted) queueUserVectorRefresh(userId);
    return result;
}

const changeFavoriteTransaction = db._raw.transaction((userId, placeId, favorite) => {
    // 别人还在复核中的地点看不到，也不能收藏
    if (favorite && !db._raw.prepare("SELECT id FROM Place WHERE id = ? AND (moderation_status = 'visible' OR creator_id = ?)").get(placeId, userId)) fail(404, '地点不存在');
    const result = favorite
        ? db._raw.prepare('INSERT OR IGNORE INTO Favorite(user_id, place_id) VALUES (?, ?)').run(userId, placeId)
        : db._raw.prepare('DELETE FROM Favorite WHERE user_id = ? AND place_id = ?').run(userId, placeId);
    if (result.changes && db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) {
        const eventId=randomUUID();
        db._raw.prepare(`INSERT INTO UserBehaviorEvent(user_id, place_id, event_id, event_type, channel, occurred_at)
            VALUES (?, ?, ?, ?, 'favorite', ?)`).run(userId, placeId, eventId, favorite ? 'favorite_add' : 'favorite_remove', Date.now());
        const evidence=require('../../ratings/services/ratingEvidence');evidence.captureEvent('UserBehaviorEvent',userId,eventId,{trigger:'user',surface:'favorites'});evidence.queueEvidence(userId);
    }
    return result.changes > 0;
});

function changeFavorite(userId, placeId, favorite) {
    if (!validPlaceId(placeId)) fail(400, '无效的 placeId');
    const changed = changeFavoriteTransaction.immediate(userId, Number(placeId), favorite);
    if (changed) queueUserVectorRefresh(userId);
    return changed;
}


const {queueUserVectorRefresh}=require('./userVectorAdapter');
module.exports={recordBehavior,changeFavorite,DEDUPE_MS,decodeVector:require('./vectorCodec').decodeVector,...require('./userVectorAdapter')};
