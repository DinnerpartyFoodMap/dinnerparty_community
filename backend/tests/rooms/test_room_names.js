const assert = require('node:assert/strict');
const { DEFAULT_ROLE_NAME, validateName } = require('../../modules/rooms/services/roomNames');
const { defaultName } = require('../../../frontend/src/i18n/locales/zh-CN/companion.json');

assert.equal(DEFAULT_ROLE_NAME, defaultName);
for (const name of [' Rice ', '🍜'.repeat(12), '👨‍👩‍👧‍👦'.repeat(12), '*️⃣', '糯米。团子']) {
    assert.deepEqual(validateName(name, defaultName), [], name);
}
for (const name of [
    '', '   ', '🍜'.repeat(13), '！ ...', '$$$', ` ${defaultName} `,
    'http', 'ｗｗｗ．例子', '小店.cn', '123456', '１２３４５６', '123-4567', 'Q Q', '微信', 'ＶＸ加我',
    '\u0000', '小\n团', '\ud800'
]) {
    assert.ok(validateName(name, defaultName).length, JSON.stringify(name));
}
assert.ok(validateName('晚饭', '晚饭').length);
assert.deepEqual(validateName('晚饭', defaultName), []);
console.log('Room names: Unicode length, default names, links and contact checks passed.');
