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
const badFlags = JSON.parse(JSON.stringify(corpus));
const quizSituation = badFlags.situations.find((situation) => situation.quiz);
quizSituation.variants.find((variant) => variant.fits.length).rare = true;
quizSituation.variants.find((variant) => !variant.fits.length).rare = 'yes';
const caughtFlags = validateCorpus(badFlags).errors.join('\n');
for (const expected of ['问答情境里的做法不标 rare', '普通做法不标 rare', '只写 true', '最多一种 rare']) assert.match(caughtFlags, new RegExp(expected), `应当拦住：${expected}`);

// 前后矛盾和剧本时段字段
const badTimes = JSON.parse(JSON.stringify(corpus));
const daytime = badTimes.situations.find((situation) => situation.scene === 'home' && !situation.anchor);
daytime.variants[0] = { ...daytime.variants[0], action: '{a}看着看着睡着了', detail: [] };
badTimes.situations.find((situation) => situation.anchor === 'bedtime').variants[0].detail = ['没一会儿就睡着了'];
const morning = badTimes.situations.find((situation) => situation.scene === 'home' && !situation.anchor && situation.id !== daytime.id);
morning.variants[0] = { ...morning.variants[0], detail: ['七点就醒了'] };
const dinnerRemote = badTimes.scripts.find((script) => script.when === 'dinner');
delete dinnerRemote.when;
badTimes.scripts.find((script) => script.kind === 'bond').beats[0].detail = ['说完去吃饭了'];
badTimes.scripts.find((script) => script.kind === 'table').when = 'late';
badTimes.scripts.find((script) => script.kind === 'remote' && script !== dinnerRemote).meal = 'before';
const caughtTimes = validateCorpus(badTimes).errors.join('\n');
for (const expected of ['白天睡着要在动作里写完', '睡前这条后面紧跟睡着', '几点醒由起床那条决定', `${dinnerRemote.id}#\\d+: 提到正在吃晚饭`, '升级剧情接在任何剧情后面', 'when 只用于隔空', 'meal 只用于拼桌']) {
    assert.match(caughtTimes, new RegExp(expected), `应当拦住：${expected}`);
}

// 正式语料零错误
const { errors, warnings, stats } = validateCorpus(corpus);
if (errors.length) console.error(errors.join('\n'));
assert.equal(errors.length, 0, `语料有 ${errors.length} 处不符合规则`);

console.log(`Room corpus ${corpus.version}: ${stats.situations} situations / ${stats.variants} variants (say ${stats.say}, rare ${stats.rare}), ${stats.quirks} quirks, ${stats.scripts} scripts; `
    + `sound ${(stats.soundShare * 100).toFixed(0)}%, detail ${(stats.detailShare * 100).toFixed(0)}%; ${warnings.length} warnings.`);
if (process.argv.includes('--warnings')) console.log(warnings.join('\n'));
