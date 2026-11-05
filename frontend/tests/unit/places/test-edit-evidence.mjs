import assert from 'node:assert/strict';
import { editCommentPreview } from '../../../src/places/editEvidence.js';
const before={name:'A',description:'old',exterior_images:'["https://a.test/a.jpg"]',latitude:23};
assert.equal(editCommentPreview(before,{...before,exterior_images:['https://a.test/a.jpg']}),'');
assert.equal(editCommentPreview(before,{description:'old plus new'}),'描述：old → old plus new');
assert.equal(editCommentPreview(before,{latitude:24}),'纬度：23 → 24');
assert.ok(!editCommentPreview(before,{name:'B'}).includes('old'),'unchanged descriptions are not presented as new comments');
console.log('Edit evidence preview ownership, image normalization and position changes passed.');
