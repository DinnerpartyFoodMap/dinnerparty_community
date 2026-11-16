// AMap's China cell table exists on both sides (frontend/src/platform/chinaRegion.js for the map,
// modules/maps/services/chinaRegion.js before AMap Web-service calls): every 1° cell must agree.
// Also: the "last located in" city lookup sends no request for an overseas point. No network access.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isInAmapChinaRegion } = require('../../modules/maps/services/chinaRegion');
const { reverseGeocodeCity } = require('../../modules/maps/services/amapRegeo');

(async () => {
    const frontend = await import(pathToFileURL(path.join(__dirname, '../../../frontend/src/platform/chinaRegion.js')).href);
    let inside = 0;
    for (let lat = -90; lat < 90; lat++) {
        for (let lng = -180; lng < 180; lng++) {
            const backend = isInAmapChinaRegion(lng + 0.5, lat + 0.5);
            assert.equal(backend, frontend.isInAmapChinaRegion(lng + 0.5, lat + 0.5), `cell lat ${lat}, lng ${lng}`);
            if (backend) inside++;
        }
    }
    assert.ok(inside > 500, 'the table is not empty');
    const known = [
        ['北京', 116.4074, 39.9042, true], ['上海', 121.4737, 31.2304, true], ['香港', 114.1694, 22.3193, true],
        ['台北', 121.5654, 25.033, true], ['海参崴（境内格子，境外城市）', 131.8855, 43.1155, true],
        ['东京', 139.6503, 35.6762, false], ['首尔', 126.978, 37.5665, false], ['河内', 105.8542, 21.0285, false],
        ['新加坡', 103.8198, 1.3521, false], ['纽约', -74.006, 40.7128, false]
    ];
    for (const [name, lng, lat, expected] of known) assert.equal(isInAmapChinaRegion(lng, lat), expected, name);
    assert.equal(isInAmapChinaRegion(NaN, 30), false);

    const previousKey = process.env.AMAP_WEB_SERVICE_KEY;
    process.env.AMAP_WEB_SERVICE_KEY = 'test-key';
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        return { ok: true, json: async () => ({ status: '1', regeocode: { addressComponent: { province: '北京市', city: [] } } }) };
    };
    try {
        assert.equal(await reverseGeocodeCity(35.6762, 139.6503, { fetchImpl }), null, 'Tokyo: no city');
        assert.equal(calls.length, 0, 'and no request');
        assert.equal(await reverseGeocodeCity(39.9042, 116.4074, { fetchImpl }), '北京市');
        assert.equal(calls.length, 1);
    } finally {
        if (previousKey == null) delete process.env.AMAP_WEB_SERVICE_KEY;
        else process.env.AMAP_WEB_SERVICE_KEY = previousKey;
    }
    console.log(`China region checks passed: ${inside} cells agree with the frontend table; overseas city lookups send no request.`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
