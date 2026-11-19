// 观察屋固定语料的校验（RM-01）：只读 modules/rooms/corpus，不碰数据库。
const assert = require('node:assert/strict');
const { loadCorpus, validateCorpus, textLength } = require('../../modules/rooms/services/roomCorpus');

const corpus = loadCorpus();

// 字数规则本身
assert.equal(textLength('{a}把菜单翻了三遍', corpus.rules), 9);
assert.equal(textLength('「嗯……」', corpus.rules), 3);
assert.equal(textLength('{x}问{y}「你也常来{place}」', corpus.rules), 15);

// 校验器要能拦住典型的问题句子
const bad = JSON.parse(JSON.stringify(corpus));
bad.situations[0].variants[0] = { id: 'bad', fits: ['爱睡觉'], action: '{a}满足地伸了个懒腰！', sound: ['再睡会儿'], detail: ['她仿佛回到了小时候'] };
const caught = validateCorpus(bad).errors.join('\n');
for (const expected of ['满足', '感叹号', '「」', '仿佛', '他 / 她']) assert.match(caught, new RegExp(expected), `应当拦住：${expected}`);
const badScript = JSON.parse(JSON.stringify(corpus));
badScript.scripts.find((script) => script.kind === 'table').beats[0].action = '{x}抱住了{y}说这家很好吃';
const caughtScript = validateCorpus(badScript).errors.join('\n');
assert.match(caughtScript, /抱/);
assert.match(caughtScript, /好吃/);

// 正式语料零错误
const { errors, warnings, stats } = validateCorpus(corpus);
if (errors.length) console.error(errors.join('\n'));
assert.equal(errors.length, 0, `语料有 ${errors.length} 处不符合规则`);

console.log(`Room corpus ${corpus.version}: ${stats.situations} situations / ${stats.variants} variants, ${stats.quirks} quirks, ${stats.scripts} scripts; `
    + `sound ${(stats.soundShare * 100).toFixed(0)}%, detail ${(stats.detailShare * 100).toFixed(0)}%; ${warnings.length} warnings.`);
if (process.argv.includes('--warnings')) console.log(warnings.join('\n'));
