// 地点筛选（places/placeFilter.js）与 App 更新比较（platform/appUpdate.js）：npm run test:place-filter
import assert from 'node:assert/strict';
import {
    COST_SLIDER, EMPTY_PLACE_FILTER, RADIUS_OPTIONS_KM, cyclePlaceFilterTag, isPlaceFilterActive, matchesPlaceFilter, normalizePlaceFilter,
    placeFilterFromAi, placeFilterKey, placeFilterQuery, placeFilterTagState, placeListQuery
} from '../../../src/places/placeFilter.js';
import { needsUpdate } from '../../../src/platform/appUpdate.js';
import { applyFilterSheetRow, filterChromeSheet } from '../../../src/places/filterChromeSheet.js';

// 规整：去重、min > max 互换、拉杆两端等于不设
assert.deepEqual(normalizePlaceFilter({ tags: ['火锅店', ' 火锅店 ', '', 3], minCost: 80, maxCost: 30 }), { tags: ['火锅店'], excludeTags: [], minCost: 30, maxCost: 80 });
assert.deepEqual(normalizePlaceFilter({ tags: ['a', 'b'], excludeTags: ['b'] }).tags, ['a'], 'a tag in both lists counts as excluded');
assert.deepEqual(normalizePlaceFilter({ minCost: COST_SLIDER.min, maxCost: COST_SLIDER.max }), EMPTY_PLACE_FILTER);
assert.equal(isPlaceFilterActive(EMPTY_PLACE_FILTER), false);
assert.equal(isPlaceFilterActive({ tags: [], minCost: null, maxCost: 40 }), true);
assert.equal(placeFilterKey({ tags: ['b', 'a'] }), placeFilterKey({ tags: ['a', 'b'] }), 'tag order does not matter');
assert.notEqual(placeFilterKey({ tags: ['a'] }), placeFilterKey({ excludeTags: ['a'] }));
assert.equal(isPlaceFilterActive(normalizePlaceFilter({ excludeTags: ['避雷'] })), true);

// 点标签：未选 → 包含（绿）→ 排除（红）→ 未选
let cycled = cyclePlaceFilterTag(EMPTY_PLACE_FILTER, '快餐');
assert.equal(placeFilterTagState(cycled, '快餐'), 'include');
cycled = cyclePlaceFilterTag(cycled, '快餐');
assert.equal(placeFilterTagState(cycled, '快餐'), 'exclude');
assert.deepEqual([cycled.tags, cycled.excludeTags], [[], ['快餐']]);
cycled = cyclePlaceFilterTag(cycled, '快餐');
assert.equal(placeFilterTagState(cycled, '快餐'), null);
assert.equal(isPlaceFilterActive(cycled), false);

// 匹配：标签命中任一；设了人均范围时没填人均的不算；高德临时地点不参与筛选
const filter = { tags: ['火锅店', '烧烤'], minCost: 50, maxCost: 100 };
assert.equal(matchesPlaceFilter({ category: '烧烤, 排档', per_person_cost: 60 }, filter), true);
assert.equal(matchesPlaceFilter({ category: '甜品店', per_person_cost: 60 }, filter), false);
assert.equal(matchesPlaceFilter({ category: '火锅店', per_person_cost: null }, filter), false);
assert.equal(matchesPlaceFilter({ category: '火锅店', per_person_cost: 120 }, filter), false);
assert.equal(matchesPlaceFilter({ isMarked: false, category: '', per_person_cost: null }, filter), true);
assert.equal(matchesPlaceFilter({ category: '' }, EMPTY_PLACE_FILTER), true);

// （绿 OR 绿）−（红 OR 红）
const mixed = normalizePlaceFilter({ tags: ['快餐', '小吃'], excludeTags: ['连锁店', '避雷'] });
assert.equal(matchesPlaceFilter({ category: '小吃' }, mixed), true);
assert.equal(matchesPlaceFilter({ category: '快餐, 连锁店' }, mixed), false);
assert.equal(matchesPlaceFilter({ category: '小吃, 避雷' }, mixed), false);
assert.equal(matchesPlaceFilter({ category: '粤菜' }, mixed), false);
const redOnly = normalizePlaceFilter({ excludeTags: ['避雷'] });
assert.equal(matchesPlaceFilter({ category: '粤菜' }, redOnly), true, 'only red tags keep everything else');
assert.equal(matchesPlaceFilter({ category: '' }, redOnly), true);
assert.equal(matchesPlaceFilter({ category: '粤菜, 避雷' }, redOnly), false);

// AI 搜索返回的筛选（后端 searchFilter.js 的字段名）
assert.deepEqual(placeFilterFromAi({ tags: ['烧烤'], min_cost: null, max_cost: 50 }), { tags: ['烧烤'], excludeTags: [], minCost: null, maxCost: 50 });
assert.deepEqual(placeFilterFromAi({ tags: [], exclude_tags: ['连锁店'], min_cost: null, max_cost: null }).excludeTags, ['连锁店']);
assert.equal(placeFilterFromAi({ tags: [], min_cost: null, max_cost: null }), null);
assert.equal(placeFilterFromAi(null), null);

// 查询参数：距离只在中心与合法半径都有时才带上
assert.equal(placeFilterQuery({ tags: ['a', 'b'], minCost: 10, maxCost: null }).toString(), 'tags=a%2Cb&minCost=10');
assert.equal(placeFilterQuery({ tags: ['a'], excludeTags: ['b', 'c'] }).toString(), 'tags=a&excludeTags=b%2Cc');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: { lat: 23.1, lng: 113.3 }, radiusKm: 3 }).toString(), 'lat=23.100000&lng=113.300000&radiusKm=3');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: { lat: 23.1, lng: 113.3 }, radiusKm: 4 }).toString(), '');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: null, radiusKm: 3 }).toString(), '');
assert.deepEqual([...RADIUS_OPTIONS_KM], [0.5, 1, 3, 5, 10], 'bounded options include a walkable 500m radius');
assert.equal(placeListQuery(EMPTY_PLACE_FILTER, { center: { lat: 23.1, lng: 113.3 }, radiusKm: 0.5 }).get('radiusKm'), '0.5');

// iOS 原生筛选面板（协议 v14）：标签为 chips，点一下包含 / 排除 / 取消；人均档位；清除
const directory = [{ name: '快餐', is_common: true }, { name: '避雷', is_common: true }, { name: '粤菜', is_common: false }];
let sheet = filterChromeSheet({ filter: normalizePlaceFilter({ tags: ['快餐'], excludeTags: ['粤菜'], maxCost: 30 }), categories: directory });
assert.equal(sheet.id, 'filter');
const tagSection = sheet.sections.find((section) => section.id === 'tags');
assert.equal(tagSection.style, 'chips');
assert.deepEqual(tagSection.rows.map((row) => [row.title, row.tone]), [['快餐', 'include'], ['避雷', undefined], ['粤菜', 'exclude']], 'picked uncommon tags stay visible while collapsed');
assert.ok(tagSection.rows.every((row) => row.keepsOpen), 'tapping a tag keeps the panel open');
assert.equal(sheet.sections.find((section) => section.id === 'cost').rows.find((row) => row.tone === 'accent').id, 'cost:0-30');
assert.equal(sheet.sections.find((section) => section.id === 'actions').rows[0].disabled, false);
let change = applyFilterSheetRow(normalizePlaceFilter({ tags: ['快餐'] }), 'tag:快餐');
assert.deepEqual(change.filter.excludeTags, ['快餐'], 'second tap turns the tag red');
change = applyFilterSheetRow(change.filter, 'cost:60-100');
assert.deepEqual([change.filter.minCost, change.filter.maxCost, change.filter.excludeTags], [60, 100, ['快餐']]);
assert.equal(isPlaceFilterActive(applyFilterSheetRow(change.filter, 'reset').filter), false);
assert.deepEqual(applyFilterSheetRow(EMPTY_PLACE_FILTER, 'tags:more'), { toggleShowAll: true });
assert.equal(applyFilterSheetRow(EMPTY_PLACE_FILTER, 'nope'), null);
sheet = filterChromeSheet({ filter: normalizePlaceFilter({ minCost: 20, maxCost: 90 }), categories: directory, showAll: true });
assert.equal(sheet.sections.find((section) => section.id === 'tags').rows.length, 3);
assert.ok(sheet.sections.find((section) => section.id === 'cost').footer.includes('¥20'), 'a slider range set on the web is described');

// App 更新：服务器构建号更大时才提示；读不出本机构建号时不提示
assert.equal(needsUpdate('23', { build: 24 }), true);
assert.equal(needsUpdate('24', { build: 24 }), false);
assert.equal(needsUpdate('25', { build: 24 }), false);
assert.equal(needsUpdate(null, { build: 24 }), false);
assert.equal(needsUpdate('23', { build: null }), false);
assert.equal(needsUpdate('23', null), false);

console.log('place filter tests passed');
