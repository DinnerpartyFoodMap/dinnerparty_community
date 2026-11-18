const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-check-ins-'));
Object.assign(process.env, {
    DB_FILE: path.join(temp, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false',
    SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '', RESOURCE_PACK_DIR: path.join(temp, 'packs')
});
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');

async function main() {
    init();
    const checkIns = require('../../modules/places/services/placeCheckIns');
    const companions = require('../../modules/skins/services/companionState');
    db._raw.prepare("INSERT INTO User(id, username, password) VALUES('a', 'a', 'x'),('b', 'b', 'x')").run();
    const add = db._raw.prepare("INSERT INTO Place(id, name, latitude, longitude, moderation_status) VALUES(?, '店', 0, 110, 'visible')");
    for (let id = 1; id <= 6; id++) add.run(id);
    const now = Date.parse('2026-11-19T15:59:59Z');
    const fix = { lat: 0, lng: 110, source: 'browser', coordSystem: 'GCJ-02', accuracy: 5, timestamp: now };
    const cmd = (id, overrides = {}) => ({ request_id: `checkin-request-${id}`, fix, ...overrides });
    const submit = (id, body = cmd(id), time = now) => checkIns.createCheckIn('a', id, body, time);
    const move = meters => meters / 6371000 * 180 / Math.PI;
    assert.throws(() => submit(1, cmd(1, { fix: { ...fix, lat: move(50) } })), { code: 'CHECK_IN_TOO_FAR' });
    assert.throws(() => submit(1, cmd(1, { fix: { ...fix, source: 'ip' } })), { code: 'CHECK_IN_LOCATION_INVALID' });
    assert.throws(() => submit(1, cmd(1, { fix: { ...fix, timestamp: now - 16000 } })), { code: 'CHECK_IN_LOCATION_INVALID' });
    const first = submit(1, cmd(1, { fix: { ...fix, lat: move(49.99) } }));
    assert.equal(first.satiety, 1);
    assert.equal(submit(1, cmd(1), now + 90000).id, first.id);
    assert.deepEqual(companions.getCompanionState('a'), { active: 'stick-figure', satiety: 1 });
    assert.throws(() => submit(1, cmd('other')), { code: 'CHECK_IN_DUPLICATE' });
    submit(2, cmd(2, { fix: { ...fix, source: 'native', timestamp: now - 0.25 } }));
    for (let id = 3; id <= 5; id++) submit(id);
    assert.throws(() => submit(6), { code: 'CHECK_IN_QUOTA' });
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRating').get().n, 0);
    fs.mkdirSync(process.env.RESOURCE_PACK_DIR);
    fs.writeFileSync(path.join(process.env.RESOURCE_PACK_DIR, 'catalog.json'), JSON.stringify({ companions: [
        { id: 'test-character', name: '测试角色', version: '1', entry: 'character.model3.json' }
    ] }));
    db._raw.prepare('INSERT INTO UserCompanion (user_id, companion_id, unlocked_time) VALUES (?, ?, ?)')
        .run('a', 'test-character', new Date(now).toISOString());
    companions.setActiveCompanion('a', 'test-character');
    assert.equal(submit(6, cmd(6, { fix: { ...fix, timestamp: now + 2000 } }), now + 2000).satiety, 1);
    assert.deepEqual(companions.getCompanionState('a'), { active: 'test-character', satiety: 1 });
    companions.setActiveCompanion('a', 'stick-figure');
    assert.equal(companions.getCompanionState('a').satiety, 5);
    db._raw.prepare("UPDATE Place SET description='原有介绍' WHERE id=1").run();
    const image = { bytes: Buffer.from('example bytes'), contentType: 'image/png' };
    const reviewed = checkIns.createCheckIn('b', 1, cmd('reviewed', { description: '一份补充', score: 4 }), now, [image, image]);
    const followup = createNextDayReview();
    function createNextDayReview() {
        const later = now + 2000;
        return checkIns.createCheckIn('b', 1, cmd('followup', { description: '另一份补充', fix: { ...fix, timestamp: later } }), later);
    }
    const requests = id => db._raw.prepare(`SELECT p.*,r.kind FROM PlaceRequest p JOIN PlaceCheckInRequest r ON p.id=r.request_id
        WHERE r.checkin_id=? ORDER BY p.id`).all(id);
    const [description, photo] = requests(reviewed.id);
    const url = JSON.parse(photo.proposed).checkin_images[0];
    const photoId = url.split('/').pop();
    assert.equal(checkIns.readPhoto(photoId), undefined);
    const preview = new URL(checkIns.photoPreviewUrl(url, now), 'https://example.org');
    assert.equal(checkIns.readPhoto(photoId, preview.searchParams.get('expires'), preview.searchParams.get('token'), now).content_type, 'image/png');
    const approve = request => db._raw.transaction(() => checkIns.applyCheckInReview(request, 'approve', 'a')).immediate();
    approve(requests(followup.id)[0]);
    approve(description);
    approve(photo);
    const place = db._raw.prepare('SELECT description,checkin_images FROM Place WHERE id=1').get();
    assert.equal(place.description, '原有介绍\n\n另一份补充\n\n一份补充');
    assert.deepEqual(JSON.parse(place.checkin_images), [url]);
    assert.equal(checkIns.readPhoto(photoId).content_type, 'image/png');
    const { checkInWeights, checkInMultiplier } = require('../../modules/ratings/services/checkInRatingWeights');
    assert.equal(checkInMultiplier(checkInWeights(), 1, 'b'), 1.1, 'approved content needs its own saved rating');
    db._raw.prepare("INSERT INTO RatingStream (user_id,place_id,revision) VALUES ('b',1,8)").run();
    db._raw.prepare("INSERT INTO RatingCommand VALUES ('b',?,'fake',1,'rate',8,?)").run(checkIns.ratingRequestId(reviewed.id), now);
    assert.equal(checkIns.persistCheckInRating('b', reviewed.id, 1, 4), true);
    assert.equal(checkInMultiplier(checkInWeights(), 1, 'b'), 1.3);
    db._raw.prepare("UPDATE RatingStream SET revision=9 WHERE user_id='b' AND place_id=1").run();
    assert.equal(checkInMultiplier(checkInWeights(), 1, 'b'), 1.1, 'an obsolete rating revision loses the content bonus');
    assert.throws(() => approve(description), { code: 'PLACE_REQUEST_ALREADY_REVIEWED' });

    add.run(7);
    add.run(8);
    db._raw.prepare("UPDATE User SET admin_level='YUYUKO' WHERE id='a'").run();
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    const server = await new Promise(resolve => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const auth = user => ({ Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET || 'yuyuko_secret_key')}` });
        const post = (user, endpoint, body) => fetch(base + endpoint, {
            method: 'POST', headers: { ...auth(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const onlineFix = { ...fix, timestamp: Date.now() };
        const [one, two] = await Promise.all([
            post('b', '/places/7/check-ins', cmd('network-dupe', { fix: onlineFix, description: '待审核' })),
            post('b', '/places/7/check-ins', cmd('network-dupe', { fix: onlineFix, description: '待审核' }))
        ]);
        assert.deepEqual([one.status, two.status], [200, 200]);
        const [receipt, repeated] = await Promise.all([one.json(), two.json()]);
        assert.equal(receipt.id, repeated.id);
        assert.equal(receipt.satiety, repeated.satiety);
        const replay = await post('b', '/places/7/check-ins', cmd('network-dupe', { fix: undefined, description: '待审核' }));
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).id, receipt.id);
        const denied = await post('b', '/places/7/check-ins', cmd('network-new-request', { fix: onlineFix }));
        assert.equal(denied.status, 409);
        const pending = requests(receipt.id)[0];
        assert.equal((await post('b', `/place-requests/${pending.id}/review`, { action: 'approve' })).status, 403);
        assert.equal((await post('a', `/place-requests/${pending.id}/review`, { action: 'reject' })).status, 200);
        assert.equal(db._raw.prepare('SELECT description FROM Place WHERE id=7').get().description, null);
        assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceCheckIn WHERE place_id=7').get().n, 1);

        if (process.env.NUMERIC_ALGORITHM_SERVICE_URL) {
            const form = new FormData();
            const png = await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: '#884400' } }).png().toBuffer();
            form.append('payload', JSON.stringify(cmd('online-rated', { fix: { ...fix, timestamp: Date.now() }, score: 4, description: '评分补充' })));
            form.append('photos', new Blob([png], { type: 'image/png' }), 'picture.png');
            const response = await fetch(base + '/places/8/check-ins', { method: 'POST', headers: auth('b'), body: form });
            assert.equal(response.status, 200);
            const rated = await response.json();
            assert.equal(rated.rating_saved, true, rated.rating_error);
            const summarize = require('../../modules/ratings/services/ratingSummaryAdapter');
            const [textRequest, photoRequest] = requests(rated.id);
            const imageUrl = JSON.parse(photoRequest.proposed).checkin_images[0];
            assert.equal((await fetch(base + imageUrl)).status, 404);
            const reviewList = await (await fetch(base + '/place-requests', { headers: auth('a') })).json();
            const signedUrl = reviewList.find(item => item.id === photoRequest.id).photo_previews[0];
            assert.equal((await fetch(base + signedUrl)).status, 200);
            const before = summarize.readRatings().find(row => row.place_id === 8 && row.user_id === 'b').weight;
            assert.equal((await post('a', `/place-requests/${textRequest.id}/review`, { action: 'approve' })).status, 200);
            const after = summarize.readRatings().find(row => row.place_id === 8 && row.user_id === 'b').weight;
            assert.ok(after > before);
            assert.equal((await post('a', `/place-requests/${photoRequest.id}/review`, { action: 'approve' })).status, 200);
            assert.equal((await fetch(base + imageUrl)).status, 200);
            assert.equal((await summarize.ratingSummary(8)).count, 1);

            add.run(11);
            const ratedBody = cmd('atomic-rating-link', { fix: { ...fix, timestamp: Date.now() }, score: 3 });
            db._raw.exec(`CREATE TRIGGER test_fail_rating_link BEFORE UPDATE OF rating_revision ON PlaceCheckIn
                WHEN OLD.place_id=11 BEGIN SELECT RAISE(ABORT, 'injected rating link failure'); END;`);
            const pendingRating = await (await post('b', '/places/11/check-ins', ratedBody)).json();
            assert.equal(pendingRating.rating_saved, false);
            assert.equal(db._raw.prepare("SELECT 1 FROM PlaceRating WHERE place_id=11 AND user_id='b'").get(), undefined);
            assert.equal(db._raw.prepare('SELECT 1 FROM RatingCommand WHERE request_id=?').get(checkIns.ratingRequestId(pendingRating.id)), undefined);
            db._raw.exec('DROP TRIGGER test_fail_rating_link');
            const withoutLocation = { ...ratedBody, fix: undefined };
            const retried = await (await post('b', '/places/11/check-ins', withoutLocation)).json();
            assert.equal(retried.id, pendingRating.id);
            assert.equal(retried.satiety, pendingRating.satiety);
            assert.equal(retried.rating_saved, true);
            const revision = db._raw.prepare('SELECT rating_revision FROM PlaceCheckIn WHERE id=?').get(retried.id).rating_revision;
            assert.ok(revision > 0);
            db._raw.prepare('UPDATE PlaceCheckIn SET rating_revision=NULL WHERE id=?').run(retried.id);
            const recovered = await (await post('b', '/places/11/check-ins', withoutLocation)).json();
            assert.equal(recovered.rating_saved, true);
            assert.equal(db._raw.prepare('SELECT rating_revision FROM PlaceCheckIn WHERE id=?').get(retried.id).rating_revision, revision);
        }
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    const { initPlaceCheckInSchema } = require('../../modules/places/services/placeCheckInSchema');
    db._raw.exec('DROP TRIGGER IF EXISTS PlaceCheckIn_remove_pending_requests');
    initPlaceCheckInSchema(db._raw);
    initPlaceCheckInSchema(db._raw);
    db._raw.prepare("INSERT INTO User(id, username, password) VALUES('removed','removed','x')").run();
    add.run(9);
    add.run(10);
    const byRemovedUser = checkIns.createCheckIn('removed', 9, cmd('delete-user', { description: '用户删除后待审提议清理' }), now);
    const atRemovedPlace = checkIns.createCheckIn('b', 10, cmd('delete-place', { description: '地点删除后待审提议清理' }), now);
    const userRequest = requests(byRemovedUser.id)[0].id;
    const placeRequest = requests(atRemovedPlace.id)[0].id;
    db._raw.prepare("DELETE FROM User WHERE id='removed'").run();
    db._raw.prepare('DELETE FROM Place WHERE id=10').run();
    assert.equal(db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRequest WHERE id IN (?,?)').get(userRequest, placeRequest).n, 0);
    console.log('Check-in location, quota, idempotency, feeding, review and rating weight passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    db._raw.close();
    fs.rmSync(temp, { recursive: true, force: true });
});
