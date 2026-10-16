const assert = require('assert/strict');
const { timeDecay, calculateReputations } = require('../../modules/ratings/services/ratingWeightModel');

// Pure fixtures only: this script must never open the application's database.
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 15);
const tests = [];
const test = (name, run) => tests.push({ name, run });
function near(actual, expected, label, tolerance = 1e-11) {
    assert.ok(Number.isFinite(actual), `${label}: expected a finite value, received ${actual}`);
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, received ${actual}`);
}
const user = (id, is_banned = 0) => ({ id, is_banned });
const place = (id, creator_id = 'owner', extra = {}) => ({
    id, creator_id, description: '', category: '其他', per_person_cost: 0, ...extra
});
const rating = (place_id, user_id, score, source = 'user', updated_at = NOW) => ({
    place_id, user_id, score, source, updated_at
});
function fixture(extra = {}) {
    return { users: [], places: [], ratings: [], favorites: [], requests: [], ...extra };
}
function threeRaters(scores = [3, 3, 3], extra = {}) {
    return fixture({
        users: ['a', 'b', 'c', 'owner'].map(id => user(id)),
        places: [place(1)],
        ratings: ['a', 'b', 'c'].map((id, index) => rating(1, id, scores[index])),
        ...extra
    });
}

test('time decay has a thirty-day plateau, continuous ages and a valid epoch', () => {
    near(timeDecay(NOW, NOW), 1, 'new rating');
    near(timeDecay(NOW + DAY, NOW), 1, 'future timestamp');
    near(timeDecay(NOW - 30 * DAY, NOW), 1, 'thirty days');
    near(timeDecay(NOW - 31 * DAY, NOW), 0.99633570483095, 'thirty-one days');
    near(timeDecay(NOW - 365 * DAY, NOW), 0.8327088274349121, 'one year');
    near(timeDecay(NOW - 1825 * DAY, NOW), 0.7829049627815136, 'five years');
    near(timeDecay(NOW - 960 * DAY, NOW), 0.8, 'log base is thirty-one');
    near(timeDecay(0, 365 * DAY), 0.8327088274349121, 'epoch is not a missing date');
    assert.ok(timeDecay(NOW - 30.5 * DAY, NOW) < 1, 'fractional days must not be floored');
});

test('empty evidence gives the neutral prior and banned users have no row', () => {
    const rows = calculateReputations(fixture({ users: [user('a'), user('banned', 1)] }), NOW);
    assert.ok(rows instanceof Map);
    assert.equal(rows.size, 1);
    const a = rows.get('a');
    assert.equal(a.user_id, 'a');
    near(a.contribution, 0, 'P');
    near(a.beta, 0.5, 'beta');
    near(a.agreement, 0.8, 'A');
    near(a.gamma, 1, 'gamma');
    near(a.weight, 0.5, 'W');
    near(a.evidence, 0, 'evidence');
    assert.equal(a.rating_count, 0);
    assert.ok(!rows.has('banned'));
});

test('contribution uses existing places, other live users and approved requests', () => {
    const data = fixture({
        users: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => user(id)).concat(user('banned', 1)),
        places: [place(1, 'a', {
            description: '好'.repeat(80), category: '面食', per_person_cost: 30,
            exterior_images: '["/uploads/exterior.jpg"]'
        }), place(2, 'b')],
        ratings: [rating(1, 'a', 4, 'create'), rating(1, 'b', 3), rating(1, 'c', 2),
            rating(1, 'banned', 4), rating(1, 'deleted-user', 4), rating(2, 'a', 4),
            rating(999, 'a', 4)],
        favorites: ['a', 'b', 'c', 'd', 'e', 'f', 'banned', 'deleted-user']
            .map(user_id => ({ user_id, place_id: 1 })),
        requests: [
            { requester_id: 'a', status: 'approved' }, { requester_id: 'a', status: 'approved' },
            { requester_id: 'a', status: 'pending' }, { requester_id: 'a', status: 'rejected' },
            { requester_id: 'b', status: 'approved' }
        ]
    });
    const a = calculateReputations(data, NOW).get('a');
    // C=1, f=5, m=2; P=.3+.4*(5/10)+.3*ln(3)+.1+2*.5.
    near(a.contribution, 1.929583686600433, 'P');
    near(a.beta, 0.6600864362238028, 'beta');
    near(a.gamma, 1, 'creator ratings are not consistency evidence');
    near(a.weight, 0.6600864362238028, 'W');
});

test('contribution caps foreign rated places at thirty and approved requests at ten', () => {
    const data = fixture({
        users: [user('a'), user('owner')],
        places: Array.from({ length: 31 }, (_, index) => place(index + 1)),
        ratings: Array.from({ length: 31 }, (_, index) => rating(index + 1, 'a', 3)),
        requests: Array.from({ length: 11 }, () => ({ requester_id: 'a', status: 'approved' }))
    });
    const a = calculateReputations(data, NOW).get('a');
    near(a.contribution, 8, 'P caps');
    near(a.beta, 0.8990517410026723, 'beta with P=8');
    near(a.gamma, 1, 'no consensus evidence');
});

test('empty image JSON is not a photograph and a real image adds the image component', () => {
    const data = fixture({ users: [user('a')], places: [place(1, 'a', {
        exterior_images: '[]', menu_images: 'null'
    })] });
    near(calculateReputations(data, NOW).get('a').contribution, 0, 'empty image fields');
    data.places[0].menu_images = '["/uploads/menu.jpg"]';
    near(calculateReputations(data, NOW).get('a').contribution, 0.06, 'C=.2, place term=.3*C');
});

test('three agreeing active raters give one half-unit of evidence', () => {
    const rows = calculateReputations(threeRaters(), NOW);
    for (const id of ['a', 'b', 'c']) {
        const row = rows.get(id);
        assert.equal(row.rating_count, 1);
        near(row.evidence, 0.5, `${id}: k=2`);
        near(row.agreement, 0.8181818181818182, `${id}: A=9/11`);
        near(row.gamma, 1.0459710743801653, `${id}: gamma=(45/44)^2`);
    }
});

test('evidence uses the other active rater count rather than reputation-weighted headcount', () => {
    const data = threeRaters();
    data.users.push(user('d'));
    data.ratings.push(rating(1, 'd', 3));
    data.requests.push({ requester_id: 'd', status: 'approved' });
    const a = calculateReputations(data, NOW).get('a');
    near(a.evidence, 0.6, 'k=3 gives c=3/5');
    near(a.agreement, 0.8214285714285714, 'A');
    near(a.gamma, 1.0542889030612244, 'gamma');
});

test('creation and migration ratings do not supply active consistency evidence', () => {
    for (const source of ['create', 'migration']) {
        const data = threeRaters();
        data.ratings[2].source = source;
        const rows = calculateReputations(data, NOW);
        for (const id of ['a', 'b', 'c']) {
            assert.equal(rows.get(id).rating_count, 0, `${source}: ${id}`);
            near(rows.get(id).gamma, 1, `${source}: ${id}`);
        }
    }
});

test('own places are excluded for their creator but an active owner can inform others', () => {
    const data = threeRaters();
    data.places[0].creator_id = 'a';
    const rows = calculateReputations(data, NOW);
    assert.equal(rows.get('a').rating_count, 0);
    near(rows.get('a').gamma, 1, 'creator');
    assert.equal(rows.get('b').rating_count, 1);
    near(rows.get('b').evidence, 0.5, 'active creator is one of the other raters');
});

test('banned and missing accounts supply neither consensus nor evidence count', () => {
    const data = threeRaters();
    data.users = [user('a'), user('b'), user('owner'), user('banned', 1)];
    data.ratings = [rating(1, 'a', 3), rating(1, 'b', 3), rating(1, 'banned', 1),
        rating(1, 'deleted-user', 1)];
    let rows = calculateReputations(data, NOW);
    assert.equal(rows.get('a').rating_count, 0);
    assert.equal(rows.get('b').rating_count, 0);
    assert.ok(!rows.has('banned'));
    data.users.push(user('c'));
    data.ratings.push(rating(1, 'c', 3));
    rows = calculateReputations(data, NOW);
    near(rows.get('a').evidence, 0.5, 'only two eligible others');
    near(rows.get('a').agreement, 0.8181818181818182, 'excluded low scores do not affect consensus');
});

test('one eligible place has zero leave-one-out bias and an unclipped residual', () => {
    const a = calculateReputations(threeRaters([1, 4, 4]), NOW).get('a');
    // m=4, b=0, e=-3, g=exp(-4.5), A=(4+.5*g)/5.5.
    near(a.agreement, 0.7282826360489311, 'A');
    near(a.gamma, 0.8287431218287183, 'gamma');
});

test('bias leaves the current place out and uses only qualifying places in N', () => {
    const data = threeRaters([1, 4, 4]);
    data.places.push(place(2), place(3));
    data.ratings.push(rating(2, 'a', 3), rating(2, 'b', 2), rating(2, 'c', 2), rating(3, 'a', 1));
    const a = calculateReputations(data, NOW).get('a');
    // Deltas -3,+1; b1=1/6, b2=-1/2; e1=-19/6, e2=3/2.
    // The third store has no consensus and cannot enter N or either bias sum.
    assert.equal(a.rating_count, 2);
    near(a.evidence, 1, 'evidence');
    near(a.agreement, 0.6942747898867575, 'leave-one-out A');
    near(a.gamma, 0.7531523185504707, 'leave-one-out gamma');
});

test('the leave-one-out bias is clipped to one point before forming the residual', () => {
    const data = threeRaters([1, 4, 4]);
    data.places = Array.from({ length: 6 }, (_, index) => place(index + 1));
    data.ratings = data.places.flatMap(p => [rating(p.id, 'a', 1), rating(p.id, 'b', 4), rating(p.id, 'c', 4)]);
    const a = calculateReputations(data, NOW).get('a');
    // Five other deltas sum to -15: b=clamp(-15/10)=-1, e=-2.
    // Neither gamma bound is reached, so omitting the bias clamp is observable.
    near(a.evidence, 3, 'evidence');
    near(a.agreement, 0.5507507312137297, 'A=(4+3*exp(-2))/8');
    near(a.gamma, 0.4739474498944655, 'gamma');
});

test('consistency factor reaches its specified lower and upper bounds', () => {
    for (const [count, scores, expected] of [[15, [1, 4, 4], 0.4], [10, [3, 3, 3], 1.25]]) {
        const data = threeRaters(scores);
        data.places = Array.from({ length: count }, (_, index) => place(index + 1));
        data.ratings = data.places.flatMap(p => ['a', 'b', 'c']
            .map((id, index) => rating(p.id, id, scores[index])));
        const a = calculateReputations(data, NOW).get('a');
        assert.equal(a.rating_count, count);
        near(a.gamma, expected, `${count} places`);
    }
});

function iterativeFixture() {
    const data = threeRaters([1, 4, 4]);
    data.ratings[2].updated_at = NOW - 960 * DAY; // tau(c)=.8 exactly.
    data.similarity = (left, right) => {
        const pair = [left, right].sort().join(':');
        return pair === 'a:b' ? Math.log(2) / 3 : pair === 'b:c' ? -Math.log(2) / 3 : 0;
    };
    return data;
}

test('exactly three simultaneous rounds use reputation, age and taste, then publish final W', () => {
    const rows = calculateReputations(iterativeFixture(), NOW);
    // All beta values are equal, so cancel from each consensus. The taste
    // multipliers are 2 (a,b), 1 (a,c), .5 (b,c), and c has age multiplier .8.
    // Round-one b gamma=.8355490882245703; round-two=.8358487879284926.
    // These independently evaluated third-round constants catch stale W,
    // in-place iteration, ignored age, ignored taste and extra iterations.
    const expected = {
        a: [0.7282826360489311, 0.8287431218287183, 0.42257666756441414],
        b: [0.7313997217819073, 0.8358524265978927, 0.4262017067821494],
        c: [0.7397167850163058, 0.854970190679468, 0.4359498673690489]
    };
    for (const [id, [agreement, gamma, weight]] of Object.entries(expected)) {
        const row = rows.get(id);
        near(row.beta, 0.5099006633466223, `${id}: beta`);
        near(row.agreement, agreement, `${id}: A`);
        near(row.gamma, gamma, `${id}: gamma`);
        near(row.weight, weight, `${id}: final W`);
    }
});

test('reordering all source arrays cannot change a user reputation', () => {
    const original = iterativeFixture();
    const reversed = { ...original };
    for (const key of ['users', 'places', 'ratings', 'favorites', 'requests']) {
        reversed[key] = original[key].slice().reverse();
    }
    const left = calculateReputations(original, NOW);
    const right = calculateReputations(reversed, NOW);
    assert.equal(left.size, right.size);
    for (const [id, row] of left) {
        for (const key of ['beta', 'gamma', 'weight', 'contribution', 'evidence', 'rating_count', 'agreement']) {
            near(right.get(id)[key], row[key], `${id}: ${key}`);
        }
    }
});

let failures = 0;
for (const { name, run } of tests) {
    try {
        run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL ${name}\n${error.stack}`);
    }
}
if (failures) {
    process.exitCode = 1;
    console.error(`${failures}/${tests.length} rating weight model tests failed.`);
} else {
    console.log(`All ${tests.length} rating weight model tests passed.`);
}
