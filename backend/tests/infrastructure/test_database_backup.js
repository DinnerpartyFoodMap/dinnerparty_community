const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { BACKEND_ROOT } = require('../../infrastructure/paths');

const moduleFile = path.join(BACKEND_ROOT, 'infrastructure/databaseBackup.js');
assert.ok(fs.existsSync(moduleFile), 'the standalone database backup pipeline is not implemented');
const { readBackupConfig, backupDatabase } = require(moduleFile);
const cli = path.join(BACKEND_ROOT, 'scripts/backups/backup_database.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-backup-'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log(`PASS ${name}`); };

function fixture(name, localOnly = false) {
    const root = path.join(temp, name);
    fs.mkdirSync(root);
    const dbFile = path.join(root, 'source.sqlite');
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, \'committed in WAL\')');
    const config = readBackupConfig({
        DB_FILE: dbFile, BACKUP_DIR: path.join(root, 'backups'), BACKUP_LOCAL_KEEP: '3',
        BACKUP_OSS_REGION: 'oss-cn-hangzhou', BACKUP_OSS_BUCKET: 'private-backup-bucket',
        BACKUP_OSS_ACCESS_KEY_ID: 'test-backup-id', BACKUP_OSS_ACCESS_KEY_SECRET: 'test-backup-secret',
        BACKUP_UPLOAD_TIMEOUT_MS: '1000'
    }, { localOnly });
    return { root, db, config };
}

class MemoryOss {
    constructor() { this.objects = new Map(); this.calls = []; this.putFailures = 0; }
    async put(key, file, options) {
        this.calls.push({ key, options });
        if (this.putFailures-- > 0) throw Object.assign(new Error('temporary network error'), { code: 'RequestError' });
        this.objects.set(key, { data: fs.readFileSync(file), options });
        return { res: { status: 200 } };
    }
    async head(key) {
        const object = this.objects.get(key);
        if (!object) throw Object.assign(new Error('missing'), { status: 404 });
        return { res: { status: 200, headers: {
            'content-length': String(object.data.length),
            'x-oss-meta-sha256': object.options.headers['x-oss-meta-sha256']
        } } };
    }
}

function restore(result, target) {
    const gzip = fs.readFileSync(result.archivePath);
    assert.equal(hash(gzip), result.manifest.archiveSha256);
    const bytes = zlib.gunzipSync(gzip);
    assert.equal(hash(bytes), result.manifest.sqliteSha256);
    assert.equal(bytes.length, result.manifest.sqliteBytes);
    fs.writeFileSync(target, bytes);
    const restored = new Database(target, { readonly: true, fileMustExist: true });
    sqliteVec.load(restored);
    assert.equal(restored.pragma('quick_check', { simple: true }), 'ok');
    return restored;
}

async function main() {
    await test('configuration is independent of cwd and image OSS credentials', async () => {
        const config = readBackupConfig({ DB_FILE: 'custom.sqlite', BACKUP_DIR: 'backups' }, { localOnly: true });
        assert.equal(config.dbFile, path.join(BACKEND_ROOT, 'custom.sqlite'));
        assert.equal(config.directory, path.join(BACKEND_ROOT, 'backups'));
        assert.equal(config.keepLocal, 3);
        assert.equal(readBackupConfig({ DB_FILE: '   ', BACKUP_DIR: '   ' }, { localOnly: true }).dbFile, path.join(BACKEND_ROOT, 'data.sqlite'));
        assert.throws(() => readBackupConfig({ OSS_BUCKET: 'image-bucket', OSS_ACCESS_KEY_ID: 'image-id', OSS_ACCESS_KEY_SECRET: 'image-secret' }), /BACKUP_OSS_/);
        for (const [key, value] of [['BACKUP_LOCAL_KEEP', '0'], ['BACKUP_UPLOAD_ATTEMPTS', '2x'], ['BACKUP_UPLOAD_TIMEOUT_MS', '-1']]) {
            assert.throws(() => readBackupConfig({ [key]: value }, { localOnly: true }), new RegExp(key));
        }
        const env = { BACKUP_OSS_REGION: 'oss-cn-hangzhou', BACKUP_OSS_BUCKET: 'backup-bucket', BACKUP_OSS_ACCESS_KEY_ID: 'a', BACKUP_OSS_ACCESS_KEY_SECRET: 'b' };
        assert.throws(() => readBackupConfig({ ...env, BACKUP_OSS_ENDPOINT: 'http://example.com' }), /HTTPS|https/);
        assert.throws(() => readBackupConfig({ ...env, BACKUP_OSS_PREFIX: '../images' }), /PREFIX/);
    });

    await test('missing or empty sources fail without creating a new database', async () => {
        const missing = path.join(temp, 'missing.sqlite');
        const config = readBackupConfig({ DB_FILE: missing, BACKUP_DIR: path.join(temp, 'missing-backups') }, { localOnly: true });
        await assert.rejects(backupDatabase(config), /source|database|源|数据库/i);
        assert.equal(fs.existsSync(missing), false);
        fs.writeFileSync(missing, '');
        await assert.rejects(backupDatabase(config), /empty|database|空|数据库/i);
    });

    await test('the source cannot be inside the retention directory and corrupt databases never upload', async () => {
        const { db, config } = fixture('source-boundaries', true);
        try {
            await assert.rejects(backupDatabase({ ...config, directory: path.dirname(config.dbFile) }), /source|directory|源|目录/i);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sample').get().n, 1);
            const corrupt = path.join(path.dirname(config.dbFile), 'corrupt.sqlite');
            fs.writeFileSync(corrupt, 'not a sqlite database');
            const client = new MemoryOss();
            await assert.rejects(backupDatabase({ ...config, dbFile: corrupt, localOnly: false }, { client }));
            assert.equal(client.calls.length, 0);
        } finally { db.close(); }
    });

    await test('a live WAL database and vector tables restore consistently during writes', async () => {
        const { root, db, config } = fixture('wal', true);
        sqliteVec.load(db);
        db.exec('CREATE VIRTUAL TABLE embeddings USING vec0(vector float[3]); CREATE TABLE revision_a (value INTEGER); CREATE TABLE revision_b (value INTEGER); INSERT INTO revision_a VALUES (0); INSERT INTO revision_b VALUES (0); CREATE TABLE padding (data BLOB)');
        db.prepare('INSERT INTO embeddings(rowid, vector) VALUES (?, ?)').run(1n, '[1,2,3]');
        db.transaction(() => {
            const insert = db.prepare('INSERT INTO padding VALUES (?)');
            for (let i = 0; i < 256; i++) insert.run(Buffer.alloc(16384, i % 255));
        })();
        let writes = 0;
        const update = db.transaction(() => { db.exec('UPDATE revision_a SET value = value + 1; UPDATE revision_b SET value = value + 1'); });
        const timer = setInterval(() => { update(); if (++writes === 10) clearInterval(timer); }, 1);
        try {
            const result = await backupDatabase(config);
            assert.ok(writes > 0, 'the backup must overlap a live writer');
            assert.equal(result.uploaded, false);
            assert.equal(fs.existsSync(path.join(result.directory, 'uploaded.json')), false);
            const restored = restore(result, path.join(root, 'restored.sqlite'));
            try {
                assert.equal(restored.prepare('SELECT value FROM sample').get().value, 'committed in WAL');
                assert.equal(restored.prepare('SELECT value FROM revision_a').get().value, restored.prepare('SELECT value FROM revision_b').get().value);
                assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM padding').get().n, 256);
                assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 1);
                assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'User'").all(), [], 'backup must not run business migrations');
            } finally { restored.close(); }
        } finally { clearInterval(timer); db.close(); }
        assert.equal(require.cache[path.join(BACKEND_ROOT, 'infrastructure/database.js')], undefined);
    });

    await test('private uploads preserve hashes and publish the manifest last', async () => {
        const { root, db, config } = fixture('upload');
        const client = new MemoryOss();
        try {
            const result = await backupDatabase(config, { client });
            assert.equal(result.uploaded, true);
            assert.deepEqual(fs.readdirSync(result.directory).sort(), ['manifest.json', 'snapshot.sqlite.gz', 'uploaded.json']);
            assert.equal(client.calls.length, 2);
            assert.match(client.calls[0].key, /^food-map\/sqlite\/\d{4}\/\d{2}\/\d{2}\/sqlite-backup-.*\.sqlite\.gz$/);
            assert.match(client.calls[1].key, /\.manifest\.json$/);
            for (const call of client.calls) {
                assert.equal(call.options.headers['x-oss-object-acl'], 'private');
                assert.equal(call.options.headers['Cache-Control'], 'no-store');
                assert.equal(call.options.headers['x-oss-forbid-overwrite'], 'true');
                assert.equal(call.options.headers['x-oss-meta-sha256'], hash(client.objects.get(call.key).data));
                assert.equal(call.options.headers['Content-MD5'], crypto.createHash('md5').update(client.objects.get(call.key).data).digest('base64'));
            }
            assert.equal(fs.existsSync(path.join(result.directory, 'uploaded.json')), true);
            assert.deepEqual(JSON.parse(client.objects.get(client.calls[1].key).data), result.manifest);
            const restored = restore(result, path.join(root, 'roundtrip.sqlite'));
            assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sample').get().n, 1);
            restored.close();
        } finally { db.close(); }
    });

    await test('transient upload failures retry and a lost PUT acknowledgement is recoverable', async () => {
        const { db, config } = fixture('retry');
        const client = new MemoryOss();
        client.putFailures = 2;
        try {
            const result = await backupDatabase(config, { client });
            assert.equal(result.uploaded, true);
            assert.equal(client.calls.length, 4);
            const lost = new MemoryOss();
            const put = lost.put.bind(lost);
            let first = true;
            lost.put = async (...args) => { const result = await put(...args); if (first) { first = false; throw new Error('response lost'); } return result; };
            assert.equal((await backupDatabase(config, { client: lost })).uploaded, true);
        } finally { db.close(); }
    });

    await test('failed uploads and HEAD mismatches retain artifacts and do not report success', async () => {
        const { db, config } = fixture('failure');
        config.keepLocal = 1;
        const client = new MemoryOss();
        try {
            const good = await backupDatabase(config, { client });
            const failing = new MemoryOss();
            failing.put = async () => { throw new Error('secret must not reach CLI: test-backup-secret'); };
            await assert.rejects(backupDatabase(config, { client: failing }), error => !error.message.includes('test-backup-secret'));
            assert.equal(fs.existsSync(good.archivePath), true);
            const mismatch = new MemoryOss();
            const head = mismatch.head.bind(mismatch);
            mismatch.head = async key => { const result = await head(key); result.res.headers['content-length'] = '1'; return result; };
            await assert.rejects(backupDatabase(config, { client: mismatch }), /upload|verif|上传|验证/i);
            assert.equal(mismatch.calls.some(call => call.key.endsWith('.manifest.json')), false);
            const jobs = fs.readdirSync(config.directory).filter(name => name.startsWith('sqlite-backup-'));
            assert.equal(jobs.length, 3);
            assert.equal(jobs.filter(name => fs.existsSync(path.join(config.directory, name, 'uploaded.json'))).length, 1);
            for (const name of jobs) assert.ok(fs.existsSync(path.join(config.directory, name, 'snapshot.sqlite.gz')));
        } finally { db.close(); }
    });

    await test('retention deletes only successful owned jobs and preserves failures and unrelated files', async () => {
        const { db, config } = fixture('retention');
        config.keepLocal = 2;
        try {
            const first = await backupDatabase(config, { client: new MemoryOss() });
            const outside = path.join(path.dirname(config.dbFile), 'unrelated');
            fs.mkdirSync(outside);
            for (const file of ['snapshot.sqlite.gz', 'manifest.json']) fs.writeFileSync(path.join(outside, file), 'keep');
            const aliasName = 'sqlite-backup-20200101T000000000Z-00000000-0000-4000-8000-000000000000';
            fs.writeFileSync(path.join(outside, 'uploaded.json'), JSON.stringify({ formatVersion: 1, jobName: aliasName, uploadedAt: '2020-01-01T00:00:00.000Z' }));
            try {
                fs.symlinkSync(outside, path.join(config.directory, aliasName), process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
                console.log('SKIP retention symlink fixture: this environment does not permit creating links. Other retention assertions still run.');
            }
            const local = await backupDatabase({ ...config, localOnly: true });
            const second = await backupDatabase(config, { client: new MemoryOss() });
            fs.writeFileSync(path.join(second.directory, 'unrelated.txt'), 'keep this');
            await backupDatabase(config, { client: new MemoryOss() });
            assert.equal(fs.existsSync(first.directory), false);
            assert.equal(fs.existsSync(local.directory), true);
            await backupDatabase(config, { client: new MemoryOss() });
            assert.equal(fs.readFileSync(path.join(second.directory, 'unrelated.txt'), 'utf8'), 'keep this');
            assert.equal(fs.readFileSync(path.join(outside, 'snapshot.sqlite.gz'), 'utf8'), 'keep');
        } finally { db.close(); }
    });

    await test('a failed completion manifest and wrong SHA metadata never mark or prune a backup', async () => {
        const { db, config } = fixture('manifest-failure');
        config.keepLocal = 1;
        try {
            const good = await backupDatabase(config, { client: new MemoryOss() });
            const client = new MemoryOss();
            const put = client.put.bind(client);
            client.put = async (...args) => { if (args[0].endsWith('.manifest.json')) throw new Error('manifest failed'); return put(...args); };
            await assert.rejects(backupDatabase(config, { client }), /upload|上传/i);
            assert.equal(fs.existsSync(good.archivePath), true);
            assert.equal(client.objects.size, 1);
            const mismatch = new MemoryOss();
            const head = mismatch.head.bind(mismatch);
            mismatch.head = async key => { const response = await head(key); response.res.headers['x-oss-meta-sha256'] = 'wrong'; return response; };
            await assert.rejects(backupDatabase(config, { client: mismatch }), /verif|验证/i);
            assert.equal(mismatch.calls.some(call => call.key.endsWith('.manifest.json')), false);
            assert.equal(fs.readdirSync(config.directory).filter(name => name.startsWith('sqlite-backup-') && fs.existsSync(path.join(config.directory, name, 'uploaded.json'))).length, 1);
        } finally { db.close(); }
    });

    await test('concurrent runs are rejected and exclusion is released after a crash', async () => {
        const { root, db, config } = fixture('lock');
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const client = new MemoryOss();
        const put = client.put.bind(client);
        let entered;
        const start = new Promise(resolve => { entered = resolve; });
        client.put = async (...args) => { entered(); await gate; return put(...args); };
        const first = backupDatabase(config, { client });
        try {
            await start;
            await assert.rejects(backupDatabase(config, { client: new MemoryOss() }), /running|lock|运行|锁/i);
            release();
            await first;
            const script = path.join(root, 'crash.cjs');
            fs.writeFileSync(script, `const { backupDatabase } = require(${JSON.stringify(moduleFile)}); backupDatabase(${JSON.stringify(config)}, {client: {put: async () => {process.send('locked'); await new Promise(() => setInterval(() => {}, 1000));}}}).catch(e => {console.error(e); process.exit(1);});`);
            const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            try {
                await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('lock child exited early'); })]);
                const exited = once(child, 'exit');
                child.kill();
                await exited;
            } finally { if (child.exitCode == null && child.signalCode == null) child.kill(); }
            assert.equal((await backupDatabase(config, { client: new MemoryOss() })).uploaded, true);
        } finally { release(); await first.catch(() => {}); db.close(); }
    });

    await test('CLI help is inert and local rehearsal works from a different cwd', async () => {
        const { root, db, config } = fixture('cli', true);
        try {
            const envFile = path.join(root, 'test.env');
            const logDir = path.join(root, 'logs');
            fs.writeFileSync(envFile, `DB_FILE=${config.dbFile.replace(/\\/g, '/')}\nBACKUP_DIR=${config.directory.replace(/\\/g, '/')}\nLOG_DIR=${logDir.replace(/\\/g, '/')}\nLOG_TO_CONSOLE=false\nLOG_TO_FILE=true\nLOG_LEVEL=info\n`);
            const hook = path.join(root, 'guard.cjs');
            fs.writeFileSync(hook, `const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if(String(file) === ${JSON.stringify(path.join(BACKEND_ROOT, '.env'))}) throw new Error('test must not read real .env'); return read.call(this,file,...args); };`);
            const env = { ...process.env };
            for (const key of Object.keys(env)) if (key.startsWith('BACKUP_') || key === 'DB_FILE') delete env[key];
            Object.assign(env, { LOG_DIR: logDir, LOG_LEVEL: 'info', LOG_TO_FILE: 'true', LOG_TO_CONSOLE: 'false' });
            const help = spawnSync(process.execPath, ['--require', hook, cli, '--help'], { cwd: root, env, encoding: 'utf8' });
            assert.equal(help.status, 0, help.stderr);
            assert.match(help.stdout, /local-only/);
            assert.equal(fs.existsSync(logDir), false, 'help must not initialize log files');
            const denied = spawnSync(process.execPath, ['--require', hook, cli, '--local-only'], { cwd: root, env, encoding: 'utf8' });
            assert.notEqual(denied.status, 0);
            assert.match(denied.stderr, /Cannot read the environment file/);
            assert.match(fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('\n'), /Cannot read the environment file/);
            const run = spawnSync(process.execPath, ['--require', hook, cli, '--local-only', '--config', envFile], { cwd: root, env, encoding: 'utf8' });
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /local|本地/i);
            const logs = fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('\n');
            assert.match(logs, /database\.backup\.completed/);
            const failedEnv = path.join(root, 'failed.env');
            fs.writeFileSync(failedEnv, fs.readFileSync(envFile, 'utf8').replace(config.dbFile.replace(/\\/g, '/'), path.join(root, 'missing.sqlite').replace(/\\/g, '/')));
            const failed = spawnSync(process.execPath, [cli, '--local-only', '--config', failedEnv], { cwd: root, env, encoding: 'utf8' });
            assert.notEqual(failed.status, 0);
            assert.match(fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('\n'), /database\.backup\.failed/);
            const unknown = spawnSync(process.execPath, [cli, '--unknown'], { cwd: root, env, encoding: 'utf8' });
            assert.notEqual(unknown.status, 0);
            const missing = spawnSync(process.execPath, [cli, '--config', path.join(root, 'not-there.env')], { cwd: root, env, encoding: 'utf8' });
            assert.notEqual(missing.status, 0);
            assert.match(missing.stderr, /requested environment file does not exist/, `Unexpected missing-file failure: ${missing.stderr}`);
            assert.match(fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('\n'), /requested environment file does not exist/);
        } finally { db.close(); }
    });
    console.log(`${passed} database backup cases passed (temporary SQLite and simulated OSS only).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
});
