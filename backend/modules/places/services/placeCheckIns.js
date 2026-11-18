const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { db } = require('../../../infrastructure/database');
const { requireWritableUser } = require('../../accounts/services/userAccess');
const { feedCompanionSync } = require('../../skins/services/companionState');
const { insertAdminAction } = require('../../admin/services/adminAudit');
const { normalizePlaceDescription } = require('./placeService');

const MAX_PER_DAY = 5;
const RADIUS_M = 50;
const MAX_FIX_AGE_MS = 15000;
const MAX_ACCURACY_M = 25;
const EARTH_RADIUS_M = 6371000;
const PHOTO_PREVIEW_KEY = process.env.JWT_SECRET || randomBytes(32);
const PHOTO_PATH = '/places/check-in-photos/';

function fail(status, code, publicMessage) {
    throw Object.assign(new Error(publicMessage), { status, code, publicMessage });
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function validCoordinate(value, bound) {
    return Number.isFinite(value) && Math.abs(value) <= bound;
}

function distanceMeters(place, fix) {
    const radians = Math.PI / 180;
    const deltaLatitude = (place.latitude - fix.lat) * radians;
    const deltaLongitude = (place.longitude - fix.lng) * radians;
    const area = Math.sin(deltaLatitude / 2) ** 2
        + Math.cos(fix.lat * radians) * Math.cos(place.latitude * radians) * Math.sin(deltaLongitude / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, area)));
}

function verifyLocation(place, fix, now) {
    if (!fix || !['native', 'browser'].includes(fix.source) || fix.coordSystem !== 'GCJ-02'
        || !validCoordinate(fix.lat, 90) || !validCoordinate(fix.lng, 180)
        || !Number.isFinite(fix.accuracy) || fix.accuracy <= 0 || fix.accuracy > MAX_ACCURACY_M
        || !Number.isFinite(fix.timestamp) || fix.timestamp > now || now - fix.timestamp > MAX_FIX_AGE_MS) {
        fail(400, 'CHECK_IN_LOCATION_INVALID', '请重新获取当前精确位置后再打卡');
    }
    if (!validCoordinate(place.latitude, 90) || !validCoordinate(place.longitude, 180)
        || (place.latitude === 0 && place.longitude === 0)) {
        fail(409, 'CHECK_IN_PLACE_LOCATION_MISSING', '地点尚未设置有效坐标');
    }
    if (distanceMeters(place, fix) >= RADIUS_M - Number.EPSILON * RADIUS_M) {
        fail(403, 'CHECK_IN_TOO_FAR', '距离地点需小于 50 米才可打卡');
    }
}

function localDay(now) {
    return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function createReview(checkIn, kind, proposed) {
    const result = db._raw.prepare(`INSERT INTO PlaceRequest
        (place_id, requester_id, proposed, note, request_type, submitted_at_ms)
        VALUES (?, ?, ?, ?, 'check_in', ?)`).run(checkIn.place_id, checkIn.user_id, JSON.stringify(proposed),
        kind === 'description' ? '打卡补充描述' : '打卡补充照片', checkIn.created_at_ms);
    const id = Number(result.lastInsertRowid);
    db._raw.prepare('INSERT INTO PlaceCheckInRequest VALUES (?, ?, ?)').run(id, checkIn.id, kind);
    insertAdminAction(checkIn.user_id, 'place-request-submitted', null,
        JSON.stringify({ place_id: checkIn.place_id, request_id: id, checkin_id: checkIn.id }));
}

function checkInView(row) {
    const reviews = db._raw.prepare(`SELECT r.kind, p.status FROM PlaceCheckInRequest r
        JOIN PlaceRequest p ON p.id=r.request_id WHERE r.checkin_id=?`).all(row.id);
    return {
        id: row.id, place_id: row.place_id, created_at_ms: row.created_at_ms,
        companion_id: row.companion_id, satiety: row.satiety, score: row.score,
        rating_base_revision: row.rating_base_revision,
        checkin_count: db._raw.prepare(`SELECT COUNT(*) AS count FROM PlaceCheckIn c JOIN User u ON u.id=c.user_id
            WHERE c.place_id=? AND COALESCE(u.is_banned,0)=0`).get(row.place_id).count,
        rating_saved: row.rating_revision !== null,
        reviews: Object.fromEntries(reviews.map(({ kind, status }) => [kind, status]))
    };
}

const createTransaction = db._raw.transaction(({ userId, placeId, requestId, inputHash, fix, description, score, photos, now }) => {
    requireWritableUser(userId);
    const previous = db._raw.prepare('SELECT * FROM PlaceCheckIn WHERE user_id=? AND request_id=?').get(userId, requestId);
    if (previous) {
        if (previous.input_hash !== inputHash) fail(409, 'CHECK_IN_REQUEST_REUSED', '此请求编号已用于另一条打卡');
        return checkInView(previous);
    }
    const place = db._raw.prepare(`SELECT p.* FROM Place p WHERE p.id=? AND p.moderation_status='visible'
        AND NOT EXISTS (SELECT 1 FROM UserBlock b WHERE b.user_id=? AND b.blocked_id=p.creator_id)`).get(placeId, userId);
    if (!place) fail(404, 'CHECK_IN_PLACE_NOT_FOUND', '地点不存在');
    verifyLocation(place, fix, now);
    const day = localDay(now);
    const todaysPlaces = db._raw.prepare('SELECT place_id FROM PlaceCheckIn WHERE user_id=? AND local_day=?').all(userId, day);
    if (todaysPlaces.some(item => item.place_id === placeId)) fail(409, 'CHECK_IN_DUPLICATE', '今天已经在这里打过卡了');
    if (todaysPlaces.length >= MAX_PER_DAY) fail(429, 'CHECK_IN_QUOTA', '每日最多打卡 5 家店');

    const companion = feedCompanionSync(userId);
    const ratingBaseRevision = score === null ? 0 : db._raw.prepare('SELECT revision FROM RatingStream WHERE user_id=? AND place_id=?')
        .get(userId, placeId)?.revision || 0;
    const row = { id: randomUUID(), user_id: userId, place_id: placeId, created_at_ms: now,
        companion_id: companion.active, satiety: companion.satiety, score, rating_base_revision: ratingBaseRevision, rating_revision: null };
    db._raw.prepare(`INSERT INTO PlaceCheckIn
        (id,user_id,place_id,request_id,input_hash,local_day,created_at_ms,companion_id,satiety,score,rating_base_revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, userId, placeId, requestId, inputHash, day, now, companion.active, companion.satiety, score, ratingBaseRevision);
    if (description) createReview(row, 'description', { description });
    if (photos.length) {
        const insert = db._raw.prepare('INSERT INTO PlaceCheckInPhoto (id,checkin_id,hash,content_type,bytes) VALUES (?,?,?,?,?)');
        const ids = photos.map(photo => {
            const id = randomUUID();
            insert.run(id, row.id, photo.hash, photo.contentType, photo.bytes);
            return id;
        });
        createReview(row, 'photos', { checkin_images: ids.map(id => PHOTO_PATH + id) });
    }
    return checkInView(row);
});

function createCheckIn(userId, placeId, body, now = Date.now(), images = []) {
    const { request_id: requestId, fix, score = null } = body || {};
    if (!Number.isSafeInteger(placeId) || placeId < 1) fail(400, 'CHECK_IN_PLACE_INVALID', '无效地点');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) {
        fail(400, 'CHECK_IN_REQUEST_INVALID', '打卡编号无效');
    }
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 4)) {
        fail(400, 'CHECK_IN_SCORE_INVALID', '请选择一个评价');
    }
    const inputDescription = body?.description ?? '';
    if (typeof inputDescription !== 'string') fail(400, 'CHECK_IN_DESCRIPTION_INVALID', '描述格式无效');
    const normalized = normalizePlaceDescription(inputDescription.trim());
    if (normalized.error) fail(400, 'CHECK_IN_DESCRIPTION_INVALID', normalized.error);
    const description = normalized.value;
    const photos = Array.from(new Map(images.map(image => {
        const digest = hash(image.bytes);
        return [digest, { ...image, hash: digest }];
    })).values());
    const inputHash = hash(JSON.stringify([placeId, score, description, photos.map(photo => photo.hash)]));
    return createTransaction.immediate({ userId, placeId, requestId, inputHash, fix, description, score, photos, now });
}

function ratingRequestId(checkInId) {
    return `checkin_${checkInId}`;
}

// The caller owns the RatingCommand transaction, including recovery of an existing command.
function persistCheckInRating(userId, checkInId, placeId, score) {
    const command = db._raw.prepare(`SELECT r.committed_revision,c.rating_revision FROM RatingCommand r JOIN PlaceCheckIn c
        ON c.user_id=r.user_id AND c.place_id=r.place_id
        WHERE c.id=? AND r.user_id=? AND c.place_id=? AND c.score=? AND r.request_id=? AND r.action='rate'`)
        .get(checkInId, userId, placeId, score, ratingRequestId(checkInId));
    if (!(command?.committed_revision > 0)) return false;
    if (command.rating_revision !== null) return command.committed_revision === command.rating_revision;
    return db._raw.prepare('UPDATE PlaceCheckIn SET rating_revision=? WHERE id=? AND rating_revision IS NULL')
        .run(command.committed_revision, checkInId).changes === 1;
}

function previewSignature(id, expires) {
    return createHmac('sha256', PHOTO_PREVIEW_KEY).update(`foodmap-check-in-photo:${id}:${expires}`).digest('hex');
}

function photoPreviewUrl(url, now = Date.now()) {
    if (!url?.startsWith(PHOTO_PATH)) return null;
    const id = url.slice(PHOTO_PATH.length);
    const expires = now + 15 * 60 * 1000;
    return `${url}?expires=${expires}&token=${previewSignature(id, expires)}`;
}

function readPhoto(id, expires, token, now = Date.now()) {
    const expiration = Number(expires);
    const preview = Number.isSafeInteger(expiration) && expiration >= now
        && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
        && timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(previewSignature(id, expiration), 'hex'));
    return db._raw.prepare(`SELECT f.content_type,f.bytes,f.approved FROM PlaceCheckInPhoto f
        JOIN PlaceCheckIn c ON c.id=f.checkin_id JOIN Place p ON p.id=c.place_id
        WHERE f.id=? AND p.moderation_status='visible'
        AND ((f.approved=1 AND EXISTS(SELECT 1 FROM json_each(p.checkin_images) WHERE value=?)) OR ?)`)
        .get(id, PHOTO_PATH + id, Number(Boolean(preview)));
}

function applyCheckInReview(request, action, adminId) {
    const linked = db._raw.prepare(`SELECT r.kind,c.id,c.place_id,c.user_id FROM PlaceCheckInRequest r
        JOIN PlaceCheckIn c ON c.id=r.checkin_id WHERE r.request_id=?`).get(request.id);
    const before = linked && db._raw.prepare('SELECT * FROM Place WHERE id=?').get(linked.place_id);
    if (!linked || !before || (action === 'approve' && before.moderation_status !== 'visible')) {
        fail(409, 'CHECK_IN_REVIEW_TARGET_MISSING', '打卡对应的地点已隐藏或删除');
    }
    let semanticChanged = false;
    let field = null;
    let value = null;
    if (action === 'reject') {
        if (linked.kind === 'photos') db._raw.prepare('DELETE FROM PlaceCheckInPhoto WHERE checkin_id=?').run(linked.id);
    } else if (linked.kind === 'description') {
        const { description } = JSON.parse(request.proposed);
        const current = (before.description || '').trim();
        if (description && !`\n\n${current}\n\n`.includes(`\n\n${description}\n\n`)) {
            const merged = normalizePlaceDescription([current, description].filter(Boolean).join('\n\n'));
            if (merged.error) fail(409, 'CHECK_IN_DESCRIPTION_OVERFLOW', merged.error);
            field = 'description';
            value = merged.value;
            semanticChanged = true;
            db._raw.prepare('UPDATE PlaceCheckIn SET description_approved=1 WHERE id=?').run(linked.id);
        }
    } else {
        const existing = before.checkin_images ? JSON.parse(before.checkin_images) : [];
        const approvedHashes = db._raw.prepare(`SELECT hash FROM PlaceCheckInPhoto f JOIN PlaceCheckIn c
            ON c.id=f.checkin_id WHERE c.place_id=? AND f.approved=1`).all(linked.place_id);
        const seen = new Set(approvedHashes.map(photo => photo.hash));
        const staged = db._raw.prepare('SELECT id,hash FROM PlaceCheckInPhoto WHERE checkin_id=? ORDER BY rowid').all(linked.id);
        const publish = db._raw.prepare('UPDATE PlaceCheckInPhoto SET approved=1 WHERE id=?');
        const remove = db._raw.prepare('DELETE FROM PlaceCheckInPhoto WHERE id=?');
        const uploaded = [];
        for (const photo of staged) {
            if (seen.has(photo.hash)) {
                remove.run(photo.id);
            } else {
                publish.run(photo.id);
                uploaded.push(PHOTO_PATH + photo.id);
            }
        }
        if (uploaded.length) {
            field = 'checkin_images';
            value = JSON.stringify([...existing, ...uploaded]);
            db._raw.prepare('UPDATE PlaceCheckIn SET photos_approved=1 WHERE id=?').run(linked.id);
        }
    }
    if (field) {
        const update = semanticChanged ? 'description=?,has_vector=0' : 'checkin_images=?';
        db._raw.prepare(`UPDATE Place SET ${update},updated_time=CURRENT_TIMESTAMP,updated_by=? WHERE id=?`)
            .run(value, linked.user_id, linked.place_id);
        require('./placeRevisions').recordPlaceRevision({ placeId: linked.place_id, authorId: linked.user_id, executorId: adminId,
            path: 'check_in_approved', before, requestId: request.id, recordedAt: request.submitted_at_ms, noExperience: false });
    }
    const reviewed = db._raw.prepare(`UPDATE PlaceRequest SET status=?,reviewed_by=?,reviewed_time=CURRENT_TIMESTAMP
        WHERE id=? AND status='pending'`).run(action === 'approve' ? 'approved' : 'rejected', adminId, request.id);
    if (!reviewed.changes) fail(409, 'PLACE_REQUEST_ALREADY_REVIEWED', '此申请已被处理');
    insertAdminAction(adminId, 'place-request-review', linked.user_id,
        JSON.stringify({ request_id: request.id, checkin_id: linked.id, action, applied: field ? [field] : [] }));
    return { action, placeId: linked.place_id, semanticChanged };
}

module.exports = { createCheckIn, ratingRequestId, persistCheckInRating, applyCheckInReview, readPhoto, photoPreviewUrl, distanceMeters };
