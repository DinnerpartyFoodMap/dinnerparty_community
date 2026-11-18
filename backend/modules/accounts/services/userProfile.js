const { db } = require('../../../infrastructure/database');
const { PLACE_COLUMNS, widgetPlace, getFavoriteCollection } = require('../../preferences/services/favoriteCollection');
const { publicPlaceSql } = require('../../places/services/placeVisibility');
const { getUserCity } = require('./userLocation');
const { viewerRelation } = require('./userRelations');
const { userTasteAxes } = require('../../preferences/services/tasteAxes');
const { avatarColumns, avatarFields } = require('./userAvatar');

// 住民主页（GET /users/:id/profile，见 ../doc/README.md）：头像、六类餐饮偏好雷达（preferences/services/tasteAxes.js）、上次定位的城市，
// 以及固定的收藏与住民自己选择的一个地点小组件。
// 地点只给公开的；屏蔽了 Ta 时只返回头部信息（用来解除屏蔽）。
const PROFILE_WIDGETS = Object.freeze(['collection', 'recent', 'favorite']);
const DEFAULT_WIDGETS = Object.freeze(['collection', 'recent']);
const CHOOSABLE_WIDGETS = ['recent', 'favorite'];
const WIDGET_PLACE_LIMIT = 5;

/** 兼容旧的两个组件选择，优先保留原第二栏里仍可选的组件。 */
function normalizeWidgets(value) {
    let list = value;
    if (typeof value === 'string') {
        try { list = JSON.parse(value); } catch (_) { list = null; }
    }
    if (!Array.isArray(list) || ![1, 2].includes(list.length) || !list.every((item) => PROFILE_WIDGETS.includes(item))) return [...DEFAULT_WIDGETS];
    const chosen = list.findLast((item) => CHOOSABLE_WIDGETS.includes(item));
    return ['collection', chosen || DEFAULT_WIDGETS[1]];
}

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

const WIDGET_LOADERS = { recent: recentPlaces, favorite: favoritePlaces };

async function getUserProfile(userId, viewer = null, database = db._raw) {
    const user = database.prepare(`SELECT id, username, created_time, profile_widgets, ${avatarColumns()}
        FROM User WHERE id = ?`).get(userId);
    if (!user) return null;
    let relation = viewerRelation(viewer, user.id);
    const widgets = normalizeWidgets(user.profile_widgets);
    const profile = {
        user: { id: user.id, username: user.username, ...avatarFields(user), created_time: user.created_time },
        relation,
        city: getUserCity(user.id),
        taste: await userTasteAxes(user.id, database),
        widgets,
        content: {}
    };
    try {
        await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
    } catch (error) {
        // Cached rating labels are optional on the homepage.
        if (error.status !== 409 && error.status !== 503) throw error;
    }
    if(!database.prepare('SELECT id FROM User WHERE id=?').get(userId))return null;
    relation=viewerRelation(viewer,user.id);profile.relation=relation;
    if (!relation.self) {
        // The radar can show aggregate preferences without disclosing favorites or browsing history.
        profile.taste = profile.taste.map((axis) => ({
            ...axis,
            favorite_count: 0,
            sources: axis.sources.filter((source) => source !== 'favorite'),
            places: relation.blocked ? [] : axis.places.filter((place) => place.rating != null)
                .map(({ favorite, ...place }) => place)
        }));
    }
    if (relation.blocked) return profile;
    const collection = getFavoriteCollection(user.id, viewer?.id, { limit: WIDGET_PLACE_LIMIT, database });
    profile.content.collection = collection ? [{ id: 'favorites', title: '我的收藏', total: collection.total, places: collection.places }] : [];
    profile.content[widgets[1]] = WIDGET_LOADERS[widgets[1]](user.id, database);
    if (relation.self && collection) profile.collection_visibility = collection.is_public;
    return profile;
}

function saveProfileWidgets(userId, widgets, database = db._raw) {
    if (!Array.isArray(widgets) || ![1, 2].includes(widgets.length) || !widgets.every((item) => PROFILE_WIDGETS.includes(item))) {
        return null;
    }
    const selection = normalizeWidgets(widgets);
    database.prepare('UPDATE User SET profile_widgets = ? WHERE id = ?').run(JSON.stringify(selection), userId);
    return selection;
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
