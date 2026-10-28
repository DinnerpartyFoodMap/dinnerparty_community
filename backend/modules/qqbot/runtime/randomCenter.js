const { db } = require('../../../infrastructure/database');
const { normalizeLocation } = require('../../accounts/services/userLocation');
const { fastSearch } = require('../../discovery/services/placeSearch');

// Per-group centre for !随机 (table QQBotGroupRandomCenter, one row per group).
// Set in the group with `!随机中心 <店名 | 展会 | 纬度,经度 名称>` by the group's owner/admins
// or a site admin, or through /admin/qq-bot/random-centers. Coordinates are GCJ-02, as on places.
const LABEL_MAX_LENGTH = 40;
const SOURCES = new Set(['place', 'exhibition', 'coordinates', 'admin']);
// "纬度,经度 名称"; a comma is required so a keyword like "7 11" stays a place search.
const COORDINATE_ARGUMENT = /^(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)(?:\s+(.+))?$/;

function cleanLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LENGTH);
}

function rowToCenter(row) {
    return row ? {
        groupId: row.group_id, lat: row.latitude, lng: row.longitude, label: row.label, source: row.source,
        placeId: row.place_id, setBy: row.set_by, updatedAt: row.updated_at
    } : null;
}

function getGroupCenter(groupId) {
    if (!groupId) return null;
    return rowToCenter(db._raw.prepare('SELECT * FROM QQBotGroupRandomCenter WHERE group_id = ?').get(String(groupId)));
}

function listGroupCenters() {
    return db._raw.prepare('SELECT * FROM QQBotGroupRandomCenter ORDER BY group_id').all().map(rowToCenter);
}

/** Saves (overwrites) a group's centre; returns it, or null for invalid input. */
function setGroupCenter(groupId, { lat, lng, label, source, placeId = null }, setBy, now = new Date()) {
    const location = normalizeLocation(lat, lng);
    const name = cleanLabel(label);
    if (!groupId || !location || !name || !SOURCES.has(source)) return null;
    db._raw.prepare(`INSERT INTO QQBotGroupRandomCenter (group_id, latitude, longitude, label, source, place_id, set_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude, label = excluded.label,
            source = excluded.source, place_id = excluded.place_id, set_by = excluded.set_by, updated_at = excluded.updated_at`)
        .run(String(groupId), location.lat, location.lng, name, source, placeId, setBy ? String(setBy) : null, now.toISOString());
    return getGroupCenter(groupId);
}

function clearGroupCenter(groupId) {
    return db._raw.prepare('DELETE FROM QQBotGroupRandomCenter WHERE group_id = ?').run(String(groupId)).changes > 0;
}

/**
 * Turns the text after !随机中心 into a centre: "纬度,经度 名称", "展会" (the current
 * exhibition's venue) or a keyword matched against marked places (first !查询 result).
 * Returns { lat, lng, label, source, placeId? } or { error }.
 */
async function resolveCenterArgument(value) {
    const text = String(value || '').trim();
    const coordinates = text.match(COORDINATE_ARGUMENT);
    if (coordinates) {
        const location = normalizeLocation(coordinates[1], coordinates[2]);
        if (!location) return { error: '坐标无效。格式：!随机中心 纬度,经度 名称（GCJ-02，例如 23.016488,113.394404 B记鱼粥）。' };
        return { ...location, label: cleanLabel(coordinates[3]) || `${location.lat.toFixed(5)},${location.lng.toFixed(5)}`, source: 'coordinates' };
    }
    if (text === '展会' || text === '当前展会') {
        const exhibition = db._raw.prepare('SELECT name, location_name, latitude, longitude FROM SiteExhibition WHERE is_active = 1 ORDER BY event_time IS NULL, event_time, id LIMIT 1').get();
        const location = exhibition && normalizeLocation(exhibition.latitude, exhibition.longitude);
        if (!location) return { error: exhibition ? `当前展会「${cleanLabel(exhibition.name)}」没有设置地点。` : '当前没有进行中的展会。' };
        return { ...location, label: cleanLabel(exhibition.location_name) || cleanLabel(exhibition.name), source: 'exhibition' };
    }
    const place = (await fastSearch(text, 1))[0];
    const location = place && normalizeLocation(place.latitude, place.longitude);
    if (!location) {
        return { error: `没有找到与「${cleanLabel(text)}」相关的已收录地点。换个关键词，或发送 !随机中心 纬度,经度 名称。` };
    }
    return { ...location, label: cleanLabel(place.name), source: 'place', placeId: place.id };
}

module.exports = { getGroupCenter, listGroupCenters, setGroupCenter, clearGroupCenter, resolveCenterArgument, LABEL_MAX_LENGTH };
