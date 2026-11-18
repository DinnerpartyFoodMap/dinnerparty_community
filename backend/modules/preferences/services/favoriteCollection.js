const { db } = require('../../../infrastructure/database');
const { isBlocked, notBlockedSql } = require('../../accounts/services/userRelations');
const { viewerPlaceSql } = require('../../places/services/placeVisibility');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');

const PLACE_COLUMNS = `p.id, p.name, p.category, p.per_person_cost, p.exterior_images, p.menu_images,${RATING_COLUMNS_SQL}`;

function widgetPlace(row) {
    let image = null;
    for (const value of [row.exterior_images, row.menu_images]) {
        if (!value) continue;
        try {
            const urls = JSON.parse(value);
            image = Array.isArray(urls) ? urls.find((item) => typeof item === 'string' && item) : null;
            if (image) break;
        } catch (_) { /* Invalid stored image list. */ }
    }
    return {
        id: row.id, name: row.name, category: row.category || '', per_person_cost: row.per_person_cost,
        image: image || null, rating_count: Number(row.rating_count) || 0, rating_average: row.rating_average
    };
}

function getFavoriteVisibility(userId, database = db._raw) {
    return database.prepare('SELECT favorites_public FROM User WHERE id = ?').get(userId)?.favorites_public === 1;
}

function setFavoriteVisibility(userId, isPublic, database = db._raw) {
    database.prepare('UPDATE User SET favorites_public = ? WHERE id = ?').run(Number(isPublic), userId);
    return isPublic;
}

function getFavoriteCollection(userId, viewerId, { limit = -1, database = db._raw } = {}) {
    const owner = database.prepare('SELECT id, username, favorites_public, is_banned FROM User WHERE id = ?').get(userId);
    if (!owner) return null;
    const self = viewerId != null && String(viewerId) === String(owner.id);
    const isPublic = owner.favorites_public === 1;
    if (!self && (!isPublic || owner.is_banned || isBlocked(viewerId, owner.id, database))) return null;
    const rows = database.prepare(`SELECT ${PLACE_COLUMNS}, COUNT(*) OVER () AS total FROM Favorite f
        JOIN Place p ON p.id = f.place_id
        WHERE f.user_id = ? AND ${viewerPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}
        ORDER BY f.created_time DESC, f.id DESC LIMIT ?`).all(owner.id, self ? owner.id : null, viewerId ?? null, limit);
    return {
        user: { id: owner.id, username: owner.username }, is_public: isPublic,
        total: rows[0]?.total ?? 0, places: rows.map(widgetPlace)
    };
}

module.exports = { PLACE_COLUMNS, widgetPlace, getFavoriteVisibility, setFavoriteVisibility, getFavoriteCollection };
