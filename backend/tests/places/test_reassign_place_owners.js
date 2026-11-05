// 临时数据库验证预览、账户创建、密码、评分转移、重复执行和事务回滚。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { generatePassword, plan, readEntries } = require('../../scripts/places/reassign_place_owners');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-reassign-'));
const dbFile = path.join(temp, 'test.sqlite');
const csvFile = path.join(temp, 'owners.csv');
const sql = new Database(dbFile);

function run(...args) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/places/reassign_place_owners.js'), csvFile, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DB_FILE: dbFile, LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' },
        timeout: 30000,
    });
    assert.ifError(result.error);
    return result;
}

try {
    const passwords = new Set();
    for (let i = 0; i < 100; i++) {
        const password = generatePassword();
        assert.equal(password.length, 24);
        for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%^&*()\-_=+]/]) assert.match(password, pattern);
        passwords.add(password);
    }
    assert.equal(passwords.size, 100);

    sql.pragma('foreign_keys = ON');
    sql.exec(`
        CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, qq TEXT UNIQUE,
            admin_level TEXT, created_time DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE Place (id INTEGER PRIMARY KEY, name TEXT, creator_id TEXT REFERENCES User(id), updated_by TEXT REFERENCES User(id));
        CREATE TABLE PlaceRating (place_id INTEGER REFERENCES Place(id), user_id TEXT REFERENCES User(id),
            score INTEGER, source TEXT, created_at INTEGER, updated_at INTEGER, weight REAL DEFAULT 0.5,
            PRIMARY KEY (place_id, user_id));
        INSERT INTO User (id, username, password, qq) VALUES
            ('old', '原所有者', 'old-hash', NULL), ('existing', '已有住民', 'existing-hash', '10001'),
            ('taken', '已占用', 'taken-hash', NULL);
        INSERT INTO Place VALUES
            (1, '店一', 'old', 'old'), (2, '店二', 'old', 'existing'), (3, '店三', 'old', NULL),
            (4, '已有店', 'old', 'old'), (5, '冲突店', 'old', NULL), (6, '缺创建人', 'old', NULL),
            (7, '重名店', 'old', NULL), (8, '重名店', 'old', NULL);
        INSERT INTO PlaceRating VALUES (1, 'old', 4, 'create', 100, 100, 0.9), (3, 'old', 2, 'user', 100, 100, 0.9);
    `);
    fs.writeFileSync(csvFile, '\uFEFF名称,创建人,qq\r\n'
        + '店一," 新人,甲 ",20001\r\n店二,另一称呼,20001\r\n店三,新人乙,20002\r\n已有店,,10001\r\n'
        + '冲突店,已占用,20003\r\n缺创建人,,20004\r\n不存在的店,不应注册,20005\r\n'
        + '重名店,重名甲,30001\r\n重名店,重名乙,30002\r\n重名店,重名丙,30003\r\n');

    const entries = readEntries(csvFile);
    assert.equal(entries[0].creator, '新人,甲');
    const preview = plan(sql, entries);
    assert.equal(preview.changes.length, 4);
    assert.deepEqual(preview.newUsers.map((user) => [user.username, user.qq]), [['新人,甲', '20001'], ['新人乙', '20002']]);
    assert.equal(preview.changes[0].toId, preview.changes[1].toId, '同一 QQ 只规划一个账户');
    assert.equal(preview.skipped.length, 6);
    const before = sql.prepare('SELECT * FROM User ORDER BY id').all();
    const dryRun = run();
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /这是预览，未写库/);
    assert.deepEqual(sql.prepare('SELECT * FROM User ORDER BY id').all(), before);
    assert.equal(sql.prepare('SELECT creator_id FROM Place WHERE id = 1').get().creator_id, 'old');
    assert.equal(fs.readdirSync(temp).filter((name) => name.endsWith('.bak')).length, 0);

    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /已新建 2 个账户，改动 4 个地点/);
    const users = sql.prepare("SELECT * FROM User WHERE qq IN ('20001', '20002') ORDER BY qq").all();
    assert.equal(users.length, 2);
    for (const user of users) {
        assert.match(user.id, /^[0-9a-f-]{36}$/);
        assert.match(user.password, /^[0-9a-f]{64}$/);
        assert.equal(user.admin_level, null);
        assert.ok(user.created_time);
        assert.ok(!applied.stdout.includes(user.password));
    }
    assert.notEqual(users[0].password, users[1].password);
    assert.deepEqual(sql.prepare('SELECT creator_id, updated_by FROM Place WHERE id = 1').get(), { creator_id: users[0].id, updated_by: users[0].id });
    assert.deepEqual(sql.prepare('SELECT creator_id, updated_by FROM Place WHERE id = 2').get(), { creator_id: users[0].id, updated_by: 'existing' });
    assert.equal(sql.prepare('SELECT creator_id FROM Place WHERE id = 4').get().creator_id, 'existing');
    const rating = sql.prepare('SELECT * FROM PlaceRating WHERE place_id = 1').get();
    assert.deepEqual([rating.user_id, rating.score, rating.source, rating.created_at, rating.weight], [users[0].id, 4, 'create', 100, 0.5]);
    assert.equal(sql.prepare('SELECT user_id FROM PlaceRating WHERE place_id = 3').get().user_id, users[1].id,'创建者后来手动修改的评分也随归属转移');
    for (const id of [5, 6, 7, 8]) assert.equal(sql.prepare('SELECT creator_id FROM Place WHERE id = ?').get(id).creator_id, 'old');
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM User').get().n, 5, '跳过的行不会创建账户');
    const backups = fs.readdirSync(temp).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new Database(path.join(temp, backups[0]), { readonly: true });
    try {
        assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM User').get().n, 3);
        assert.equal(backup.prepare('SELECT creator_id FROM Place WHERE id = 1').get().creator_id, 'old');
    } finally { backup.close(); }

    const repeated = run('--apply');
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /需要改动 0 个地点，新建 0 个账户/);
    assert.deepEqual(sql.prepare("SELECT * FROM User WHERE qq IN ('20001', '20002') ORDER BY qq").all(), users, '重复执行保留账户和密码');
    assert.deepEqual(sql.prepare("SELECT * FROM User WHERE id IN ('old', 'existing', 'taken') ORDER BY id").all(), before);

    // 写入地点失败时，刚插入的账户和之前的地点改动必须一起回滚。
    fs.writeFileSync(csvFile, '名称,创建人,qq\n冲突店,回滚甲,40001\n缺创建人,回滚乙,40002\n');
    sql.exec("CREATE TRIGGER fail_owner_update BEFORE UPDATE ON Place WHEN NEW.id = 6 BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    const failed = run('--apply');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /test rollback/);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM User WHERE qq IN ('40001', '40002')").get().n, 0);
    assert.equal(sql.prepare('SELECT creator_id FROM Place WHERE id = 5').get().creator_id, 'old');
    console.log('reassign owners tests passed: preview, QQ reuse, account creation, complex passwords, backup, ratings, idempotency and rollback.');
} finally {
    sql.close();
    // temp 是本测试刚创建且解析后仍在系统临时目录内的绝对路径。
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
}
