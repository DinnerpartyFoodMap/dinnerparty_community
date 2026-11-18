'use strict';

const Database = require('better-sqlite3');
const { backendPath } = require('../../infrastructure/paths');

async function migrate(sql) {
    const storage = require('../../modules/media/services/imageStorage');
    if (!storage.isOssEnabled()) throw new Error('请先设置 IMAGE_STORAGE=oss');
    const errors = storage.configErrors();
    if (errors.length) throw new Error(errors.join('；'));

    const pending = 'avatar_blob IS NOT NULL AND avatar_url IS NULL';
    const ids = sql.prepare(`SELECT id FROM User WHERE ${pending} ORDER BY id`).pluck().all();
    const read = sql.prepare(`SELECT avatar_blob FROM User WHERE id = ? AND ${pending}`).pluck();
    const link = sql.prepare(`UPDATE User SET avatar_url = ?, avatar_blob = NULL
        WHERE id = ? AND avatar_url IS NULL AND avatar_blob = ?`);
    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    let cleanupFailed = 0;

    for (const id of ids) {
        const bytes = read.get(id);
        if (!bytes) {
            skipped += 1;
            continue;
        }
        let url;
        try {
            url = await storage.saveAvatarImage(bytes);
            if (link.run(url, id, bytes).changes === 1) {
                migrated += 1;
                continue;
            }
            skipped += 1;
        } catch (error) {
            failed += 1;
            console.error(`迁移头像失败（${error.code || error.name}）`);
        }
        if (url) {
            try { await storage.removeAvatarImage(url); }
            catch (error) {
                cleanupFailed += 1;
                console.error(`清理未采用的 OSS 对象失败（${error.code || error.name}）`);
            }
        }
    }
    console.log(`已迁移 ${migrated} 个，已变更而跳过 ${skipped} 个，失败 ${failed} 个，对象清理失败 ${cleanupFailed} 个`);
    if (failed || cleanupFailed) process.exitCode = 2;
}

async function main() {
    if (process.argv.includes('--help')) {
        console.log('npm run avatars:migrate-oss -- [--apply]');
        return;
    }
    require('dotenv').config({ path: backendPath('.env') });
    const apply = process.argv.includes('--apply');
    const file = backendPath(String(process.env.DB_FILE || '').trim() || 'data.sqlite');
    const sql = new Database(file, { readonly: !apply, fileMustExist: true });
    try {
        const columns = new Set(sql.pragma('table_info(User)').map(({ name }) => name));
        if (columns.size === 0) throw new Error('目标数据库没有 User 表');
        if (apply && !columns.has('avatar_url')) throw new Error('请先部署新版后端，初始化头像地址列');
        const urlCondition = columns.has('avatar_url') ? ' AND avatar_url IS NULL' : '';
        const count = columns.has('avatar_blob')
            ? sql.prepare(`SELECT COUNT(*) FROM User WHERE avatar_blob IS NOT NULL${urlCondition}`).pluck().get()
            : 0;
        console.log(`${apply ? '执行' : '只读预演'}：待迁移 ${count} 个`);
        if (apply && count > 0) await migrate(sql);
    } finally {
        sql.close();
    }
}

main().catch((error) => {
    console.error('头像迁移失败：', error.message);
    process.exitCode = 1;
});
