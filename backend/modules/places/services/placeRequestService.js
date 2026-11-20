const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { normalizeImageUrls } = require('../../media/services/imageUrls');
const { normalizePlaceCoordinates, normalizePlaceDescription } = require('./placeService');
const { isPublicPlace } = require('./placeVisibility');

function placeRequestFailure(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.publicMessage = message;
    return error;
}

// 修改申请能改的内容字段。所有者（creator_id）与最近修改人 / 时间（updated_by / updated_time）
// 不在其中：提交时剔除，批准时由服务端写成申请人（routes/placeRequests.js）
const PLACE_REQUEST_FIELDS = Object.freeze([
    'name', 'description', 'latitude', 'longitude', 'category',
    'exterior_images', 'menu_images', 'per_person_cost'
]);

const createTransaction = db._raw.transaction(({ placeId, requesterId, proposed, note, moderation, rating, noExperience }) => {
    const place = db._raw.prepare('SELECT * FROM Place WHERE id = ?').get(placeId);
    // 初筛中 / 待复核的地点对其他住民不存在（创建者本人直接编辑，不走申请）
    if (!place || (!isPublicPlace(place) && String(place.creator_id) !== String(requesterId))) {
        throw placeRequestFailure(404, 'PLACE_NOT_FOUND', '地点不存在');
    }
    require('../../accounts/services/userAccess').requireWritableUser(requesterId);
    const coordinates = normalizePlaceCoordinates(proposed);
    if (coordinates.error) throw placeRequestFailure(400, 'INVALID_PLACE_COORDINATE', coordinates.error);
    // 描述与直接编辑相同：最多 1000 字，接受 HTML
    let description = {};
    if (proposed.description !== undefined) {
        const normalized = normalizePlaceDescription(proposed.description);
        if (normalized.error) throw placeRequestFailure(400, 'INVALID_PLACE_DESCRIPTION', normalized.error);
        description = { description: normalized.value };
    }
    const content = Object.fromEntries(Object.entries(proposed).filter(([key]) => PLACE_REQUEST_FIELDS.includes(key)));
    if (!Object.keys(content).length) throw placeRequestFailure(400, 'EMPTY_PLACE_REQUEST', '没有可修改的内容');
    const normalizedProposed = {
        ...content,
        ...coordinates.value,
        ...description,
        ...(proposed.exterior_images !== undefined
            ? { exterior_images: normalizeImageUrls(proposed.exterior_images) }
            : {}),
        ...(proposed.menu_images !== undefined
            ? { menu_images: normalizeImageUrls(proposed.menu_images) }
            : {})
    };
    const intent=require('./placeEditRating').prepareEditRating(requesterId,Number(placeId),{rating,noExperience});
    // 同一住民对同一地点只保留最新一条待审修改：之前未审的标成 superseded（不删，管理页历史里仍可查）。
    // 新增复核（create）和打卡（check_in）申请不受影响
    const superseded = db._raw.prepare(`SELECT id FROM PlaceRequest
        WHERE place_id = ? AND requester_id = ? AND status = 'pending' AND request_type = 'modify'`)
        .all(place.id, requesterId).map((row) => row.id);
    if (superseded.length) {
        db._raw.prepare(`UPDATE PlaceRequest SET status = 'superseded', reviewed_time = CURRENT_TIMESTAMP
            WHERE id IN (${superseded.map(() => '?').join(',')}) AND status = 'pending'`).run(...superseded);
    }
    // moderation：创建者的修改被 AI 初筛拦下时附上的报告（placeModeration.checkOwnerEdit），管理页显示拦截原因
    const info = db._raw.prepare(
        'INSERT INTO PlaceRequest (place_id, requester_id, proposed, note, moderation,submitted_at_ms,research_consent_id,edit_rating,edit_base_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(placeId, requesterId, JSON.stringify(normalizedProposed), note || '', moderation ? JSON.stringify(moderation) : null,Date.now(),require('../../ratings/services/ratingEvidence').researchConsent(requesterId)?.id||null,JSON.stringify(intent),JSON.stringify(place));
    const row = db._raw.prepare('SELECT * FROM PlaceRequest WHERE id = ?').get(info.lastInsertRowid);
    insertAdminAction(
        requesterId,
        'place-request-created',
        null,
        JSON.stringify({
            place_id: Number(placeId),
            request_id: row.id,
            proposed_fields: Object.keys(normalizedProposed).sort(),
            ...(superseded.length ? { superseded_request_ids: superseded } : {}),
            ...(moderation ? { held_by_moderation: moderation.decision.reasons } : {})
        })
    );
    return row;
});

function createPlaceRequest({ placeId, requesterId, proposed, note, moderation = null, rating, noExperience=false }) {
    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
        throw placeRequestFailure(400, 'INVALID_PLACE_REQUEST', '缺少参数或 proposed 格式错误');
    }
    return createTransaction.immediate({ placeId, requesterId, proposed, note, moderation, rating, noExperience });
}

module.exports = { createPlaceRequest, placeRequestFailure, PLACE_REQUEST_FIELDS };
