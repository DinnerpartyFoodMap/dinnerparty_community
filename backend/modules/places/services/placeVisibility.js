const { hasPermission } = require('../../admin/services/adminPermissions');

// 新增地点初筛的可见性（见 doc/placeModeration.md）：只有 visible 对所有人公开，
// checking / pending / rejected 只给创建者本人和有 manage_places 的管理员看。
const PUBLIC_STATUS = 'visible';
const HIDDEN_STATUSES = ['checking', 'pending', 'rejected'];

/** SQL 条件：只要公开的地点。用于搜索推荐、分享页、QQ 推送等不认人的入口 */
function publicPlaceSql(alias = 'p') {
    return `${alias}.moderation_status = '${PUBLIC_STATUS}'`;
}

/** SQL 条件：公开的，或观看者自己创建的；参数是观看者 id（游客传 null） */
function viewerPlaceSql(alias = 'p') {
    return `(${alias}.moderation_status = '${PUBLIC_STATUS}' OR ${alias}.creator_id = ?)`;
}

function isPublicPlace(place) {
    return !place || !place.moderation_status || place.moderation_status === PUBLIC_STATUS;
}

/** 单个地点：公开、观看者是创建者，或观看者有 manage_places */
function canViewPlace(place, viewer) {
    if (!place) return false;
    if (isPublicPlace(place)) return true;
    if (!viewer) return false;
    return String(place.creator_id) === String(viewer.id) || hasPermission(viewer, 'manage_places');
}

module.exports = { PUBLIC_STATUS, HIDDEN_STATUSES, publicPlaceSql, viewerPlaceSql, isPublicPlace, canViewPlace };
