import assert from 'node:assert/strict';
import {
    formatPlaceDay, lastModifierOf, lastModifierText, userPlacesTitle, userPlacesSummary, userPlacesMessage, userPlacesChipText,
    userPlaceDetail, userPlaceBadge, userPlaceRowId, userPlaceFromRowId, userPlacesActions, userPlacesChromeSheet
} from '../../../src/map/userPlaces.js';
import { sanitizeSheet } from '../../../src/platform/nativeMapChrome.js';

const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// 日期：SQLite 的 CURRENT_TIMESTAMP 按 UTC 解析（Safari 不认空格写法），ISO 与毫秒数照常；无效为 null
assert.equal(formatPlaceDay('2026-08-08 20:30:00'), localDay(new Date(Date.UTC(2026, 7, 8, 20, 30))));
assert.equal(formatPlaceDay('2026-08-08T01:00:00Z'), localDay(new Date(Date.UTC(2026, 7, 8, 1))));
assert.equal(formatPlaceDay(String(Date.UTC(2026, 0, 2, 12))), localDay(new Date(Date.UTC(2026, 0, 2, 12))));
for (const bad of [null, undefined, '', 'yesterday']) assert.equal(formatPlaceDay(bad), null, String(bad));

// 最近修改：修改过取最后修改人，否则取创建者；注销的住民（没有名字）不能点；高德临时地点没有
const base = { id: 9, creator_id: 'u-maker', creator_name: '九日缤', created_time: '2026-08-01 02:00:00' };
assert.deepEqual(lastModifierOf(base), { id: 'u-maker', name: '九日缤', date: formatPlaceDay(base.created_time), clickable: true });
const edited = { ...base, updated_by: 'u-editor', updated_by_name: '小町', updated_time: '2026-08-08 02:00:00' };
assert.deepEqual(lastModifierOf(edited), { id: 'u-editor', name: '小町', date: formatPlaceDay(edited.updated_time), clickable: true });
const editorGone = lastModifierOf({ ...edited, updated_by_name: null });
assert.deepEqual([editorGone.id, editorGone.name, editorGone.clickable], ['u-editor', null, false], '不会把创建者当成修改人');
assert.equal(lastModifierText(editorGone), `已注销的住民 · ${formatPlaceDay(edited.updated_time)}`);
assert.equal(lastModifierText(lastModifierOf(edited)), `小町 · ${formatPlaceDay(edited.updated_time)}`);
assert.equal(lastModifierOf({ ...base, isMarked: false }), null);
assert.equal(lastModifierOf(null), null);
assert.equal(lastModifierOf({ ...base, creator_id: null }).clickable, false);

// 列表文案：别人 / 自己、只显示了最近一部分、加载中 / 出错 / 没有地点
const places = [
    { id: 3, name: '新店', category: '面馆', per_person_cost: 25, created_time: '2026-03-01 08:00:00', moderation_status: 'visible', rating_count: 2, rating_average: 4 },
    { id: 2, name: '审核中的店', category: '', created_time: '2026-02-01 08:00:00', moderation_status: 'checking' },
    { id: 1, name: '避雷店', category: '快餐', created_time: '2026-01-01 08:00:00', moderation_status: 'visible', rating_count: 3, rating_average: 1.5 }
];
const user = { id: 'u-maker', name: '九日缤' };
const ready = { user, status: 'ready', places, total: 3, relation: { self: false, blocked: false } };
assert.equal(userPlacesTitle(ready), '九日缤 创建的地点');
assert.equal(userPlacesTitle({ ...ready, relation: { self: true, blocked: false } }), '我创建的地点');
assert.equal(userPlacesSummary(ready), '共 3 个，最近创建的在前');
assert.equal(userPlacesSummary({ ...ready, total: 250 }), '共 250 个，显示最近的 3 个');
assert.equal(userPlacesMessage(ready), '');
assert.equal(userPlacesChipText(ready), '九日缤 的 3 个地点');
assert.equal(userPlacesChipText({ ...ready, relation: { self: true } }), '我的 3 个地点');
const loading = { user, status: 'loading', places: null, total: 0, relation: null };
assert.equal(userPlacesSummary(loading), '');
assert.equal(userPlacesMessage(loading), '正在加载…');
assert.equal(userPlacesChipText(loading), '正在加载 九日缤 的地点');
assert.equal(userPlacesMessage({ ...loading, status: 'error', error: '网络错误' }), '加载失败：网络错误');
assert.equal(userPlacesMessage({ ...ready, places: [], total: 0 }), '还没有公开的地点');
assert.equal(userPlacesMessage({ ...ready, places: [], total: 0, relation: { self: true } }), '你还没有创建地点');
assert.equal(userPlaceDetail(places[0]), `面馆 · 人均 ¥25 · 创建于 ${formatPlaceDay(places[0].created_time)}`);
assert.equal(userPlaceDetail(places[1]), `审核中 · 未分类 · 创建于 ${formatPlaceDay(places[1].created_time)}`);

// 行 id 往返；操作：查看主页（屏蔽与举报在主页里）、退出筛选；已屏蔽 Ta 时多一个解除屏蔽
assert.equal(userPlaceRowId(places[0]), 'place-3');
assert.equal(userPlaceFromRowId(ready, 'place-3'), places[0]);
for (const bad of ['place-99', 'exit', 'block', 'place-', null]) assert.equal(userPlaceFromRowId(ready, bad), null, String(bad));
assert.equal(userPlaceFromRowId(loading, 'place-3'), null);
assert.deepEqual(userPlacesActions(ready).map((action) => action.id), ['profile', 'exit']);
assert.deepEqual(userPlacesActions({ ...ready, relation: { self: true, blocked: false, can_block: false } }).map((action) => [action.id, action.title]),
    [['profile', '我的主页'], ['exit', '显示全部地点']]);
assert.deepEqual(userPlacesActions(null), []);
const viewing = { ...ready, relation: { self: false, blocked: false, can_block: true } };
assert.deepEqual(userPlacesActions(viewing).map((action) => [action.id, action.title, action.tone]),
    [['profile', '查看主页', undefined], ['exit', '显示全部地点', undefined]]);
assert.deepEqual(userPlacesActions({ ...viewing, status: 'loading', places: null }).map((action) => action.id), ['profile', 'exit'], '加载完才知道是否已屏蔽');
const blockedFilter = { ...ready, places: [], total: 0, relation: { self: false, blocked: true, can_block: true } };
assert.deepEqual(userPlacesActions(blockedFilter).map((action) => [action.id, action.title]), [['profile', '查看主页'], ['unblock', '解除屏蔽'], ['exit', '显示全部地点']]);
// 被驳回的地点：行尾“未通过”小标识，次要信息里不再写“审核中”
const rejected = { id: 9, name: '驳回的店', category: '面馆', moderation_status: 'rejected', created_time: places[0].created_time };
assert.equal(userPlaceBadge(rejected), '未通过');
assert.equal(userPlaceBadge(places[0]), '');
assert.equal(userPlaceBadge(places[1]), '', '审核中的不是被驳回');
assert.equal(userPlaceDetail(rejected), `面馆 · 创建于 ${formatPlaceDay(rejected.created_time)}`);
assert.equal(userPlacesMessage(blockedFilter), '你已屏蔽 九日缤，TA 创建的地点、地点下 TA 的公开日记和同好名片不会显示给你。');
assert.equal(userPlacesChipText(blockedFilter), '已屏蔽 九日缤');
assert.equal(userPlacesSummary(blockedFilter), '');

// iOS 原生列表面板：通过桥接白名单；操作在前，地点行带分类与日期，避雷红色、审核中橙色
const sheet = sanitizeSheet({ ...userPlacesChromeSheet(ready), token: 4 });
assert.equal(sheet.id, 'userPlaces');
assert.equal(sheet.size, 'list');
assert.equal(sheet.title, '九日缤 创建的地点');
assert.equal(sheet.subtitle, '共 3 个，最近创建的在前');
assert.equal(sheet.message, undefined);
assert.deepEqual(sheet.sections.map((section) => section.id), ['actions', 'places']);
assert.deepEqual(sheet.sections[0].rows.map((row) => [row.id, row.symbol]), [['profile', 'person.crop.circle'], ['exit', 'xmark.circle']]);
assert.deepEqual(sheet.sections[1].rows.map((row) => [row.id, row.tone]), [['place-3', undefined], ['place-2', 'warning'], ['place-1', 'danger']]);
assert.equal(sheet.sections[1].rows[0].keepsOpen, false, '选中地点后列表收起，让位给地点卡片');
const loadingSheet = sanitizeSheet({ ...userPlacesChromeSheet(loading), token: 5 });
assert.deepEqual([loadingSheet.message, loadingSheet.messageTone, loadingSheet.subtitle], ['正在加载…', 'loading', undefined]);
assert.deepEqual(loadingSheet.sections.map((section) => section.id), ['actions']);
const errorSheet = sanitizeSheet({ ...userPlacesChromeSheet({ ...loading, status: 'error', error: 'x' }), token: 6 });
assert.equal(errorSheet.messageTone, 'danger');
assert.deepEqual(errorSheet.sections[0].rows.map((row) => row.id), ['retry', 'profile', 'exit']);
// iOS 原生面板同样是查看主页 / 解除屏蔽；已屏蔽时没有地点分组，只显示说明
const viewingSheet = sanitizeSheet({ ...userPlacesChromeSheet(viewing), token: 7 });
assert.deepEqual(viewingSheet.sections[0].rows.map((row) => [row.id, row.symbol, row.tone]),
    [['profile', 'person.crop.circle', undefined], ['exit', 'xmark.circle', undefined]]);
// 自己的列表里被驳回的地点带“未通过”小标识（v12 行尾 badge）
const ownSheet = sanitizeSheet({ ...userPlacesChromeSheet({ ...ready, places: [rejected, places[0]], total: 2, relation: { self: true } }), token: 9 });
assert.deepEqual(ownSheet.sections[1].rows.map((row) => row.badge), ['未通过', undefined]);
const blockedSheet = sanitizeSheet({ ...userPlacesChromeSheet(blockedFilter), token: 8 });
assert.deepEqual(blockedSheet.sections.map((section) => section.id), ['actions']);
assert.deepEqual(blockedSheet.sections[0].rows.map((row) => [row.id, row.symbol]),
    [['profile', 'person.crop.circle'], ['unblock', 'person.crop.circle.badge.checkmark'], ['exit', 'xmark.circle']]);
assert.equal(blockedSheet.message, userPlacesMessage(blockedFilter));

console.log('user places tests passed');
