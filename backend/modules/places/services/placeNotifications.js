const { EventEmitter } = require('events');
const { db } = require('../../../infrastructure/database');
const botConfig = require('../../qqbot/runtime/config');

// Pending QQ group notifications for newly created places. Rows are written in
// the same transaction as the place, so a rolled-back creation never notifies
// and a committed one is delivered once the bot is (re)connected.
const EVENT_PLACE_CREATED = 'place_created';
const wakeEmitter = new EventEmitter();

/**
 * Must run inside the place-creation transaction. Returns the number of tasks queued.
 * Only places that are already public are announced: a place waiting for its
 * moderation check (doc/placeModeration.md) is queued again once it passes.
 */
function enqueuePlaceCreatedNotifications(placeIds, { source } = {}) {
    const config = botConfig.get();
    // Places created while pushes are switched off are never back-filled later.
    if (!config.enabled || !config.notify.enabled || !config.notify.groupIds.length) return 0;
    const time = new Date().toISOString();
    const insert = db._raw.prepare(`INSERT OR IGNORE INTO QQBotNotification
        (place_id, group_id, event_type, status, attempts, next_attempt_at, source, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`);
    const isPublic = db._raw.prepare("SELECT 1 FROM Place WHERE id = ? AND moderation_status = 'visible'");
    let queued = 0;
    for (const placeId of placeIds) {
        if (!isPublic.get(placeId)) continue;
        for (const groupId of config.notify.groupIds) {
            queued += insert.run(placeId, groupId, EVENT_PLACE_CREATED, time, source || null, time, time).changes;
        }
    }
    return queued;
}

function wakeNotificationWorker() {
    wakeEmitter.emit('wake');
}

function onNotificationWake(listener) {
    wakeEmitter.on('wake', listener);
    return () => wakeEmitter.off('wake', listener);
}

module.exports = { EVENT_PLACE_CREATED, enqueuePlaceCreatedNotifications, wakeNotificationWorker, onNotificationWake };
