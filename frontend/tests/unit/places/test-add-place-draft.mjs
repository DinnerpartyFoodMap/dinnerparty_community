// 添加地点表单的本机草稿：npm run test:place-draft
import assert from 'node:assert/strict';

// 和浏览器一样，存的键是自身可枚举属性（clearLocalDraftsForUser 用 Object.keys 列举）
const storage = {};
Object.defineProperties(storage, {
    getItem: { value: (key) => (Object.hasOwn(storage, key) ? storage[key] : null) },
    setItem: { value: (key, value) => { storage[key] = String(value); }, writable: true },
    removeItem: { value: (key) => { delete storage[key]; } }
});
globalThis.localStorage = storage;
const stored = { get size() { return Object.keys(storage).length; } };

const {
    normalizePlaceContent, emptyPlaceContent, placeDraftSource, openPlaceDraft, persistPlaceDraft, discardPlaceDraft
} = await import('../../../src/places/addPlaceDraft.js');
const { clearLocalDraftsForUser } = await import('../../../src/platform/localDraftStore.js');

const blank = emptyPlaceContent();
const filled = { ...blank, name: '鱼粥', description: '招牌鱼粥', perPersonCost: '35', chosenRating: 3, exteriorImages: ['https://img.example/a.jpg'] };

// 读回的草稿逐项校验，坏值回到空值
assert.deepEqual(normalizePlaceContent({ name: 1, perPersonCost: '0', chosenRating: 9, menuImages: ['', 'u', 3], description: 'x'.repeat(1200) }),
    { name: '', category: '', description: 'x'.repeat(1000), perPersonCost: '', chosenRating: null, exteriorImages: [], menuImages: ['u'] });
assert.equal(placeDraftSource({}), null);
assert.deepEqual(placeDraftSource({ name: 'A', address: '' }), { name: 'A', address: '' });

// 没有草稿时打开空表单；和空表单一样的内容不写入，也不会被当成草稿恢复
assert.deepEqual(openPlaceDraft('u1', blank, null), { content: blank, restored: false, pending: null });
assert.equal(persistPlaceDraft('u1', blank, blank, null), false);
assert.equal(stored.size, 0);

// 地图上点选后填写，关掉再点选：直接恢复
assert.equal(persistPlaceDraft('u1', filled, blank, null), true);
assert.deepEqual(openPlaceDraft('u1', blank, null), { content: filled, restored: true, pending: null });

// 草稿按账号隔离，未登录不读写
assert.deepEqual(openPlaceDraft('u2', blank, null).content, blank);
assert.equal(persistPlaceDraft('', filled, blank, null), false);
assert.equal(openPlaceDraft(undefined, blank, null).restored, false);

// 从高德地点收录：同一地点直接恢复，另一个地点先用它的信息，草稿留作可选恢复
const poi = { name: 'B记鱼粥', address: '某路 1 号' };
const poiBaseline = emptyPlaceContent({ name: poi.name, category: '粥' });
const poiDraft = { ...poiBaseline, description: '早上去' };
assert.equal(persistPlaceDraft('u1', poiDraft, poiBaseline, placeDraftSource(poi)), true);
assert.deepEqual(openPlaceDraft('u1', poiBaseline, placeDraftSource(poi)), { content: poiDraft, restored: true, pending: null });
const other = placeDraftSource({ name: '别家', address: '另一路' });
const otherBaseline = emptyPlaceContent({ name: '别家' });
assert.deepEqual(openPlaceDraft('u1', otherBaseline, other), { content: otherBaseline, restored: false, pending: poiDraft });
// 在地图上点选时不论草稿来自哪里都恢复（地址不随草稿走）
assert.equal(openPlaceDraft('u1', blank, null).restored, true);

// 改回空表单即删除；提交成功与账号注销都会清掉
assert.equal(persistPlaceDraft('u1', poiBaseline, poiBaseline, placeDraftSource(poi)), false);
assert.equal(openPlaceDraft('u1', blank, null).restored, false);
persistPlaceDraft('u1', filled, blank, null);
discardPlaceDraft('u1');
assert.equal(openPlaceDraft('u1', blank, null).restored, false);
persistPlaceDraft('u1', filled, blank, null);
persistPlaceDraft('u2', filled, blank, null);
await clearLocalDraftsForUser('u1');
assert.equal(openPlaceDraft('u1', blank, null).restored, false);
assert.equal(openPlaceDraft('u2', blank, null).restored, true);

// 存储不可用（隐私模式写满等）时如实返回没保存
globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
assert.equal(persistPlaceDraft('u3', filled, blank, null), false);

console.log('add place draft tests passed');
