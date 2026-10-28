const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');

// Ban state shared by website authentication and the QQ Bot: an expired ban is
// lifted (and audited) the first time it is checked, an active one blocks writes.
const autoUnbanTransaction = db._raw.transaction(({ userId, previousReason }) => {
    const updated = db._raw.prepare(
        `UPDATE User
         SET is_banned = 0, ban_reason = NULL, ban_expires = NULL
         WHERE id = ? AND is_banned = 1`
    ).run(userId);
    if (updated.changes === 1) {
        insertAdminAction(
            null,
            'auto-unban',
            userId,
            JSON.stringify({ previous_reason: previousReason || null })
        );
    }
    return updated.changes === 1;
});

function isBanExpired(user, now = new Date()) {
    if (!user || !user.is_banned || !user.ban_expires) return false;
    const expires = new Date(user.ban_expires);
    return !Number.isNaN(expires.getTime()) && expires <= now;
}

/** Whether the ban is in force right now, without writing anything. */
function isBanActive(user, now = new Date()) {
    return !!(user && user.is_banned) && !isBanExpired(user, now);
}

/**
 * Lifts an expired ban in place on `user` (and in the database).
 * Returns true while the user is still banned.
 */
function refreshBanState(user, now = new Date()) {
    if (!user || !user.is_banned) return false;
    if (isBanExpired(user, now)) {
        autoUnbanTransaction.immediate({ userId: user.id, previousReason: user.ban_reason });
        // Another concurrent request may have performed the same update first;
        // either way the expired ban is now lifted.
        user.is_banned = 0;
        user.ban_reason = null;
        user.ban_expires = null;
        return false;
    }
    return true;
}

// Call again inside a write transaction after any external await.
function requireWritableUser(userId) {
    const user=db._raw.prepare('SELECT * FROM User WHERE id=?').get(userId);
    if(!user)throw Object.assign(new Error('住民不存在'),{status:404,publicMessage:'住民不存在'});
    if(isBanActive(user))throw Object.assign(new Error('通行凭证已受限，仅允许查看内容'),{status:403,publicMessage:'通行凭证已受限，仅允许查看内容'});
    return user;
}
module.exports = { isBanExpired, isBanActive, refreshBanState, requireWritableUser };
