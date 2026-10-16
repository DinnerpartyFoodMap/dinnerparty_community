// 地点评价纯逻辑与请求封装：npm run test:rating
import assert from 'node:assert/strict';
import {
    RATING_TIERS, tierForAverage, ratingTierFor, isAvoidedPlace, defaultCreationScore, summaryText, summaryFromPlace, formatAverage
} from "../../../src/places/rating.js";
import { fetchPlaceRating, savePlaceRating, withdrawPlaceRating } from "../../../src/api/client.js";

// 四档从高到低，每档都有文案
assert.deepEqual(RATING_TIERS.map((tier) => tier.score), [4, 3, 2, 1]);
assert.ok(RATING_TIERS.every((tier) => tier.label && tier.hint && !tier.label.includes('map:')));

// 平均分取最接近的一档，正好一半取较好的一档（与后端 ratingTier 一致）
assert.equal(tierForAverage(null), null);
assert.equal(tierForAverage(undefined), null);
assert.equal(tierForAverage(''), null);
assert.equal(tierForAverage(1.49).score, 1);
assert.equal(tierForAverage(1.5).score, 2);
assert.equal(tierForAverage(2.49).score, 2);
assert.equal(tierForAverage(2.5).score, 3);
assert.equal(tierForAverage(3.5).score, 4);
assert.equal(tierForAverage(4).score, 4);
assert.equal(ratingTierFor(5), null);
assert.equal(formatAverage(3.25), '3.3');

// 避雷图标：有评价看综合评价，没人评价看“避雷”标签
assert.equal(isAvoidedPlace({ category: '快餐, 避雷' }), true, 'legacy rows without rating fields keep the tag rule');
assert.equal(isAvoidedPlace({ category: '快餐, 避雷', rating_count: 0, rating_average: null }), true);
assert.equal(isAvoidedPlace({ category: '快餐, 避雷', rating_count: 4, rating_average: 3.1 }), false);
assert.equal(isAvoidedPlace({ category: '火锅', rating_count: 2, rating_average: 2.4 }), true);
assert.equal(isAvoidedPlace({ category: '火锅', rating_count: 2, rating_average: 2.5 }), false);
assert.equal(isAvoidedPlace(null), false);

assert.equal(defaultCreationScore('甜品, 避雷'), 1);
assert.equal(defaultCreationScore('甜品'), 4);
assert.equal(defaultCreationScore(''), 4);

assert.deepEqual(summaryFromPlace({ rating_count: 3, rating_average: 2.6667 }), { count: 3, average: 2.6667 });
assert.deepEqual(summaryFromPlace({}), { count: 0, average: null });
assert.match(summaryText({ count: 3, average: 2.6667 }), /均线之上 2\.7 · 3 人评价/);
assert.equal(summaryText({ count: 0, average: null }), '暂无评价');

// 请求封装：游客不带凭证；保存/撤回带凭证；失败时保留后端报错与状态码
const originalFetch = globalThis.fetch;
const requests = [];
try {
    let reply = { ok: true, status: 200, json: async () => ({ summary: { count: 0 } }) };
    globalThis.fetch = async (...args) => { requests.push(args); return reply; };
    await fetchPlaceRating('https://example.test', 7);
    assert.equal(requests[0][0], 'https://example.test/api/ratings/places/7');
    assert.equal(requests[0][1].headers, undefined, 'guests must not send an empty token');
    assert.equal(requests[0][1].cache, 'no-store');
    await fetchPlaceRating('https://example.test', 7, { token: 'tk' });
    assert.equal(requests[1][1].headers.Authorization, 'Bearer tk');
    await savePlaceRating('https://example.test', 'tk', 7, 3);
    assert.equal(requests[2][1].method, 'PUT');
    assert.deepEqual(JSON.parse(requests[2][1].body), { score: 3 });
    await withdrawPlaceRating('https://example.test', 'tk', 7);
    assert.equal(requests[3][1].method, 'DELETE');
    reply = { ok: false, status: 429, json: async () => ({ error: '今天已经评价了 10 家店，明天再来吧' }) };
    await assert.rejects(savePlaceRating('https://example.test', 'tk', 8, 4), (error) => error.status === 429 && /10 家店/.test(error.message));
} finally {
    globalThis.fetch = originalFetch;
}

console.log('rating tests passed');
