import assert from 'node:assert/strict';
import {
    formatPlaceDay, lastModifierOf, lastModifierText, userPlacesTitle, userPlacesSummary, userPlacesMessage, userPlacesChipText,
    userPlaceDetail, userPlaceRowId, userPlaceFromRowId, userPlacesActions, userPlacesChromeSheet
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

// 行 id 往返；底部操作目前只有退出筛选（屏蔽以后加在 userPlacesActions）
assert.equal(userPlaceRowId(places[0]), 'place-3');
assert.equal(userPlaceFromRowId(ready, 'place-3'), places[0]);
for (const bad of ['place-99', 'exit', 'place-', null]) assert.equal(userPlaceFromRowId(ready, bad), null, String(bad));
assert.equal(userPlaceFromRowId(loading, 'place-3'), null);
assert.deepEqual(userPlacesActions(ready).map((action) => action.id), ['exit']);
assert.deepEqual(userPlacesActions(null), []);

// iOS 原生列表面板：通过桥接白名单；操作在前，地点行带分类与日期，避雷红色、审核中橙色
const sheet = sanitizeSheet({ ...userPlacesChromeSheet(ready), token: 4 });
assert.equal(sheet.id, 'userPlaces');
assert.equal(sheet.size, 'list');
assert.equal(sheet.title, '九日缤 创建的地点');
assert.equal(sheet.subtitle, '共 3 个，最近创建的在前');
assert.equal(sheet.message, undefined);
assert.deepEqual(sheet.sections.map((section) => section.id), ['actions', 'places']);
assert.deepEqual(sheet.sections[0].rows.map((row) => [row.id, row.symbol]), [['exit', 'xmark.circle']]);
assert.deepEqual(sheet.sections[1].rows.map((row) => [row.id, row.tone]), [['place-3', undefined], ['place-2', 'warning'], ['place-1', 'danger']]);
assert.equal(sheet.sections[1].rows[0].keepsOpen, false, '选中地点后列表收起，让位给地点卡片');
const loadingSheet = sanitizeSheet({ ...userPlacesChromeSheet(loading), token: 5 });
assert.deepEqual([loadingSheet.message, loadingSheet.messageTone, loadingSheet.subtitle], ['正在加载…', 'loading', undefined]);
assert.deepEqual(loadingSheet.sections.map((section) => section.id), ['actions']);
const errorSheet = sanitizeSheet({ ...userPlacesChromeSheet({ ...loading, status: 'error', error: 'x' }), token: 6 });
assert.equal(errorSheet.messageTone, 'danger');
assert.deepEqual(errorSheet.sections[0].rows.map((row) => row.id), ['retry', 'exit']);

console.log('user places tests passed');
