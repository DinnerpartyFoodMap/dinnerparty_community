const { db } = require('../../../infrastructure/database');
const { normalizeImageUrls } = require('../../media/services/imageUrls');
const { enqueuePlaceCreatedNotifications, wakeNotificationWorker } = require('./placeNotifications');
const { RATING_COLUMNS_SQL, isValidScore, defaultCreationScore, insertCreationRating } = require('../../ratings/services/placeRatings');

// Shared validation and creation for every path that adds a marker (web/App,
// QQ Bot, public diaries). Insertion is synchronous so callers can run it
// inside their own SQLite transaction; network work happens only after commit.
const PLACE_NAME_MAX_LENGTH = 120;
const PLACE_CATEGORY_MAX_LENGTH = 240;
const PLACE_DESCRIPTION_MAX_LENGTH = 1000;
const PLACE_ADDRESS_MAX_LENGTH = 250;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;
// The map (Web Mercator) ends at ±85.0511°. Clicking the blank area beyond it still yields
// 85°–90°, and the frontend marker layer drops such points (cluster/engine.js
// MAX_MERCATOR_LAT), so a place saved there could never be shown or selected.
const PLACE_MAX_LATITUDE = 85.0511;
const LATITUDE_RULE = { fieldLabel: '纬度', min: -PLACE_MAX_LATITUDE, max: PLACE_MAX_LATITUDE };
const LONGITUDE_RULE = { fieldLabel: '经度', min: -180, max: 180 };

const PLACE_WITH_NAMES_SQL = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE p.id = ?`;

function parseCategoryNames(value) {
    return String(value || '')
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item, index, items) => items.indexOf(item) === index);
}

function getCategoryNameLength(value) {
    return Array.from(value).reduce((length, character) => (
        length + (character.codePointAt(0) > 0x7f ? 2 : 1)
    ), 0);
}

function normalizeCategoryList(value) {
    const names = parseCategoryNames(value);
    const invalidName = names.find((name) => /[,，]/.test(name) || HTML_TAG_PATTERN.test(name) || getCategoryNameLength(name) > 16);
    if (invalidName) {
        return { error: `分类“${invalidName}”不能超过8个汉字或16个英文字符，且仅支持纯文本` };
    }
    return { value: names.join(', '), names };
}

// allowHtml：只给地点描述用。描述按 Markdown（含 HTML）显示，网页由 DOMPurify 按白名单清理后才插入，
// 不能显示格式的地方（分享页、QQ 机器人等）先转成纯文字，所以保存时不必拒绝 HTML；
// 店名、分类、地址等字段会被直接拼进各种文字与卡片，仍只接受纯文本。
function normalizePlainTextField(value, {
    fieldLabel,
    maxLength,
    required = false,
    allowHtml = false
}) {
    if (value == null || value === '') {
        if (required) {
            return { error: `${fieldLabel}不能为空` };
        }
        return { value: '' };
    }

    if (typeof value !== 'string') {
        return { error: `${fieldLabel}必须是字符串` };
    }

    const normalized = value.trim();
    if (required && !normalized) {
        return { error: `${fieldLabel}不能为空` };
    }
    if (normalized.length > maxLength) {
        return { error: `${fieldLabel}不能超过 ${maxLength} 个字符` };
    }
    if (!allowHtml && HTML_TAG_PATTERN.test(normalized)) {
        return { error: `${fieldLabel}仅支持纯文本` };
    }
    return { value: normalized };
}

/** 地点描述：去首尾空白、最多 1000 字，接受 Markdown 与 HTML（显示前会清理或转纯文字）。新增、编辑、修改申请与 QQ 机器人共用 */
function normalizePlaceDescription(value) {
    return normalizePlainTextField(value, { fieldLabel: '描述', maxLength: PLACE_DESCRIPTION_MAX_LENGTH, allowHtml: true });
}

// Strict: null, '', booleans and arrays are rejected instead of becoming 0.
function normalizeCoordinate(value, {
    fieldLabel,
    min,
    max
}) {
    const isNumericString = typeof value === 'string' && value.trim() !== '';
    if (typeof value !== 'number' && !isNumericString) {
        return { error: `${fieldLabel}必须是有效数字` };
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return { error: `${fieldLabel}必须是有效数字` };
    }
    if (numericValue < min || numericValue > max) {
        return { error: `${fieldLabel}超出有效范围` };
    }
    return { value: numericValue };
}

/** Validates whichever of latitude/longitude is present (edits and modification requests). */
function normalizePlaceCoordinates(input = {}) {
    const value = {};
    for (const [key, rule] of [['latitude', LATITUDE_RULE], ['longitude', LONGITUDE_RULE]]) {
        if (input[key] === undefined) continue;
        const coordinate = normalizeCoordinate(input[key], rule);
        if (coordinate.error) return coordinate;
        value[key] = coordinate.value;
    }
    return { value };
}

// Optional positive integer. Decimals are rejected instead of truncated.
function normalizePerPersonCost(value) {
    if (value === null || value === undefined || value === '') return { value: null };
    let numericValue = NaN;
    if (typeof value === 'number') numericValue = value;
    else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
        return { error: '人均价格需为正整数' };
    }
    return { value: numericValue };
}

/**
 * Validates a new place. Returns { value } with normalized fields or { error }.
 * `address` is optional; image arrays are passed through the existing URL normalizer.
 */
function validateNewPlace(input = {}) {
    const name = normalizePlainTextField(input.name, { fieldLabel: '名称', maxLength: PLACE_NAME_MAX_LENGTH, required: true });
    if (name.error) return name;
    const category = normalizePlainTextField(input.category, { fieldLabel: '分类', maxLength: PLACE_CATEGORY_MAX_LENGTH });
    if (category.error) return category;
    const categoryList = normalizeCategoryList(category.value);
    if (categoryList.error) return categoryList;
    const description = normalizePlaceDescription(input.description);
    if (description.error) return description;
    const address = normalizePlainTextField(input.address, { fieldLabel: '地址', maxLength: PLACE_ADDRESS_MAX_LENGTH });
    if (address.error) return address;
    const latitude = normalizeCoordinate(input.latitude, LATITUDE_RULE);
    if (latitude.error) return latitude;
    const longitude = normalizeCoordinate(input.longitude, LONGITUDE_RULE);
    if (longitude.error) return longitude;
    const cost = normalizePerPersonCost(input.per_person_cost);
    if (cost.error) return cost;
    // The creator's own rating; without one, 避雷 → 强烈拒绝 and anything else → 强烈推荐.
    const rating = input.rating === undefined || input.rating === null
        ? defaultCreationScore(categoryList.names)
        : input.rating;
    if (!isValidScore(rating)) return { error: '评价无效' };
    return {
        value: {
            name: name.value,
            description: description.value,
            address: address.value || null,
            latitude: latitude.value,
            longitude: longitude.value,
            category: categoryList.value,
            categoryNames: categoryList.names,
            per_person_cost: cost.value,
            rating,
            exterior_images: input.exterior_images ? JSON.stringify(normalizeImageUrls(input.exterior_images)) : null,
            menu_images: input.menu_images ? JSON.stringify(normalizeImageUrls(input.menu_images)) : null
        }
    };
}

function syncCategoryRegistry(names, creatorId) {
    if (!Array.isArray(names) || names.length === 0) return;
    const insert = db._raw.prepare(
        `INSERT OR IGNORE INTO Category (name, is_common, sort_order, created_by)
         VALUES (?, 0, 1000, ?)`
    );
    db._raw.transaction((items) => {
        items.forEach((name) => insert.run(name, creatorId || null));
    })(names);
}

/**
 * Inserts a validated place, its categories, the creator's rating and its new-place notifications.
 * Must be called inside a transaction (or wrapped by createPlace) so all rows
 * commit or roll back together. Performs no network work.
 */
function insertPlaceSync(place, creatorId, { source }) {
    syncCategoryRegistry(place.categoryNames, creatorId);
    const info = db._raw.prepare(`INSERT INTO Place (name, description, latitude, longitude, category, exterior_images, menu_images,
                                      per_person_cost, address, creator_id, updated_time, updated_by)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`).run(
        place.name,
        place.description,
        place.latitude,
        place.longitude,
        place.category,
        place.exterior_images || null,
        place.menu_images || null,
        place.per_person_cost,
        place.address || null,
        creatorId,
        creatorId
    );
    const placeId = Number(info.lastInsertRowid);
    insertCreationRating(placeId, creatorId, place.rating ?? defaultCreationScore(place.categoryNames));
    enqueuePlaceCreatedNotifications([placeId], { source });
    return placeId;
}

// Follow-up work for committed new places: vector refresh and notification delivery.
function afterPlacesCreated(placeIds) {
    const ids = (placeIds || []).filter((id) => Number.isSafeInteger(Number(id)));
    if (!ids.length) return;
    setImmediate(() => {
        try {
            const { queuePlaceVectorSync } = require('../../preferences/services/placeVectorService');
            ids.forEach((id) => queuePlaceVectorSync(id));
        } catch (_) { /* the vector retry worker picks it up later */ }
        wakeNotificationWorker();
    });
}

function getPlaceWithNames(placeId) {
    return db._raw.prepare(PLACE_WITH_NAMES_SQL).get(placeId) || null;
}

/** Validates and creates a place in its own transaction. Throws { status, publicMessage } on invalid input. */
function createPlace(input, creatorId, { source }) {
    const validated = validateNewPlace(input);
    if (validated.error) {
        throw Object.assign(new Error(validated.error), { status: 400, publicMessage: validated.error });
    }
    const placeId = db._raw.transaction(() => insertPlaceSync(validated.value, creatorId, { source })).immediate();
    afterPlacesCreated([placeId]);
    return getPlaceWithNames(placeId);
}

module.exports = {
    PLACE_NAME_MAX_LENGTH,
    PLACE_CATEGORY_MAX_LENGTH,
    PLACE_DESCRIPTION_MAX_LENGTH,
    PLACE_MAX_LATITUDE,
    HTML_TAG_PATTERN,
    parseCategoryNames,
    getCategoryNameLength,
    normalizeCategoryList,
    normalizePlainTextField,
    normalizePlaceDescription,
    normalizeCoordinate,
    normalizePlaceCoordinates,
    normalizePerPersonCost,
    validateNewPlace,
    syncCategoryRegistry,
    insertPlaceSync,
    afterPlacesCreated,
    getPlaceWithNames,
    createPlace
};
