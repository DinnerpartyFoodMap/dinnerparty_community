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
    const tagged = normalizeListFilter({ tags: '火锅店,烧烤,小吃', excludeTags: '小吃,连锁店' });
    assert.deepEqual([tagged.tags, tagged.excludeTags], [['火锅店', '烧烤'], ['小吃', '连锁店']], 'a tag in both lists counts as excluded');
    assert.equal(matchesFilter({ category: '烧烤' }, tagged), true, 'green tags: any one matches');
    assert.equal(matchesFilter({ category: '烧烤, 连锁店' }, tagged), false, 'red tags: any one excludes');
    assert.equal(matchesFilter({ category: '粤菜' }, tagged), false);
    const excludeOnly = normalizeListFilter({ excludeTags: '避雷' });
    assert.equal(matchesFilter({ category: '粤菜' }, excludeOnly), true, 'only red tags: everything else stays');
    assert.equal(matchesFilter({ category: '粤菜, 避雷' }, excludeOnly), false);
    console.log('500m normalization, nearby/distant and include/exclude tag filtering passed.');
} finally {
    db._raw.close();
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
