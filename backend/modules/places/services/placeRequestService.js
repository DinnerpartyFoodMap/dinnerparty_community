const { db } = require('../../../infrastructure/database');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { normalizeImageUrls } = require('../../media/services/imageUrls');
const { normalizePlaceCoordinates, normalizePlaceDescription } = require('./placeService');

function placeRequestFailure(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.publicMessage = message;
    return error;
}

const createTransaction = db._raw.transaction(({ placeId, requesterId, proposed, note }) => {
    if (!db._raw.prepare('SELECT id FROM Place WHERE id = ?').get(placeId)) {
        throw placeRequestFailure(404, 'PLACE_NOT_FOUND', '地点不存在');
    }
    const coordinates = normalizePlaceCoordinates(proposed);
    if (coordinates.error) throw placeRequestFailure(400, 'INVALID_PLACE_COORDINATE', coordinates.error);
    // 描述与直接编辑相同：最多 1000 字，接受 HTML
    let description = {};
    if (proposed.description !== undefined) {
        const normalized = normalizePlaceDescription(proposed.description);
        if (normalized.error) throw placeRequestFailure(400, 'INVALID_PLACE_DESCRIPTION', normalized.error);
        description = { description: normalized.value };
    }
    const normalizedProposed = {
        ...proposed,
        ...coordinates.value,
        ...description,
        ...(proposed.exterior_images !== undefined
            ? { exterior_images: normalizeImageUrls(proposed.exterior_images) }
            : {}),
        ...(proposed.menu_images !== undefined
            ? { menu_images: normalizeImageUrls(proposed.menu_images) }
            : {})
    };
    const info = db._raw.prepare(
        'INSERT INTO PlaceRequest (place_id, requester_id, proposed, note) VALUES (?, ?, ?, ?)'
    ).run(placeId, requesterId, JSON.stringify(normalizedProposed), note || '');
    const row = db._raw.prepare('SELECT * FROM PlaceRequest WHERE id = ?').get(info.lastInsertRowid);
    insertAdminAction(
        requesterId,
        'place-request-created',
        null,
        JSON.stringify({
            place_id: Number(placeId),
            request_id: row.id,
            proposed_fields: Object.keys(normalizedProposed).sort()
        })
    );
    return row;
});

function createPlaceRequest({ placeId, requesterId, proposed, note }) {
    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
        throw placeRequestFailure(400, 'INVALID_PLACE_REQUEST', '缺少参数或 proposed 格式错误');
    }
    return createTransaction.immediate({ placeId, requesterId, proposed, note });
}

module.exports = { createPlaceRequest, placeRequestFailure };
