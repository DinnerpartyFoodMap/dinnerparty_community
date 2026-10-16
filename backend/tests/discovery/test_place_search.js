// Real SQLite/HTTP regressions for keyword ranking; no external services or live data.
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-search-'));
process.env.DB_FILE = path.join(temporaryDirectory, 'search.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
const { db, init } = require('../../infrastructure/database');
const { fastSearch } = require('../../modules/discovery/services/placeSearch');
const searchRouter = require('../../modules/discovery/routes/search');
init();
const sql = db._raw;
const center = { lat: 23.1291, lng: 113.2644 };

beforeEach(() => sql.exec('BEGIN'));
afterEach(() => sql.exec('ROLLBACK'));
after(() => {
    db.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function add(name, {
    category = '烧烤', description = '', lat = center.lat, lng = center.lng,
    created = '2026-01-01 00:00:00'
} = {}) {
    return Number(sql.prepare(`INSERT INTO Place (name, category, description, latitude, longitude, created_time)
        VALUES (?, ?, ?, ?, ?, ?)`).run(name, category, description, lat, lng, created).lastInsertRowid);
}

function rate(placeId, score, { user = 'search-rater', banned = 0 } = {}) {
    sql.prepare('INSERT OR IGNORE INTO User (id, username, password, is_banned) VALUES (?, ?, ?, ?)')
        .run(user, user, 'unused', banned);
    sql.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at)
        VALUES (?, ?, ?, 'user', 0, 0)`).run(placeId, user, score);
}

test('nearby category matches survive a page full of newer remote name matches', () => {
    const nearby = add('家门口羊肉串', { created: '2020-01-01', lat: 23.131 });
    for (let i = 0; i < 40; i += 1) add(`远方烧烤${i}`, { lat: 39.9, lng: 116.4 });
    const results = fastSearch('烧烤', 3, { center });
    assert.equal(results.length, 3);
    assert.equal(results[0].id, nearby);
});

test('proximity breaks comparable text matches before creation time', () => {
    const near = add('同名烧烤', { lat: 23.13, created: '2020-01-01' });
    add('同名烧烤', { lat: 39.9, lng: 116.4, created: '2026-10-15' });
    assert.equal(fastSearch('烧烤', 5, { center })[0].id, near);
});

test('city-scale category relevance outweighs a short restaurant name in a remote city', () => {
    const local = add('城内羊肉串', { lat: 23.3 });
    add('鲜烧烤', { lat: 39.9, lng: 116.4 });
    assert.equal(fastSearch('烧烤', 5, { center })[0].id, local);
});

test('regional name matches stay ahead of slightly shorter cross-country names', () => {
    const regional = add('附近的长名字烧烤小店', { lat: center.lat + 0.45 });
    add('鲜烧烤', { lat: 39.9, lng: 116.4 });
    assert.equal(fastSearch('烧烤', 5, { center })[0].id, regional);
});

test('an exact restaurant name remains reachable across cities', () => {
    const exact = add('远山炭火烧烤', { lat: 39.9, lng: 116.4 });
    add('远山炭火烧烤分店');
    assert.equal(fastSearch('远山炭火烧烤', 5, { center })[0].id, exact);
});

test('nearby description mentions do not override direct category relevance', () => {
    const direct = add('认真做烤串', { lat: 39.9, lng: 116.4 });
    add('奶茶铺', { category: '奶茶', description: '旁边有一家烧烤' });
    assert.equal(fastSearch('烧烤', 5, { center })[0].id, direct);
});

test('a category substring stays ahead of nearby description-only mentions', () => {
    const direct = add('认真做烤串', { category: '烧烤店', lat: 39.9, lng: 116.4 });
    add('奶茶铺', { category: '奶茶', description: '旁边有一家烧烤' });
    assert.equal(fastSearch('烧烤', 5, { center })[0].id, direct);
});

test('avoided places move behind ordinary matches without disappearing', () => {
    const warning = add('网红烧烤', { category: '避雷' });
    const ordinary = add('朴素羊肉串', { lat: 23.14 });
    const results = fastSearch('烧烤', 5, { center });
    assert.deepEqual(results.map(row => row.id), [ordinary, warning]);
});

test('an exact avoided restaurant name can still be looked up', () => {
    const warning = add('网红烧烤', { category: '避雷' });
    add('网红烧烤分店');
    assert.equal(fastSearch('网红烧烤', 5, { center })[0].id, warning);
});

test('warning ranking follows current ratings rather than stale tags', () => {
    const recovered = add('恢复口碑烧烤', { category: '烧烤, 避雷' });
    const negative = add('评分低的烧烤');
    rate(recovered, 4);
    rate(negative, 1);
    assert.deepEqual(fastSearch('烧烤', 5, { center }).map(row => row.id), [recovered, negative]);
});

test('explicit warning search finds rating-based warnings without a tag', () => {
    const negative = add('评分低的烧烤');
    const tagged = add('传统避雷烧烤', { category: '烧烤, 避雷' });
    const recovered = add('恢复口碑烧烤', { category: '烧烤, 避雷' });
    rate(negative, 1);
    rate(recovered, 4);
    const warningIds = fastSearch('避雷', 5, { center }).map(row => row.id);
    assert.deepEqual(new Set(warningIds), new Set([negative, tagged]));
    assert.deepEqual(new Set(fastSearch('烧烤 避雷', 5, { center }).map(row => row.id)), new Set([negative, tagged]));
});

test('a 2.5 average and banned ratings do not mark a place avoided', () => {
    const boundary = add('边界烧烤', { category: '避雷' });
    rate(boundary, 2);
    rate(boundary, 3, { user: 'second-rater' });
    const banned = add('普通烧烤');
    rate(banned, 1, { user: 'banned-rater', banned: 1 });
    assert.deepEqual(fastSearch('避雷', 5), []);
});

test('all query terms may match different fields, but none can be dropped', () => {
    const matches = add('阿明炭火店', { description: '深夜营业' });
    add('阿明炭火店二店', { description: '白天营业' });
    add('深夜便利店', { category: '便利店' });
    assert.deepEqual(fastSearch('深夜 烧烤', 5, { center }).map(row => row.id), [matches]);
});

test('fullwidth input, Latin case and restaurant punctuation are normalized', () => {
    const match = add('ABC Cafe（西城店）', { category: '咖啡' });
    assert.deepEqual(fastSearch('ａｂｃ cafe(西城店)', 5).map(row => row.id), [match]);
    assert.deepEqual(fastSearch('ＡＢＣ，咖啡', 5).map(row => row.id), [match]);
});

test('missing or invalid location earns no distance bonus, while zero is valid', () => {
    const valid = add('同款烧烤', { lat: 0, lng: 0, created: '2020-01-01' });
    add('同款烧烤', { lat: null, lng: null, created: '2026-01-01' });
    add('同款烧烤', { lat: 91, lng: 181, created: '2026-02-01' });
    const results = fastSearch('烧烤', 5, { center: { lat: 0, lng: 0 } });
    assert.equal(results[0].id, valid);
    assert.equal(results[0].distance_km, 0);
    assert.ok(results.slice(1).every(row => row.distance_km === null));
});

test('no-center and invalid-center searches retain text relevance and stable ties', () => {
    const exact = add('拉面王', { category: '' });
    const name = add('拉面王二店', { category: '' });
    const tag = add('乙店', { category: '拉面王' });
    const older = add('甲店', { category: '', description: '拉面王', created: '2025-01-01' });
    const newer = add('丙店', { category: '', description: '拉面王', created: '2026-01-01' });
    const ids = [exact, name, tag, newer, older];
    assert.deepEqual(fastSearch('拉面王', 5).map(row => row.id), ids);
    for (const invalid of [{ lat: 99, lng: 113 }, { lat: 23 }, { lat: '', lng: '' },
        { lat: ' ', lng: ' ' }, { lat: false, lng: false }]) {
        const results = fastSearch('拉面王', 5, { center: invalid });
        assert.deepEqual(results.map(row => row.id), ids);
        assert.ok(results.every(row => !Object.hasOwn(row, 'distance_km')));
    }
});

test('newest tie-breaking parses legacy dates and then uses stable IDs', () => {
    const older = add('普通甲店', { created: '9/13/2024 12:00:00' });
    const newer = add('普通乙店', { created: '2026-01-01 00:00:00' });
    const newestId = add('普通丙店', { created: '2026-01-01 00:00:00' });
    assert.deepEqual(fastSearch('烧烤', 5).map(row => row.id), [newestId, newer, older]);
});

test('creation time ties use SQLite UTC and legacy China time regardless of server zone', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
        const sqlite = add('甲店', { created: '2026-01-01 00:00:00' });
        const explicitUtc = add('乙店', { created: '2025-12-31T20:00:00Z' });
        const legacy = add('丙店', { created: '1/1/2026 3:00:00' });
        assert.deepEqual(fastSearch('烧烤', 5).map(row => row.id), [sqlite, explicitUtc, legacy]);
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test('empty and unmatched inputs return no results', () => {
    add('烧烤店');
    for (const query of ['', '   ', '%', '_', '不存在的食物', "' OR 1=1 --"]) {
        assert.deepEqual(fastSearch(query, 5, { center }), []);
    }
});

test('both HTTP aliases forward center before selecting the limited results', async () => {
    const near = add('附近羊肉串', { created: '2020-01-01' });
    add('远处烧烤', { lat: 39.9, lng: 116.4 });
    const app = express();
    app.use('/api', searchRouter);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        for (const route of ['/api/places/search/fast', '/api/places/search']) {
            const params = new URLSearchParams({ q: '烧烤', lat: String(center.lat), lng: String(center.lng), limit: '1' });
            const response = await fetch(`http://127.0.0.1:${server.address().port}${route}?${params}`);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('server-timing'), /sqlite;dur=/);
            const rows = await response.json();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].id, near);
            assert.equal(rows[0].distance_km, 0);
            assert.ok(Object.hasOwn(rows[0], 'creator_name'));
            assert.ok(Object.hasOwn(rows[0], 'rating_count'));
        }
        const invalidParams = new URLSearchParams({ q: '烧烤', lat: ' ', lng: ' ', limit: '1' });
        const invalidResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/places/search/fast?${invalidParams}`);
        const invalidRows = await invalidResponse.json();
        assert.ok(invalidRows.every(row => !Object.hasOwn(row, 'distance_km')), 'blank coordinates must not become (0, 0)');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
