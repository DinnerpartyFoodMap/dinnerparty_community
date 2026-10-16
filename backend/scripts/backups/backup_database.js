const path = require('node:path');
const fs = require('node:fs');

async function main(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Usage: node scripts/backups/backup_database.js [--local-only] [--config <env-file>]\n\nCreate and verify a SQLite snapshot, gzip it, and upload it to private backup OSS.\n--local-only  Rehearse locally without OSS credentials or network calls.\n--config      Use an explicit environment file instead of backend/.env.\n--help        Show this help without loading configuration or opening a database.');
        return;
    }
    let localOnly = false;
    let envFile = path.resolve(__dirname, '../../.env');
    let explicitEnv = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--local-only' && !localOnly) localOnly = true;
        else if (args[i] === '--config' && !explicitEnv && args[i + 1] && !args[i + 1].startsWith('--')) {
            envFile = path.resolve(args[++i]);
            explicitEnv = true;
        } else throw Object.assign(new Error('Unknown or incomplete argument. Use --help for usage.'), { code: 'BACKUP_ARGUMENT' });
    }
    let logger;
    const startedAt = Date.now();
    try {
        if (explicitEnv && !fs.existsSync(envFile)) throw Object.assign(new Error('The requested environment file does not exist.'), { code: 'BACKUP_CONFIG' });
        const loaded = require('dotenv').config({ path: envFile });
        if (loaded.error && (explicitEnv || loaded.error.code !== 'ENOENT')) {
            throw Object.assign(new Error('Cannot read the environment file.'), { code: 'BACKUP_CONFIG' });
        }
        logger = require('../../infrastructure/logger');
        const { readBackupConfig, backupDatabase } = require('../../infrastructure/databaseBackup');
        const result = await backupDatabase(readBackupConfig(process.env, { localOnly }));
        logger.info('Database backup completed', {
            event: 'database.backup.completed', uploaded: result.uploaded, directory: result.directory,
            objectKeys: result.objectKeys, archiveBytes: result.manifest.archiveBytes,
            durationMs: Date.now() - startedAt
        });
        console.log(`${result.uploaded ? 'OSS backup verified' : 'Local backup verified (not uploaded)'}: ${result.directory}`);
        console.log(`Archive SHA-256: ${result.manifest.archiveSha256}`);
        if (result.objectKeys) console.log(`OSS manifest: ${result.objectKeys.manifest}`);
        for (const warning of result.warnings) {
            logger.warn(warning, { event: 'database.backup.retention_failed' });
            console.warn(warning);
        }
    } catch (error) {
        try {
            logger ||= require('../../infrastructure/logger');
            logger.error('Database backup failed', { event: 'database.backup.failed', error, durationMs: Date.now() - startedAt });
        } catch { /* Preserve the original error even if logging is unavailable. */ }
        throw error;
    } finally { if (logger) await logger.flush(); }
}

if (require.main === module) main().catch(error => {
    console.error(`Database backup failed [${String(error.code || 'BACKUP_FAILED')}]: ${error.message}`);
    process.exitCode = 1;
});

module.exports = { main };
