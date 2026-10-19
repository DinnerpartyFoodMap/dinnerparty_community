import assert from 'node:assert/strict';
import { getExhibitionTop } from '../../../src/map/exhibitionLayout.js';

const home = { left: 300, right: 388, top: 67, bottom: 137 };
assert.equal(getExhibitionTop(home, null), 67, 'no notice keeps the entry at the top');
assert.equal(getExhibitionTop(home, { left: 12, right: 388, top: 67, bottom: 180 }), 188, 'overlap moves below notice');
assert.equal(getExhibitionTop(home, { left: 12, right: 280, top: 67, bottom: 180 }), 67, 'wide screen has room beside notice');
assert.equal(getExhibitionTop(home, { left: 12, right: 388, top: 150, bottom: 200 }), 67, 'a lower notice does not collide');
assert.equal(getExhibitionTop(home, { left: 12, right: 388, top: 67, bottom: 320 }, 20), 308, 'viewport coordinates convert to parent coordinates');
console.log('Exhibition collision layout passed.');
