// 地点筛选（places/placeFilter.js）与 App 更新比较（platform/appUpdate.js）：npm run test:place-filter
import assert from 'node:assert/strict';
import {
    COST_SLIDER, EMPTY_PLACE_FILTER, RADIUS_OPTIONS_KM, isPlaceFilterActive, matchesPlaceFilter, normalizePlaceFilter,
    placeFilterFromAi, placeFilterKey, placeFilterQuery, placeListQuery
} from '../../../src/places/placeFilter.js';
import { needsUpdate } from '../../../src/platform/appUpdate.js';

// 规整：去重、min > max 互换、拉杆两端等于不设
assert.deepEqual(normalizePlaceFilter({ tags: ['火锅店', ' 火锅店 ', '', 3], minCost: 80, maxCost: 30 }), { tags: ['火锅店'], minCost: 30, maxCost: 80 });
assert.deepEqual(normalizePlaceFilter({ minCost: COST_SLIDER.min, maxCost: COST_SLIDER.max }), EMPTY_PLACE_FILTER);
assert.equal(isPlaceFilterActive(EMPTY_PLACE_FILTER), false);
assert.equal(isPlaceFilterActive({ tags: [], minCost: null, maxCost: 40 }), true);
assert.equal(placeFilterKey({ tags: ['b', 'a'] }), placeFilterKey({ tags: ['a', 'b'] }), 'tag order does not matter');

// 匹配：标签命中任一；设了人均范围时没填人均的不算；高德临时地点不参与筛选
const filter = { tags: ['火锅店', '烧烤'], minCost: 50, maxCost: 100 };
assert.equal(matchesPlaceFilter({ category: '烧烤, 排档', per_person_cost: 60 }, filter), true);
assert.equal(matchesPlaceFilter({ category: '甜品店', per_person_cost: 60 }, filter), false);
assert.equal(matchesPlaceFilter({ category: '火锅店', per_person_cost: null }, filter), false);
assert.equal(matchesPlaceFilter({ category: '火锅店', per_person_cost: 120 }, filter), false);
assert.equal(matchesPlaceFilter({ isMarked: false, category: '', per_person_cost: null }, filter), true);
assert.equal(matchesPlaceFilter({ category: '' }, EMPTY_PLACE_FILTER), true);

// AI 搜索返回的筛选（后端 searchFilter.js 的字段名）
assert.deepEqual(placeFilterFromAi({ tags: ['烧烤'], min_cost: null, max_cost: 50 }), { tags: ['烧烤'], minCost: null, maxCost: 50 });
assert.equal(placeFilterFromAi({ tags: [], min_cost: null, max_cost: null }), null);
assert.equal(placeFilterFromAi(null), null);

// 查询参数：距离只在中心与合法半径都有时才带上
assert.equal(placeFilterQuery({ tags: ['a', 'b'], minCost: 10, maxCost: null }).toString(), 'tags=a%2Cb&minCost=10');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: { lat: 23.1, lng: 113.3 }, radiusKm: 3 }).toString(), 'lat=23.100000&lng=113.300000&radiusKm=3');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: { lat: 23.1, lng: 113.3 }, radiusKm: 4 }).toString(), '');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: null, radiusKm: 3 }).toString(), '');
assert.deepEqual([...RADIUS_OPTIONS_KM], [1, 3, 5, 10, 20, 50], 'same options as backend placeList.js');

// App 更新：服务器构建号更大时才提示；读不出本机构建号时不提示
assert.equal(needsUpdate('23', { build: 24 }), true);
assert.equal(needsUpdate('24', { build: 24 }), false);
assert.equal(needsUpdate('25', { build: 24 }), false);
assert.equal(needsUpdate(null, { build: 24 }), false);
assert.equal(needsUpdate('23', { build: null }), false);
assert.equal(needsUpdate('23', null), false);

console.log('place filter tests passed');
