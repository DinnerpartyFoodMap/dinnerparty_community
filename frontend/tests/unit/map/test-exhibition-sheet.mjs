import assert from 'node:assert/strict';
import { localeText } from '../../support/locale-text.mjs';
import { exhibitionCenter, exhibitionRandomOrigin, exhibitionVenue, exhibitionChromeSheet } from '../../../src/map/exhibition.js';
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

// 地图图钉：label 优先地点名，没有时用展会名；key 含坐标，换地点后旧图钉失效
assert.equal(exhibitionVenue(base), null);
assert.deepEqual(exhibitionVenue({ ...base, latitude: 23.1, longitude: 113.3, location_name: ' 保利世贸博览馆 ' }),
    { lat: 23.1, lng: 113.3, key: 'exhibition-7@23.1,113.3', label: '保利世贸博览馆' });
assert.equal(exhibitionVenue({ ...base, latitude: 23.1, longitude: 113.3 }).label, '秋日展会');
assert.notEqual(exhibitionVenue({ ...base, latitude: 23.1, longitude: 113.3 }).key,
    exhibitionVenue({ ...base, latitude: 23.2, longitude: 113.3 }).key);

// 原生面板：没有地点时只有“详情”；有地点时“展会附近随机美食”在前；正文分段，地点做副标题与地址行，有坐标时二者可点
const plain = sanitizeSheet({ ...exhibitionChromeSheet(base), token: 1 });
assert.equal(plain.id, 'exhibition');
assert.equal(plain.size, 'card');
assert.deepEqual(plain.actions.map((a) => a.id), ['details']);
assert.equal(plain.actions[0].expands, true);
assert.equal(plain.subtitle, localeText('map:exhibition.subtitle'));
assert.equal(plain.caption, undefined);
assert.equal(plain.subtitleAction, undefined, '没有坐标时副标题不可点');
assert.equal(plain.captionAction, undefined);
const namedOnly = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, location_name: '待定场馆' }), token: 3 });
assert.equal(namedOnly.caption, '待定场馆');
assert.equal(namedOnly.subtitleAction, undefined, '只有地点名、没有坐标时只是文字');
assert.equal(namedOnly.captionAction, undefined);
assert.deepEqual(plain.paragraphs.map((p) => [p.title, p.text]),
    [[localeText('map:exhibition.information'), base.information], [localeText('map:exhibition.description'), base.description]]);
assert.equal(plain.image, undefined, '没有图标时不下发');

// 简介与信息支持 Markdown：text 是纯文本（旧版 App），markdown 是原生可显示的行内格式；展会名最多 80 字，不截断
const formatted = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, name: '展'.repeat(80),
    description: '**重点** 见 [官网](https://example.com)\n- 一\n- 二', information: '<b>上海</b> · 周六 10:00' }), token: 5 });
assert.equal(formatted.title, '展'.repeat(80));
assert.deepEqual(formatted.paragraphs.map((p) => [p.text, p.markdown]), [
    ['上海 · 周六 10:00', '上海 · 周六 10:00'],
    ['重点 见 官网\n一\n二', '**重点** 见 [官网](https://example.com)\n\n• 一\n• 二']
]);

const located = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, latitude: 23.1, longitude: 113.3, location_name: '  保利世贸博览馆 ' },
    { iconUrl: 'https://cdn.example.com/food/icon.png' }), token: 2 });
assert.deepEqual(located.actions.map((a) => a.id), ['random', 'details']);
assert.equal(located.actions[0].tone, 'accent');
assert.equal(located.actions[0].keepsOpen, false, '随机后原生面板收起');
assert.equal(located.subtitle, '保利世贸博览馆');
assert.equal(located.caption, '保利世贸博览馆');
for (const action of [located.subtitleAction, located.captionAction]) {
    assert.equal(action.id, 'venue');
    assert.equal(action.title, localeText('map:exhibition.showVenueLabel', { location: '保利世贸博览馆' }), '行标题是读屏标签');
    assert.equal(action.keepsOpen, false, '点地址后原生面板收起，露出地图');
}
// 有坐标但没填地点名：副标题显示“查看位置”并可点，没有地址行
const unnamed = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, latitude: 23.1, longitude: 113.3 }), token: 4 });
assert.equal(unnamed.subtitle, localeText('map:exhibition.showVenue'));
assert.equal(unnamed.subtitleAction.id, 'venue');
assert.equal(unnamed.caption, undefined);
assert.equal(unnamed.captionAction, undefined);
assert.equal(located.image, 'https://cdn.example.com/food/icon.png');
assert.equal(exhibitionChromeSheet(null), null);
const timed = sanitizeSheet({ ...exhibitionChromeSheet({ ...base, event_time: '2026-11-01T10:00' }), token: 5 });
assert.equal(timed.paragraphs.find(p => p.id === 'event-time').text, '2026-11-01 10:00');
console.log('Exhibition origin and native sheet passed.');
