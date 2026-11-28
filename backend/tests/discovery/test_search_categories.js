// AI 搜索筛选提取给模型的标签列表（searchFilter.knownCategories）：公开地点用到的标签，用得多的在前，
// 不受 Category 表顺序和前 200 个的限制。
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { knownCategories } = require('../../modules/discovery/services/searchFilter');

const sql = new Database(':memory:');
sql.exec(`CREATE TABLE Place (id INTEGER PRIMARY KEY, category TEXT, moderation_status TEXT NOT NULL DEFAULT 'visible');`);
const insert = sql.prepare('INSERT INTO Place (category, moderation_status) VALUES (?, ?)');
// 250 个只用一次的标签，排在“火锅店”前面也不能把它挤掉
for (let i = 0; i < 250; i++) insert.run(`标签${String(i).padStart(3, '0')}`, 'visible');
insert.run('火锅店, 川菜', 'visible');
insert.run('火锅店，湘菜', 'visible');
insert.run('火锅店', 'visible');
insert.run('川菜', 'visible');
insert.run('只在隐藏地点上', 'pending');
insert.run('广东菜(粤菜)', 'visible');

const names = knownCategories(sql, 0);
assert.equal(names[0], '火锅店', 'the most used tag comes first');
assert.equal(names[1], '川菜');
assert.ok(names.includes('湘菜'), 'full-width commas are split');
assert.ok(names.includes('标签249'), 'more than 200 tags are kept');
assert.ok(!names.includes('只在隐藏地点上'), 'tags only on hidden places are left out');
assert.ok(names.includes('粤菜') && !names.includes('广东菜(粤菜)'), 'merged tags use the kept name');
assert.equal(new Set(names).size, names.length, 'no duplicates');

// 5 分钟内复用，过期后重算
insert.run('新标签, 新标签2', 'visible');
assert.ok(!knownCategories(sql, 60 * 1000).includes('新标签'), 'cached within five minutes');
assert.ok(knownCategories(sql, 6 * 60 * 1000).includes('新标签'), 'recomputed after five minutes');

console.log('search categories: ok');
