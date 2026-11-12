import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addedText, editCommentPreview } from '../../../src/places/editEvidence.js';

const require = createRequire(import.meta.url);
const backend = require('../../../../backend/modules/places/services/placeEditDiff.js');

// The record is only the text added to the description.
const before = { name: 'A', description: 'old', exterior_images: '["https://a.test/a.jpg"]', latitude: 23 };
assert.equal(editCommentPreview({ description: '123' }, { description: '123456' }), '456');
assert.equal(editCommentPreview(before, { description: 'old plus new' }), 'plus new');
assert.equal(editCommentPreview(before, { ...before, exterior_images: ['https://a.test/a.jpg'] }), '');
assert.equal(editCommentPreview(before, { latitude: 24 }), '', 'other fields record nothing');
assert.equal(editCommentPreview(before, { name: 'B', description: 'old' }), '', 'unchanged descriptions are not presented as new comments');
assert.equal(editCommentPreview({ description: '**招牌**牛肉粉' }, { description: '**招牌**牛肉粉\n\n加了[链接](https://x.com)很好吃' }), '加了链接很好吃', 'Markdown is compared as plain text');

// Same rule as the backend, case by case.
const cases = [
    ['123', '123456', '456'],
    ['旧评价', '旧评价，烧鸭没熟', '烧鸭没熟'],
    ['删除这个', '删除', ''],
    ['old', 'old', ''],
    ['', '新店', '新店'],
    ['', '！！！', ''],
    ['早茶', '早茶，出品稳定', '出品稳定'],
    ['早茶', '出品比较稳定的茶楼，下午有45折', '出品比较稳定的茶楼，下午有45折'],
    ['原来的描述', '选点前填写的描述', '选点前填写的描述'],
    ['环境好', '服务好，环境一般', '服务好，环境一般'],
    ['123', '0123456', '0123456'],
    ['虽然要二三十元但是里面会有牛肉。味道还不错，当然其他地方的几家也可以尝试一下', '虽然要二三十元但是里面会有牛肉且配料很多。味道还不错，但比孙塘路那家口味重。其他地方的几家也可以尝试一下', '且配料很多 … 但比孙塘路那家口味重。'],
    ['好吃😋', '好吃😋，再来一碗🍜', '再来一碗🍜'],
    ['米饭是冷的', '米饭是冷的。营业到22点！', '营业到22点！'],
    ['a <b>b</b> &amp; c', 'a b & c d', 'd'],
];
for (const [a, b, expected] of cases) {
    assert.equal(addedText(a, b), expected, `${a} → ${b}`);
    assert.equal(backend.addedText(a, b), expected, `backend ${a} → ${b}`);
}
assert.equal(addedText('x'.repeat(1200), 'y'.repeat(1200)).length, 1000, 'bounded like the backend');
for (const [b4, after] of [['**招牌**牛肉粉', '**招牌**牛肉粉\n\n加了[链接](https://x.com)很好吃'], [null, '新写的'], ['1. 一\n2. 二', '1. 一\n2. 二\n3. 三']]) {
    assert.equal(editCommentPreview({ description: b4 }, { description: after }), backend.editCommentText({ description: b4 }, { description: after }));
}
console.log('Edit record preview: only added description text, Markdown as plain text, identical to the backend rule.');
