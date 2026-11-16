// Province / city lookup for places (modules/places/services/placeRegions.js) against a stand-in for
// AMap's batch regeo: places outside AMap's China cells are saved without a request, and a batch
// refused for the overseas daily quota is retried point by point so domestic places still get
// their region. Isolated SQLite file, no network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-regions-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const { refreshPendingBatch, ensurePlaceRegions } = require('../../modules/places/services/placeRegions');
const sql = db._raw;

const POINTS = {
    beijing: { lat: 39.9042, lng: 116.4074, component: { province: '北京市', city: [], district: '东城区', adcode: '110101' } },
    shanghai: { lat: 31.2304, lng: 121.4737, component: { province: '上海市', city: [], district: '黄浦区', adcode: '310101' } },
    guangzhou: { lat: 23.1291, lng: 113.2644, component: { province: '广东省', city: '广州市', district: '越秀区', adcode: '440104' } },
    // Inside AMap's China cells but a city abroad: AMap counts it against the overseas quota.
    vladivostok: { lat: 43.1155, lng: 131.8855, abroad: true },
    ussuriysk: { lat: 43.7971, lng: 131.9518, abroad: true },
    tokyo: { lat: 35.6762, lng: 139.6503 },
    seoul: { lat: 37.5665, lng: 126.978 }
};
const key = (lat, lng) => `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`;
const byLocation = new Map(Object.values(POINTS).map((point) => [key(point.lat, point.lng), point]));
const requests = [];
// Like AMap with today's overseas quota used up: any overseas point refuses the whole request.
async function fakeAmap(url) {
    const locations = new URL(url).searchParams.get('location').split('|');
    requests.push(locations);
    const points = locations.map((location) => byLocation.get(location));
    if (points.some((point) => !point || point.abroad)) {
        return { ok: true, json: async () => ({ status: '0', info: 'USER_ABROAD_DAILY_QUERY_OVER_LIMIT', infocode: '10045' }) };
    }
    return { ok: true, json: async () => ({ status: '1', regeocodes: points.map((point) => ({ addressComponent: point.component })) }) };
}
const addPlace = (name, point) => Number(sql.prepare('INSERT INTO Place (name, latitude, longitude) VALUES (?, ?, ?)').run(name, point.lat, point.lng).lastInsertRowid);
const region = (id) => sql.prepare('SELECT province, city, district, lat, lng FROM PlaceRegion WHERE place_id = ?').get(id);
const requested = (point) => requests.some((locations) => locations.includes(key(point.lat, point.lng)));

(async () => {
    await init();
    process.env.AMAP_WEB_SERVICE_KEY = 'test-key';
    const ids = {};
    for (const name of ['beijing', 'shanghai', 'guangzhou', 'vladivostok', 'tokyo']) ids[name] = addPlace(name, POINTS[name]);

    const result = await refreshPendingBatch({ fetchImpl: fakeAmap });
    assert.equal(result.checked, 5);
    assert.equal(result.skipped, 1, 'Tokyo is outside the China cells');
    assert.deepEqual(result.abroad.map((p) => p.id), [ids.vladivostok]);
    assert.deepEqual(result.rejected, []);
    assert.ok(!requested(POINTS.tokyo), 'no AMap request for a place outside the China cells');
    assert.equal(requests[0].length, 4, 'one batch for the four places inside the cells');
    assert.ok(requests.slice(1).every((locations) => locations.length === 1), 'then one by one after the overseas refusal');
    assert.deepEqual([region(ids.beijing).province, region(ids.beijing).city], ['北京市', '北京市'], 'municipality: city = province');
    assert.deepEqual([region(ids.guangzhou).province, region(ids.guangzhou).city], ['广东省', '广州市']);
    assert.equal(region(ids.shanghai).city, '上海市');
    for (const name of ['tokyo', 'vladivostok']) {
        const row = region(ids[name]);
        assert.ok(row && row.province === null, `${name}: saved as checked without a region`);
    }
    assert.deepEqual(await refreshPendingBatch({ fetchImpl: fakeAmap }), { checked: 0, more: false, rejected: [], abroad: [], skipped: 0 });

    // Every point refused one by one: maybe the key itself, so nothing is saved and it is tried again later.
    const ussuriysk = addPlace('ussuriysk', POINTS.ussuriysk);
    await assert.rejects(refreshPendingBatch({ fetchImpl: fakeAmap }), /USER_ABROAD_DAILY_QUERY_OVER_LIMIT/);
    assert.equal(region(ussuriysk), undefined);
    sql.prepare('DELETE FROM Place WHERE id = ?').run(ussuriysk);

    // A place moved abroad is looked up again, without a request, and loses its old region.
    sql.prepare('UPDATE Place SET latitude = ?, longitude = ? WHERE id = ?').run(POINTS.tokyo.lat, POINTS.tokyo.lng, ids.beijing);
    requests.length = 0;
    const moved = await refreshPendingBatch({ fetchImpl: fakeAmap });
    assert.deepEqual([moved.checked, moved.skipped, requests.length], [1, 1, 0]);
    assert.deepEqual([region(ids.beijing).province, region(ids.beijing).lat], [null, POINTS.tokyo.lat]);

    // The QQ push's on-the-spot lookup follows the same rules.
    const seoul = addPlace('seoul', POINTS.seoul);
    const guangzhou2 = addPlace('guangzhou2', { lat: 23.13, lng: 113.27 });
    byLocation.set(key(23.13, 113.27), POINTS.guangzhou);
    assert.equal(await ensurePlaceRegions([seoul, guangzhou2, ids.shanghai], { fetchImpl: fakeAmap }), 2, 'only the two never looked up');
    assert.deepEqual(requests, [[key(23.13, 113.27)]], 'Seoul sends no request');
    assert.equal(region(seoul).province, null);
    assert.equal(region(guangzhou2).city, '广州市');
    delete process.env.AMAP_WEB_SERVICE_KEY;
    assert.equal(await ensurePlaceRegions([addPlace('no key', POINTS.shanghai)], { fetchImpl: fakeAmap }), 0, 'nothing without a key');

    console.log('Place region tests passed: overseas places skipped without requests, overseas-quota refusals retried one by one, municipalities, moved places, on-the-spot lookup.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { sql.close(); } catch (_) { /* already closed */ }
    fs.rmSync(temp, { recursive: true, force: true });
});
