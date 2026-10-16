const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const { backendPath } = require('./paths');

const JOB_PATTERN = /^sqlite-backup-\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
const ARTIFACTS = ['snapshot.sqlite.gz', 'manifest.json', 'uploaded.json'];

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

function integer(env, key, fallback, min, max) {
    const text = String(env[key] ?? fallback).trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
        throw failure('BACKUP_CONFIG', `${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
}

function readBackupConfig(env = process.env, { localOnly = false } = {}) {
    const config = {
        dbFile: backendPath(String(env.DB_FILE || '').trim() || 'data.sqlite'),
        directory: backendPath(String(env.BACKUP_DIR || '').trim() || 'backups'),
        keepLocal: integer(env, 'BACKUP_LOCAL_KEEP', 3, 1, 365),
        attempts: integer(env, 'BACKUP_UPLOAD_ATTEMPTS', 3, 1, 10),
        timeoutMs: integer(env, 'BACKUP_UPLOAD_TIMEOUT_MS', 120000, 1000, 900000),
        localOnly,
        prefix: String(env.BACKUP_OSS_PREFIX || 'food-map/sqlite').trim().replace(/^\/+|\/+$/g, '')
    };
    if (!config.prefix || /[\x00-\x1f\\]/.test(config.prefix) || config.prefix.split('/').some(part => !part || part === '.' || part === '..')) {
        throw failure('BACKUP_CONFIG', 'BACKUP_OSS_PREFIX must be a nonempty object prefix without traversal segments.');
    }
    if (!localOnly) {
        const names = {
            region: 'BACKUP_OSS_REGION', bucket: 'BACKUP_OSS_BUCKET',
            accessKeyId: 'BACKUP_OSS_ACCESS_KEY_ID', accessKeySecret: 'BACKUP_OSS_ACCESS_KEY_SECRET'
        };
        config.oss = {};
        for (const [key, name] of Object.entries(names)) {
            config.oss[key] = String(env[name] || '').trim();
            if (!config.oss[key]) throw failure('BACKUP_CONFIG', `${name} is required (image OSS settings are not used).`);
        }
        if (!/^oss-[a-z0-9-]+$/.test(config.oss.region)) throw failure('BACKUP_CONFIG', 'BACKUP_OSS_REGION must look like oss-cn-hangzhou.');
        if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.oss.bucket)) throw failure('BACKUP_CONFIG', 'BACKUP_OSS_BUCKET must be a valid bucket name.');
        const endpoint = String(env.BACKUP_OSS_ENDPOINT || '').trim();
        if (endpoint) {
            let url;
            try { url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`); } catch { /* validated below */ }
            if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
                throw failure('BACKUP_CONFIG', 'BACKUP_OSS_ENDPOINT must be an HTTPS hostname without credentials or a path.');
            }
            config.oss.endpoint = url.origin;
        }
        const stsToken = String(env.BACKUP_OSS_STS_TOKEN || '').trim();
        if (stsToken) config.oss.stsToken = stsToken;
    }
    return config;
}

// This database is an OS-backed mutex only. Its exclusive transaction never
// touches the business database, and the OS releases it even after a hard exit.
function acquireLock(directory) {
    let lock;
    try {
        lock = new Database(path.join(directory, '.backup-lock.sqlite'), { timeout: 0 });
        lock.exec('CREATE TABLE IF NOT EXISTS BackupLock (id INTEGER PRIMARY KEY)');
        lock.exec('BEGIN EXCLUSIVE');
        return lock;
    } catch (error) {
        if (lock?.open) lock.close();
        if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
            throw failure('BACKUP_RUNNING', 'A database backup is already running for this backup directory.');
        }
        throw failure('BACKUP_LOCK', 'Cannot acquire the backup directory lock. Check its permissions.');
    }
}

async function digestFile(file, algorithm = 'sha256', encoding = 'hex') {
    const digest = crypto.createHash(algorithm);
    await pipeline(fs.createReadStream(file), digest);
    return digest.digest(encoding);
}

function verifySnapshot(file) {
    // The source uses WAL. Normalize the finished destination only, so the
    // gzip is self-contained and read-only verification leaves no sidecars.
    const destination = new Database(file, { fileMustExist: true });
    try { destination.pragma('journal_mode = DELETE'); } finally { destination.close(); }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        // Read-only schema inspection does not initialize any business tables.
        const vector = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(sql) LIKE '%using vec0%'").get();
        if (vector) require('sqlite-vec').load(db);
        const rows = db.pragma('quick_check');
        if (!rows.length || rows.some(row => Object.values(row)[0] !== 'ok')) {
            throw failure('BACKUP_INTEGRITY', 'The database snapshot failed SQLite quick_check.');
        }
    } finally { db.close(); }
}

function createClient(config) {
    const OSS = require('ali-oss');
    return new OSS({ ...config.oss, secure: true, authorizationV4: true, timeout: config.timeoutMs, retryMax: 0 });
}

async function verifyObject(client, key, bytes, hash, timeoutMs) {
    const result = await client.head(key, { timeout: timeoutMs });
    const headers = result?.res?.headers || {};
    if (result?.res?.status !== 200 || Number(headers['content-length']) !== bytes || headers['x-oss-meta-sha256'] !== hash) {
        throw failure('BACKUP_VERIFY', 'Uploaded object verification failed (size or SHA-256 metadata mismatch).');
    }
}

async function uploadObject(client, config, key, file, hash, contentType) {
    const bytes = (await fsp.stat(file)).size;
    const contentMd5 = await digestFile(file, 'md5', 'base64');
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
        try {
            try {
                await client.put(key, file, { timeout: config.timeoutMs, headers: {
                    'Content-Type': contentType, 'Cache-Control': 'no-store',
                    'Content-MD5': contentMd5,
                    'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
                    'x-oss-meta-sha256': hash
                } });
            } catch {
                // PUT may have reached OSS even when its acknowledgement was
                // lost. HEAD also makes forbid-overwrite retries idempotent.
                await verifyObject(client, key, bytes, hash, config.timeoutMs);
                return;
            }
            await verifyObject(client, key, bytes, hash, config.timeoutMs);
            return;
        } catch {
            if (attempt === config.attempts) {
                // SDK errors can contain credential-bearing request details.
                throw failure('BACKUP_UPLOAD', `OSS upload or verification failed after ${config.attempts} attempt(s). Local backup files were preserved.`);
            }
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
    }
}

async function pruneSuccessfulJobs(directory, keepLocal) {
    const completed = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_PATTERN.test(entry.name)) continue;
        const job = path.join(directory, entry.name);
        try {
            const markerFile = path.join(job, 'uploaded.json');
            if (!(await fsp.lstat(markerFile)).isFile()) continue;
            const marker = JSON.parse(await fsp.readFile(markerFile, 'utf8'));
            if (marker.formatVersion !== 1 || marker.jobName !== entry.name || !Number.isFinite(Date.parse(marker.uploadedAt))) continue;
            completed.push({ job, name: entry.name, uploadedAt: Date.parse(marker.uploadedAt) });
        } catch { /* Incomplete or unrelated jobs never qualify for pruning. */ }
    }
    completed.sort((a, b) => b.uploadedAt - a.uploadedAt || b.name.localeCompare(a.name));
    const warnings = [];
    for (const { job } of completed.slice(keepLocal)) {
        try {
            // Delete only these three regular artifacts, never recurse into a
            // user-supplied directory or follow a symlink during retention.
            const entries = await fsp.readdir(job, { withFileTypes: true });
            if (entries.length !== ARTIFACTS.length || entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !ARTIFACTS.includes(entry.name))) continue;
            if (path.dirname(path.resolve(job)) !== path.resolve(directory)) throw new Error('outside backup root');
            for (const file of ARTIFACTS) await fsp.unlink(path.join(job, file));
            await fsp.rmdir(job);
        } catch { warnings.push('An old local backup could not be removed; check backup directory permissions.'); }
    }
    return warnings;
}

async function backupDatabase(config, { client } = {}) {
    let source;
    let lock;
    let directory;
    try {
        let stat;
        try { stat = await fsp.stat(config.dbFile); } catch { throw failure('BACKUP_SOURCE', 'The source database does not exist or cannot be read. Check DB_FILE.'); }
        if (!stat.isFile() || !stat.size) throw failure('BACKUP_SOURCE', 'The source database is empty or is not a regular database file.');
        await fsp.mkdir(config.directory, { recursive: true, mode: 0o700 });
        const relativeSource = path.relative(await fsp.realpath(config.directory), await fsp.realpath(config.dbFile));
        if (!relativeSource || (!path.isAbsolute(relativeSource) && relativeSource !== '..' && !relativeSource.startsWith(`..${path.sep}`))) {
            throw failure('BACKUP_SOURCE', 'The source database must be outside the backup directory used for retention.');
        }
        lock = acquireLock(config.directory);
        const snapshotStartedAt = new Date().toISOString();
        const jobName = `sqlite-backup-${snapshotStartedAt.replace(/[-:.]/g, '')}-${crypto.randomUUID()}`;
        directory = path.join(config.directory, jobName);
        await fsp.mkdir(directory, { mode: 0o700 });
        const snapshot = path.join(directory, 'snapshot.sqlite');
        const archivePath = path.join(directory, 'snapshot.sqlite.gz');
        const manifestPath = path.join(directory, 'manifest.json');
        source = new Database(config.dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
        await source.backup(snapshot);
        source.close();
        source = null;
        const snapshotCompletedAt = new Date().toISOString();
        verifySnapshot(snapshot);
        const sqliteSha256 = await digestFile(snapshot);
        const sqliteBytes = (await fsp.stat(snapshot)).size;
        await pipeline(fs.createReadStream(snapshot), zlib.createGzip(), fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
        const manifest = {
            formatVersion: 1, snapshotStartedAt, snapshotCompletedAt,
            databaseFile: path.basename(config.dbFile), sqliteBytes, sqliteSha256,
            archiveFile: 'snapshot.sqlite.gz', archiveBytes: (await fsp.stat(archivePath)).size,
            archiveSha256: await digestFile(archivePath)
        };
        await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fsp.unlink(snapshot);
        const result = { directory, archivePath, manifestPath, manifest, uploaded: false, objectKeys: null, warnings: [] };
        if (config.localOnly) return result;
        const oss = client || createClient(config);
        const date = snapshotStartedAt.slice(0, 10).replace(/-/g, '/');
        const baseKey = `${config.prefix}/${date}/${jobName}`;
        const objectKeys = { archive: `${baseKey}.sqlite.gz`, manifest: `${baseKey}.manifest.json` };
        await uploadObject(oss, config, objectKeys.archive, archivePath, manifest.archiveSha256, 'application/gzip');
        await uploadObject(oss, config, objectKeys.manifest, manifestPath, await digestFile(manifestPath), 'application/json');
        await fsp.writeFile(path.join(directory, 'uploaded.json'), JSON.stringify({
            formatVersion: 1, jobName, uploadedAt: new Date().toISOString(), objectKeys
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        result.uploaded = true;
        result.objectKeys = objectKeys;
        result.warnings = await pruneSuccessfulJobs(config.directory, config.keepLocal);
        return result;
    } catch (error) {
        if (String(error.code || '').startsWith('BACKUP_')) throw error;
        throw failure('BACKUP_FAILED', `Database backup failed${directory ? `; recovery files were preserved in ${directory}` : ''}. Check database and local directory permissions and available disk space.`);
    } finally {
        if (source?.open) source.close();
        if (lock?.open) { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close(); }
    }
}

module.exports = { readBackupConfig, backupDatabase };
