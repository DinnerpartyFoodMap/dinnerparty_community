const { db } = require('../../../infrastructure/database');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const { getUserCity } = require('./userLocation');
const { viewerRelation } = require('./userRelations');
const { userTasteAxes } = require('../../preferences/services/tasteAxes');

// 住民主页（GET /users/:id/profile，见 ../doc/README.md）：头像、六类餐饮偏好雷达（preferences/services/tasteAxes.js）、上次定位的城市，
// 以及住民自己选的两个小组件（公开收藏夹 / 最近创建的 5 个地点 / 最喜欢的 5 个地点）。
// 地点只给公开的；屏蔽了 Ta 时只返回头部信息（用来解除屏蔽）。
const PROFILE_WIDGETS = Object.freeze(['collection', 'recent', 'favorite']);
const DEFAULT_WIDGETS = Object.freeze(['recent', 'favorite']);
const WIDGET_SLOTS = 2;
const WIDGET_PLACE_LIMIT = 5;

/** 住民存的组件选择：两个位置，每个是 PROFILE_WIDGETS 之一；不合法时用默认 */
function normalizeWidgets(value) {
    let list = value;
    if (typeof value === 'string') {
        try { list = JSON.parse(value); } catch (_) { list = null; }
    }
    if (!Array.isArray(list) || list.length !== WIDGET_SLOTS || !list.every((item) => PROFILE_WIDGETS.includes(item))) {
        return [...DEFAULT_WIDGETS];
    }
    return [...list];
}

function firstImage(...fields) {
    for (const value of fields) {
        if (!value) continue;
        try {
            const list = JSON.parse(value);
            const url = Array.isArray(list) ? list.find((item) => typeof item === 'string' && item) : null;
            if (url) return url;
        } catch (_) { /* 当作没有图片 */ }
    }
    return null;
}

// 小组件里的地点：和地点列表一样不带经纬度，点开走 /p/:id
function widgetPlace(row) {
    return {
        id: row.id,
        name: row.name,
        category: row.category || '',
        per_person_cost: row.per_person_cost,
        image: firstImage(row.exterior_images, row.menu_images),
        rating_count: Number(row.rating_count) || 0,
        rating_average: row.rating_average
    };
}

const PLACE_COLUMNS = `p.id, p.name, p.category, p.per_person_cost, p.exterior_images, p.menu_images,${RATING_COLUMNS_SQL}`;

function recentPlaces(userId, database = db._raw) {
    return database.prepare(`SELECT ${PLACE_COLUMNS} FROM Place p
        WHERE p.creator_id = ? AND ${publicPlaceSql('p')}
        ORDER BY p.created_time DESC, p.id DESC LIMIT ?`).all(userId, WIDGET_PLACE_LIMIT).map(widgetPlace);
}

/** 最喜欢：住民自己评“均线之上”及以上的地点，分高的在前，同分时最近评的在前 */
function favoritePlaces(userId, database = db._raw) {
    return database.prepare(`SELECT ${PLACE_COLUMNS}, r.score AS own_score FROM PlaceRating r
        JOIN Place p ON p.id = r.place_id
        WHERE r.user_id = ? AND r.score >= 3 AND ${publicPlaceSql('p')}
        ORDER BY r.score DESC, r.updated_at DESC, p.id DESC LIMIT ?`).all(userId, WIDGET_PLACE_LIMIT)
        .map((row) => ({ ...widgetPlace(row), own_score: row.own_score }));
}

/** 公开收藏夹：住民标为公开的收藏夹，每个带前几个地点 */
function publicCollections(userId, database = db._raw) {
    let collections = [];
    try {
        collections = database.prepare(`SELECT id, title, updated_at FROM PublicCollection
            WHERE user_id = ? AND is_public = 1 ORDER BY updated_at DESC LIMIT 3`).all(userId);
    } catch (_) {
        return [];
    }
    return collections.map((collection) => {
        const places = database.prepare(`SELECT ${PLACE_COLUMNS} FROM PublicCollectionItem i
            JOIN Place p ON p.id = i.place_id
            WHERE i.collection_id = ? AND ${publicPlaceSql('p')}`).all(collection.id);
        return { id: collection.id, title: collection.title, total: places.length, places: places.slice(0, WIDGET_PLACE_LIMIT).map(widgetPlace) };
    });
}

const WIDGET_LOADERS = { collection: publicCollections, recent: recentPlaces, favorite: favoritePlaces };

async function getUserProfile(userId, viewer = null, database = db._raw) {
    await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
    const user = database.prepare(`SELECT id, username, created_time, profile_widgets, (avatar_blob IS NOT NULL) AS has_avatar
        FROM User WHERE id = ?`).get(userId);
    if (!user) return null;
    let relation = viewerRelation(viewer, user.id);
    const widgets = normalizeWidgets(user.profile_widgets);
    const profile = {
        user: { id: user.id, username: user.username, has_avatar: !!user.has_avatar, created_time: user.created_time },
        relation,
        city: getUserCity(user.id),
        taste: await userTasteAxes(user.id, database),
        widgets,
        content: {}
    };
    await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
    if(!database.prepare('SELECT id FROM User WHERE id=?').get(userId))return null;
    relation=viewerRelation(viewer,user.id);profile.relation=relation;
    if (relation.blocked) return profile;
    for (const widget of new Set(widgets)) profile.content[widget] = WIDGET_LOADERS[widget](user.id, database);
    return profile;
}

function saveProfileWidgets(userId, widgets, database = db._raw) {
    if (!Array.isArray(widgets) || widgets.length !== WIDGET_SLOTS || !widgets.every((item) => PROFILE_WIDGETS.includes(item))) {
        return null;
    }
    database.prepare('UPDATE User SET profile_widgets = ? WHERE id = ?').run(JSON.stringify(widgets), userId);
    return [...widgets];
}

/** 自己被驳回的地点数：头像和“我创建的地点”上的小红点 */
function rejectedPlaceCount(userId, database = db._raw) {
    return Number(database.prepare("SELECT COUNT(*) AS n FROM Place WHERE creator_id = ? AND moderation_status = 'rejected'").get(userId)?.n) || 0;
}

module.exports = {
    PROFILE_WIDGETS,
    DEFAULT_WIDGETS,
    normalizeWidgets,
    getUserProfile,
    saveProfileWidgets,
    rejectedPlaceCount
};
