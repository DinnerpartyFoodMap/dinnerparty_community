import assert from 'node:assert/strict';
import { exhibitionCenter, exhibitionRandomOrigin, exhibitionChromeSheet } from '../../../src/map/exhibition.js';
import { sanitizeSheet } from '../../../src/platform/nativeMapChrome.js';

const base = { id: 7, name: '秋日展会', description: '简介第一行\n简介第二行', information: '上海 · 周六 10:00', icon_url: '' };

// 展会地点：两个坐标都有效才算有地点
assert.equal(exhibitionCenter(null), null);
assert.equal(exhibitionCenter(base), null, '没有坐标');
assert.equal(exhibitionCenter({ ...base, latitude: '', longitude: '' }), null, '空字符串');
assert.equal(exhibitionCenter({ ...base, latitude: 0, longitude: 0 }), null, '0,0 视为未选');
assert.equal(exhibitionCenter({ ...base, latitude: 95, longitude: 113 }), null, '越界');
assert.equal(exhibitionCenter({ ...base, latitude: 23.1, longitude: null }), null, '只有一个坐标');
assert.deepEqual(exhibitionCenter({ ...base, latitude: '23.1', longitude: '113.3' }), { lat: 23.1, lng: 113.3 });

// 随机美食的固定中心：key 区分展会，label 是展会名
assert.equal(exhibitionRandomOrigin(base), null);
assert.deepEqual(exhibitionRandomOrigin({ ...base, latitude: 23.1, longitude: 113.3 }),
    { lat: 23.1, lng: 113.3, key: 'exhibition-7', label: '秋日展会' });

// 原生面板：没有地点时只有“详情”；有地点时“展会附近随机美食”在前；正文分段，地点做副标题与地址行
const plain = sanitizeSheet({ ...exhibitionChromeSheet(base), token: 1 });
assert.equal(plain.id, 'exhibition');
assert.equal(plain.size, 'card');
assert.deepEqual(plain.actions.map((a) => a.id), ['details']);
assert.equal(plain.actions[0].expands, true);
assert.equal(plain.subtitle, '展会');
assert.equal(plain.caption, undefined);
assert.deepEqual(plain.paragraphs.map((p) => [p.title, p.text]), [['展会简介', base.description], ['展会信息', base.information]]);
assert.equal(plain.image, undefined, '没有图标时不下发');

const located = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, latitude: 23.1, longitude: 113.3, location_name: '  保利世贸博览馆 ' },
    { iconUrl: 'https://cdn.example.com/food/icon.png' }), token: 2 });
assert.deepEqual(located.actions.map((a) => a.id), ['random', 'details']);
assert.equal(located.actions[0].tone, 'accent');
assert.equal(located.actions[0].keepsOpen, false, '随机后原生面板收起');
assert.equal(located.subtitle, '保利世贸博览馆');
assert.equal(located.caption, '保利世贸博览馆');
assert.equal(located.image, 'https://cdn.example.com/food/icon.png');
assert.equal(exhibitionChromeSheet(null), null);
console.log('Exhibition origin and native sheet passed.');
