const { PERMISSIONS } = require('../../admin/services/adminPermissions');
const { notBlockedSql } = require('../../accounts/services/userRelations');
const { isBanActive } = require('../../accounts/services/userAccess');
const { DEFAULT_COMPANION_ID, getCompanionState } = require('../../skins/services/companionState');
const { avatarUrl, findPack } = require('../../skins/services/resourcePacks');
const { DEFAULT_ROLE_NAME } = require('./roomNames');

function allowsRooms(user, audience = process.env.ROOMS_AUDIENCE) {
    return Boolean(user && (audience === 'all' || audience === 'admin' && Object.hasOwn(PERMISSIONS, user.admin_level)));
}

function isPaused(settings) {
    try {
        const value = typeof settings === 'string' ? JSON.parse(settings) : settings;
        return value?.companion_enabled === false;
    } catch {
        return false;
    }
}

function readRoom(database, userId) {
    return database.prepare(`SELECT r.*, u.username AS owner_name, u.map_settings, u.admin_level, u.is_banned, u.ban_expires
        FROM RoomProfile r JOIN User u ON u.id = r.user_id WHERE r.user_id = ?`).get(userId);
}

const isNamed = (room) => room?.enabled === 1 && room.named_day != null;
const blockedEitherWay = (database, a, b) => database.prepare(`SELECT 1 FROM User u WHERE u.id = ?
    AND (NOT (${notBlockedSql('u.id')}) OR EXISTS (
        SELECT 1 FROM UserBlock WHERE user_id = u.id AND blocked_id = ?
    ))`).get(b, a, a) != null;

function canDisclose(database, room, viewerId, now) {
    return isNamed(room) && room.visibility === 'residents' && !isPaused(room.map_settings)
        && !isBanActive(room, new Date(now)) && !blockedEitherWay(database, viewerId, room.user_id);
}

function canReadRoom(database, viewerId, ownerId, now = Date.now(), room) {
    if (!viewerId || !allowsRooms(database.prepare('SELECT admin_level FROM User WHERE id = ?').get(viewerId))) return false;
    if (room === undefined) room = readRoom(database, ownerId);
    return viewerId === ownerId ? isNamed(room) : canDisclose(database, room, viewerId, now);
}

function roomPerson(database, room, viewerId, sheet = JSON.parse(room.sheet), state = getCompanionState(room.user_id, database)) {
    const { user_id, owner_name } = room;
    const { active: role } = state;
    const pack = role === DEFAULT_COMPANION_ID ? null : findPack('companion', role);
    const nameVisible = user_id === viewerId || database.prepare(
        "SELECT 1 FROM RoomText WHERE user_id = ? AND field = 'name' AND value = ? AND status = 'visible'"
    ).get(user_id, sheet.name);
    return { user_id, name: nameVisible ? sheet.name : pack?.name ?? DEFAULT_ROLE_NAME,
        role, avatar: avatarUrl(pack), owner_name };
}

function markVisit(database, ownerId, own, now) {
    const column = own ? 'last_opened_at_ms' : 'last_visited_at_ms';
    database.prepare(`UPDATE RoomProfile SET ${column} = MAX(COALESCE(${column}, 0), ?) WHERE user_id = ?`)
        .run(Number(now), ownerId);
}

module.exports = { allowsRooms, isPaused, isNamed, blockedEitherWay, canDisclose, readRoom, canReadRoom, roomPerson, markVisit };
