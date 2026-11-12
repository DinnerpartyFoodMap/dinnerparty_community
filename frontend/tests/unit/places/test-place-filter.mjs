// 地点筛选（places/placeFilter.js）与 App 更新比较（platform/appUpdate.js）：npm run test:place-filter
import assert from 'node:assert/strict';
import {
    COST_SLIDER, EMPTY_PLACE_FILTER, RADIUS_OPTIONS_KM, cyclePlaceFilterTag, isPlaceFilterActive, matchesPlaceFilter, normalizePlaceFilter,
    placeFilterFromAi, placeFilterKey, placeFilterQuery, placeFilterSnapshot, placeFilterTagState, placeListQuery, setPlaceFilterRegion, placeFilterRegionText
} from '../../../src/places/placeFilter.js';
import { regionBounds, regionPath } from '../../../src/places/placeRegions.js';
import { needsUpdate } from '../../../src/platform/appUpdate.js';
import { applyFilterSheetRow, filterChromeSheet } from '../../../src/places/filterChromeSheet.js';

// 规整：去重、min > max 互换、拉杆两端等于不设
assert.deepEqual(normalizePlaceFilter({ tags: ['火锅店', ' 火锅店 ', '', 3], minCost: 80, maxCost: 30 }), { tags: ['火锅店'], excludeTags: [], minCost: 30, maxCost: 80, province: null, city: null, district: null });
assert.deepEqual(normalizePlaceFilter({ tags: ['a', 'b'], excludeTags: ['b'] }).tags, ['a'], 'a tag in both lists counts as excluded');
assert.deepEqual(normalizePlaceFilter({ minCost: COST_SLIDER.min, maxCost: COST_SLIDER.max }), EMPTY_PLACE_FILTER);
assert.equal(isPlaceFilterActive(EMPTY_PLACE_FILTER), false);
assert.equal(isPlaceFilterActive({ tags: [], minCost: null, maxCost: 40 }), true);
assert.equal(placeFilterKey({ tags: ['b', 'a'] }), placeFilterKey({ tags: ['a', 'b'] }), 'tag order does not matter');
assert.notEqual(placeFilterKey({ tags: ['a'] }), placeFilterKey({ excludeTags: ['a'] }));
assert.equal(isPlaceFilterActive(normalizePlaceFilter({ excludeTags: ['避雷'] })), true);

// 交互记录的筛选快照：没生效时为 null，生效时为规整后的完整筛选（后端 mapClickFilter 按同样字段校验）
assert.equal(placeFilterSnapshot(EMPTY_PLACE_FILTER), null);
assert.equal(placeFilterSnapshot({ minCost: COST_SLIDER.min, maxCost: COST_SLIDER.max, city: '广州市' }), null, 'a city without a province is no filter');
assert.deepEqual(placeFilterSnapshot({ tags: ['火锅'], maxCost: 80, province: '广东省', city: '广州市' }),
    { tags: ['火锅'], excludeTags: [], minCost: null, maxCost: 80, province: '广东省', city: '广州市', district: null });

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
assert.deepEqual(placeFilterFromAi({ tags: ['烧烤'], min_cost: null, max_cost: 50 }), { tags: ['烧烤'], excludeTags: [], minCost: null, maxCost: 50, province: null, city: null, district: null });
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

// iOS 原生筛选面板（协议 v15）：标签为 chips，点一下包含 / 排除 / 取消；展开全部跟在标签后（无边框 link）；人均双头拉杆；清除在标题左侧
const directory = [{ name: '快餐', is_common: true }, { name: '避雷', is_common: true }, { name: '粤菜', is_common: false }];
let sheet = filterChromeSheet({ filter: normalizePlaceFilter({ tags: ['快餐'], excludeTags: ['粤菜'], maxCost: 30 }), categories: directory });
assert.equal(sheet.id, 'filter');
const tagSection = sheet.sections.find((section) => section.id === 'tags');
assert.equal(tagSection.style, 'chips');
assert.deepEqual(tagSection.rows.map((row) => [row.title, row.tone]).slice(0, 3), [['快餐', 'include'], ['避雷', undefined], ['粤菜', 'exclude']], 'picked uncommon tags stay visible while collapsed');
assert.deepEqual([tagSection.rows.at(-1).id, tagSection.rows.at(-1).tone], ['tags:more', 'link'], 'expand-all follows the tags as a borderless link');
assert.ok(tagSection.rows.every((row) => row.keepsOpen), 'tapping a tag keeps the panel open');
assert.ok(!sheet.sections.some((section) => section.id === 'more' || section.id === 'actions'));
const cost = sheet.sections.find((section) => section.id === 'cost');
assert.equal(cost.style, 'range');
assert.deepEqual([cost.range.min, cost.range.max, cost.range.step, cost.range.low, cost.range.high], [0, 200, 5, 0, 30]);
assert.equal(cost.range.valueFormat.includes('%d'), true);
assert.deepEqual([sheet.leading.id, sheet.leading.disabled], ['reset', false]);
let change = applyFilterSheetRow(normalizePlaceFilter({ tags: ['快餐'] }), 'tag:快餐');
assert.deepEqual(change.filter.excludeTags, ['快餐'], 'second tap turns the tag red');
change = applyFilterSheetRow(change.filter, 'cost:range:60:100');
assert.deepEqual([change.filter.minCost, change.filter.maxCost, change.filter.excludeTags], [60, 100, ['快餐']]);
assert.deepEqual([applyFilterSheetRow(change.filter, 'cost:range:0:200').filter.minCost, applyFilterSheetRow(change.filter, 'cost:range:0:200').filter.maxCost], [null, null], 'both ends at the limits mean no cost filter');
assert.equal(applyFilterSheetRow(EMPTY_PLACE_FILTER, 'cost:range:x:1'), null);
assert.equal(isPlaceFilterActive(applyFilterSheetRow(change.filter, 'reset').filter), false);
assert.deepEqual(applyFilterSheetRow(EMPTY_PLACE_FILTER, 'tags:more'), { toggleShowAll: true });
assert.equal(applyFilterSheetRow(EMPTY_PLACE_FILTER, 'nope'), null);
sheet = filterChromeSheet({ filter: EMPTY_PLACE_FILTER, categories: directory, showAll: true });
assert.equal(sheet.sections.find((section) => section.id === 'tags').rows.length, 4);
assert.equal(sheet.leading.disabled, true, 'nothing to clear');

// 地区（省 / 市 / 区）：一层一层选，上层变了下层清空；没带地区字段的来源（搜索结果）不按地区排除
const regions = [
    { name: '广东省', count: 3, bounds: [113, 23, 114, 24], children: [
        { name: '广州市', count: 2, bounds: [113.2, 23.1, 113.4, 23.2], children: [{ name: '天河区', count: 2, bounds: [113.3, 23.1, 113.4, 23.2] }] },
        { name: '深圳市', count: 1, bounds: [114, 22.5, 114, 22.5], children: [] }
    ] },
    { name: '北京市', count: 1, bounds: [116.4, 39.9, 116.4, 39.9], children: [{ name: '北京市', count: 1, bounds: [116.4, 39.9, 116.4, 39.9], children: [] }] }
];
assert.deepEqual(normalizePlaceFilter({ city: '广州市' }).city, null, 'no city without a province');
let regionFilter = setPlaceFilterRegion(EMPTY_PLACE_FILTER, 'province', '广东省');
regionFilter = setPlaceFilterRegion(regionFilter, 'city', '广州市');
regionFilter = setPlaceFilterRegion(regionFilter, 'district', '天河区');
assert.deepEqual([regionFilter.province, regionFilter.city, regionFilter.district], ['广东省', '广州市', '天河区']);
assert.equal(isPlaceFilterActive(regionFilter), true);
assert.equal(placeFilterRegionText(regionFilter), '广东省 · 广州市 · 天河区');
assert.equal(placeFilterRegionText(setPlaceFilterRegion(setPlaceFilterRegion(EMPTY_PLACE_FILTER, 'province', '北京市'), 'city', '北京市')), '北京市', 'municipality city is not repeated');
assert.deepEqual([setPlaceFilterRegion(regionFilter, 'province', '北京市').city, setPlaceFilterRegion(regionFilter, 'city', '').district], [null, null], 'changing a level clears the levels below');
assert.notEqual(placeFilterKey(regionFilter), placeFilterKey(setPlaceFilterRegion(regionFilter, 'district', '')));
assert.equal(matchesPlaceFilter({ category: '', province: '广东省', city: '广州市', district: '天河区' }, regionFilter), true);
assert.equal(matchesPlaceFilter({ category: '', province: '广东省', city: '广州市', district: '越秀区' }, regionFilter), false);
assert.equal(matchesPlaceFilter({ category: '', province: null, city: null, district: null }, regionFilter), false, 'unresolved places are outside every region');
assert.equal(matchesPlaceFilter({ category: '' }, regionFilter), true, 'sources without region fields are not filtered by region');
assert.equal(placeFilterQuery(regionFilter).toString(), 'province=%E5%B9%BF%E4%B8%9C%E7%9C%81&city=%E5%B9%BF%E5%B7%9E%E5%B8%82&district=%E5%A4%A9%E6%B2%B3%E5%8C%BA');
assert.deepEqual(regionPath(regions, regionFilter).map((node) => node.name), ['广东省', '广州市', '天河区']);
assert.deepEqual(regionBounds(regions, { province: '广东省', city: '深圳市' }), [114, 22.5, 114, 22.5]);
assert.equal(regionBounds(regions, { province: '浙江省' }), null);
// 原生面板：省 / 市 / 区为 menu 分组，选中项 tone accent，点选回传 region:<层>:<名称>
sheet = filterChromeSheet({ filter: setPlaceFilterRegion(EMPTY_PLACE_FILTER, 'province', '广东省'), categories: directory, regions });
const regionSections = sheet.sections.filter((section) => section.style === 'menu');
assert.deepEqual(regionSections.map((section) => section.id), ['region-province', 'region-city'], 'city menu appears once a province is picked');
assert.deepEqual(regionSections[0].rows.find((row) => row.tone === 'accent').id, 'region:province:广东省');
assert.equal(regionSections[1].rows[0].tone, 'accent', '不限 is selected while no city is picked');
change = applyFilterSheetRow(setPlaceFilterRegion(EMPTY_PLACE_FILTER, 'province', '广东省'), 'region:city:广州市');
assert.deepEqual([change.filter.province, change.filter.city], ['广东省', '广州市']);
assert.equal(applyFilterSheetRow(change.filter, 'region:province:').filter.province, null);
assert.equal(applyFilterSheetRow(change.filter, 'region:planet:地球'), null);
assert.equal(filterChromeSheet({ filter: EMPTY_PLACE_FILTER, categories: directory }).sections.some((section) => section.style === 'menu'), false, 'no region menus without region data');

// App 更新：服务器构建号更大时才提示；读不出本机构建号时不提示
assert.equal(needsUpdate('23', { build: 24 }), true);
assert.equal(needsUpdate('24', { build: 24 }), false);
assert.equal(needsUpdate('25', { build: 24 }), false);
assert.equal(needsUpdate(null, { build: 24 }), false);
assert.equal(needsUpdate('23', { build: null }), false);
assert.equal(needsUpdate('23', null), false);

console.log('place filter tests passed');
