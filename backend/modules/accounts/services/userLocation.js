const { db } = require('../../../infrastructure/database');

// The last position a user located themselves at: the map's locate button
// (web/App) or a QQ location card sent to the bot. Only one row per user is
// kept and every report overwrites it; there is no location history. The QQ
// bot's !随机 uses it as the centre of the 5 km random pick.
const SOURCES = new Set(['web', 'qq']);

function initUserLocationSchema(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS UserLastLocation (
        user_id TEXT PRIMARY KEY REFERENCES User(id) ON DELETE CASCADE,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        label TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
}

function coordinate(value, bound) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= bound ? number : null;
}

/** GCJ-02 inside China, as the map and QQ cards report it. 0,0 is an empty fix, never a position. */
function normalizeLocation(lat, lng) {
    const latitude = coordinate(lat, 90);
    const longitude = coordinate(lng, 180);
    if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return null;
    return { lat: latitude, lng: longitude };
}

function saveUserLocation(userId, { lat, lng, label = '', source }, now = new Date()) {
    const location = normalizeLocation(lat, lng);
    if (!userId || !location || !SOURCES.has(source)) return false;
    db._raw.prepare(`INSERT INTO UserLastLocation (user_id, latitude, longitude, label, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude,
            label = excluded.label, source = excluded.source, updated_at = excluded.updated_at`)
        .run(userId, location.lat, location.lng, String(label || '').trim().slice(0, 120) || null, source, now.toISOString());
    return true;
}

function getUserLocation(userId) {
    if (!userId) return null;
    const row = db._raw.prepare('SELECT latitude, longitude, label, source, updated_at FROM UserLastLocation WHERE user_id = ?').get(userId);
    return row ? { lat: row.latitude, lng: row.longitude, label: row.label || '', source: row.source, updatedAt: row.updated_at } : null;
}

module.exports = { initUserLocationSchema, normalizeLocation, saveUserLocation, getUserLocation };
