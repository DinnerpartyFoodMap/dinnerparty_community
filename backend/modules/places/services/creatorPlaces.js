const { db } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');
const { viewerPlaceSql } = require('./placeVisibility');

// 某位住民创建的地点（地点卡片点“最近修改”的名字后，地图只显示这些地点）：最近创建的在前，最多 CREATOR_PLACES_LIMIT 个。
// 可见性与附近地点一致：公开的，加上观看者自己创建、还在审核中的。字段与 /places/nearby 相同，前端可直接交给标记层。
const CREATOR_PLACES_LIMIT = 200;

function listCreatorPlaces(creatorId, viewerId = null, database = db._raw) {
    const places = database.prepare(`SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
        FROM Place p
        LEFT JOIN User u ON p.creator_id = u.id
        LEFT JOIN User uu ON p.updated_by = uu.id
        WHERE p.creator_id = ? AND ${viewerPlaceSql('p')}
        ORDER BY p.created_time DESC, p.id DESC
        LIMIT ?`).all(creatorId, viewerId, CREATOR_PLACES_LIMIT);
    const { total } = database.prepare(`SELECT COUNT(*) AS total FROM Place p WHERE p.creator_id = ? AND ${viewerPlaceSql('p')}`)
        .get(creatorId, viewerId);
    return { places, total };
}

module.exports = { CREATOR_PLACES_LIMIT, listCreatorPlaces };
