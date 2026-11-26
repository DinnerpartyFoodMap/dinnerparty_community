const { beijingClock, MINUTE_MS } = require('../../../infrastructure/beijingClock');

const orderedUsers = (a, b) => a < b ? [a, b] : [b, a];

function bondLevel(score) {
    if (score >= 30) return 3;
    if (score >= 12) return 2;
    if (score >= 4) return 1;
    return 0;
}

function readBond(database, a, b) {
    return database.prepare('SELECT score FROM RoomBond WHERE user_low = ? AND user_high = ?')
        .get(...orderedUsers(a, b))?.score ?? null;
}

function readMeet(database, userId, day) {
    return database.prepare('SELECT * FROM RoomMeet WHERE day = ? AND (x_user = ? OR y_user = ?)')
        .get(day, userId, userId);
}

function cancelFutureMeets(database, userId, now = Date.now(), partnerId) {
    const { day, msOfDay } = beijingClock(new Date(now));
    database.prepare(`DELETE FROM RoomMeet WHERE (x_user = ? OR y_user = ?)
        ${partnerId == null ? '' : 'AND (x_user = ? OR y_user = ?)'}
        AND (day > ? OR (day = ? AND start_min * ? > ?))`)
        .run(userId, userId, ...(partnerId == null ? [] : [partnerId, partnerId]), day, day, MINUTE_MS, msOfDay);
}

module.exports = { orderedUsers, bondLevel, readBond, readMeet, cancelFutureMeets };
