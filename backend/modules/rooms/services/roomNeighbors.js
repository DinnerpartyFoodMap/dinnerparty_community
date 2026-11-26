const { neighbors } = require('../../community/services/communityPreferences');
const { canReadRoom, readRoom, roomPerson } = require('./roomAccess');

const TTL = 10 * 60 * 1000;
const caches = new WeakMap();

async function getNeighbors(database, viewerId) {
    if (database.prepare('SELECT discovery FROM MapConsent WHERE user_id = ?').get(viewerId)?.discovery === 0) {
        return { neighbors: [] };
    }
    if (!caches.has(database)) caches.set(database, new Map());
    const cache = caches.get(database);
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    if (!cache.has(viewerId)) {
        const entry = { expires: now + TTL, ids: neighbors(viewerId).then(({ neighbors: rows }) => rows.map(({ id }) => id)) };
        cache.set(viewerId, entry);
        entry.ids.catch(() => {
            if (cache.get(viewerId) === entry) cache.delete(viewerId);
        });
    }
    const ids = await cache.get(viewerId).ids;
    const discovery = database.prepare('SELECT discovery FROM MapConsent WHERE user_id = ?');
    if (discovery.get(viewerId)?.discovery === 0) return { neighbors: [] };
    const visible = [];
    for (const id of ids) {
        const room = readRoom(database, id);
        if (discovery.get(id)?.discovery === 0 || !canReadRoom(database, viewerId, id, Date.now(), room)) continue;
        const { user_id, name, avatar, owner_name } = roomPerson(database, room, viewerId);
        visible.push({ user_id, name, avatar, owner_name });
        if (visible.length === 5) break;
    }
    return { neighbors: visible };
}

module.exports = { getNeighbors };
