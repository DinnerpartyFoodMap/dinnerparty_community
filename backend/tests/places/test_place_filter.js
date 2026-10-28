// Distance filtering does not require the optional private ranking service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-distance-filter-'));
process.env.DB_FILE = path.join(temporaryRoot, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
const { db } = require('../../infrastructure/database');
const { RADIUS_OPTIONS_KM, normalizeListFilter, matchesFilter } = require('../../modules/places/services/placeList');
try {
    assert.deepEqual([...RADIUS_OPTIONS_KM], [0.5, 1, 3, 5, 10]);
    const filter = normalizeListFilter({ lat: '23.13', lng: '113.26', radiusKm: '0.5' });
    assert.equal(filter.distance.radiusKm, 0.5);
    assert.equal(matchesFilter({ latitude: 23.131, longitude: 113.26 }, filter), true);
    assert.equal(matchesFilter({ latitude: 23.14, longitude: 113.26 }, filter), false);
    assert.equal(normalizeListFilter({ lat: '', lng: '113.26', radiusKm: '0.5' }).distance, null);
    console.log('500m normalization and nearby/distant place filtering passed.');
} finally {
    db._raw.close();
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
