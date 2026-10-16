// 把 backend/uploads/ 里的地点图片迁到阿里云 OSS（对象键 `${OSS_PREFIX}/<原相对路径>`，含早期的
// uploads/<目录>/<文件名>），再把数据库里指向这些文件的地址改成 `${OSS_PUBLIC_BASE_URL}/${OSS_PREFIX}/<原相对路径>`。
//
//   node scripts/images/migrate_uploads_to_oss.js                 预演：检查 OSS 上已有哪些，统计要改的数据库地址，不写任何东西
//   node scripts/images/migrate_uploads_to_oss.js --apply         上传缺失文件 → 备份数据库 → 改写地址
//   node scripts/images/migrate_uploads_to_oss.js --apply --upload-only   只上传，不动数据库
//
// 可重复执行：OSS 上大小一致的文件跳过，已改过的地址不再匹配。本地文件不会删除。
// 只读 .env 里的 OSS_* 配置，不要求 IMAGE_STORAGE=oss（可先迁移、确认无误后再切换上传）。
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
process.env.IMAGE_STORAGE = 'oss';

const imageStorage = require('../../modules/media/services/imageStorage');

const APPLY = process.argv.includes('--apply');
const UPLOAD_ONLY = process.argv.includes('--upload-only');
const CONCURRENCY = 4;
// 只改写指向本站 uploads、且文件真实存在于本地 uploads 的地址（见 imageStorage.localUploadName）。
// 历史上有几条 JSON 损坏的记录（引号缺失），只能在原文里按地址替换；建议先跑 repair_place_images.js
const LOCAL_URL_IN_TEXT = new RegExp(`${imageStorage.LOCAL_UPLOAD_ORIGIN}/uploads/([A-Za-z0-9._/-]+)`, 'gi');

async function mapLimit(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

/** uploads 下所有文件的相对路径（正斜杠分隔，最多一层子目录） */
function listLocalFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const names = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) names.push(entry.name);
        else if (entry.isDirectory()) {
            for (const child of fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
                if (child.isFile()) names.push(`${entry.name}/${child.name}`);
            }
        }
    }
    return names.filter((name) => imageStorage.isSafeName(name));
}

async function syncFiles() {
    const dir = imageStorage.LOCAL_UPLOAD_DIR;
    const names = listLocalFiles(dir);
    const stats = { local: names.length, present: 0, uploaded: 0, wouldUpload: 0, failed: [] };
    const available = new Set();
    let done = 0;

    await mapLimit(names, CONCURRENCY, async (name) => {
        const file = path.join(dir, name);
        const size = fs.statSync(file).size;
        try {
            const remoteSize = await imageStorage.headObject(name);
            if (remoteSize === size) {
                stats.present++;
                available.add(name);
            } else if (APPLY) {
                await imageStorage.putObject(name, fs.readFileSync(file), imageStorage.contentTypeForName(name));
                stats.uploaded++;
                available.add(name);
            } else {
                stats.wouldUpload++;
                available.add(name); // 预演时按“上传成功”估算数据库改动
            }
        } catch (error) {
            // ali-oss 的网络错误消息会附带连接池状态，只保留第一句
            stats.failed.push(`${name}: ${error.code || ''} ${String(error.message).split(/[\n,]/)[0]}`.trim());
        }
        if (++done % 50 === 0 || done === names.length) console.log(`  文件 ${done}/${names.length}`);
    });
    return { stats, available };
}

function rewriteList(list, available, counters) {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const next = list.map((url) => {
        const name = imageStorage.localUploadName(url);
        if (!name) return url;
        const target = targetFor(name, available, counters);
        if (!target) return url;
        changed = true;
        return target;
    });
    return changed ? next : null;
}

function targetFor(rawName, available, counters) {
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch (_) { }
    if (!available.has(name)) {
        counters.missing.add(name);
        return null;
    }
    counters.urls++;
    return imageStorage.publicUrlFor(name);
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

/** 地点图片字段（JSON 数组字符串）→ 改写后的字符串；无改动返回 null。JSON 损坏时在原文里替换地址。 */
function rewriteField(text, available, counters, label) {
    if (!text) return null;
    const parsed = parseJson(text);
    if (Array.isArray(parsed)) {
        const next = rewriteList(parsed, available, counters);
        return next ? JSON.stringify(next) : null;
    }
    if (parsed !== null) return null;
    let changed = false;
    const next = text.replace(LOCAL_URL_IN_TEXT, (whole, name) => {
        const target = targetFor(name, available, counters);
        if (!target) return whole;
        changed = true;
        return target;
    });
    if (changed) counters.broken.add(label);
    return changed ? next : null;
}

function newCounters() {
    return { places: 0, requests: 0, urls: 0, missing: new Set(), broken: new Set() };
}

function collectUpdates(sql, available, counters) {
    const placeUpdates = [];
    const requestUpdates = [];
    for (const row of sql.prepare('SELECT id, exterior_images, menu_images FROM Place WHERE exterior_images IS NOT NULL OR menu_images IS NOT NULL').all()) {
        const exterior = rewriteField(row.exterior_images, available, counters, `地点 ${row.id}`);
        const menu = rewriteField(row.menu_images, available, counters, `地点 ${row.id}`);
        if (!exterior && !menu) continue;
        placeUpdates.push({ id: row.id, exterior: exterior || row.exterior_images, menu: menu || row.menu_images });
    }
    for (const row of sql.prepare('SELECT id, proposed FROM PlaceRequest WHERE proposed IS NOT NULL').all()) {
        const proposed = parseJson(row.proposed);
        if (!proposed || typeof proposed !== 'object') continue;
        let changed = false;
        for (const key of ['exterior_images', 'menu_images']) {
            const next = rewriteList(proposed[key], available, counters);
            if (next) { proposed[key] = next; changed = true; }
        }
        if (changed) requestUpdates.push({ id: row.id, proposed: JSON.stringify(proposed) });
    }
    counters.places = placeUpdates.length;
    counters.requests = requestUpdates.length;
    return { placeUpdates, requestUpdates };
}

async function rewriteDatabase(available) {
    const { db, init } = require('../../infrastructure/database');
    init();
    const sql = db._raw;
    let counters = newCounters();
    const planned = collectUpdates(sql, available, counters);

    if (APPLY && (planned.placeUpdates.length || planned.requestUpdates.length)) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const backup = `${sql.name}.pre-oss-${stamp}.bak`;
        await sql.backup(backup);
        console.log(`数据库已备份：${backup}`);
        const updatePlace = sql.prepare('UPDATE Place SET exterior_images = ?, menu_images = ? WHERE id = ?');
        const updateRequest = sql.prepare('UPDATE PlaceRequest SET proposed = ? WHERE id = ?');
        // 在写事务里重新读取再改写，服务运行中迁移也不会覆盖备份期间用户的修改
        counters = newCounters();
        sql.transaction(() => {
            const { placeUpdates, requestUpdates } = collectUpdates(sql, available, counters);
            for (const u of placeUpdates) updatePlace.run(u.exterior, u.menu, u.id);
            for (const u of requestUpdates) updateRequest.run(u.proposed, u.id);
        }).immediate();
    }
    try { db.close(); } catch (_) { }
    return counters;
}

async function main() {
    const errors = imageStorage.configErrors();
    if (errors.length) throw new Error(`OSS 配置错误：${errors.join('；')}`);
    const target = imageStorage.publicUrlFor('<文件名>');
    console.log(`${APPLY ? '执行' : '预演（加 --apply 才会写入）'}：${imageStorage.LOCAL_UPLOAD_DIR} → ${target}`);

    const { stats, available } = await syncFiles();
    console.log(`本地 ${stats.local} 个；OSS 已有 ${stats.present}；${APPLY ? `新上传 ${stats.uploaded}` : `待上传 ${stats.wouldUpload}`}；失败 ${stats.failed.length}`);
    for (const line of stats.failed.slice(0, 20)) console.log(`  失败 ${line}`);
    if (stats.failed.length) process.exitCode = 2;

    if (UPLOAD_ONLY) return;
    const counters = await rewriteDatabase(available);
    console.log(`${APPLY ? '已改写' : '将改写'}：地点 ${counters.places} 个、修改申请 ${counters.requests} 条、图片地址 ${counters.urls} 个`);
    if (counters.broken.size) {
        // 这些记录本身 JSON 就是坏的（前端解析失败、图片一直不显示），只替换了地址，需另行修复
        console.log(`JSON 损坏、已按原文替换地址的记录 ${counters.broken.size} 条：${[...counters.broken].join('、')}`);
    }
    if (counters.missing.size) {
        // 数据库引用了、但本地 uploads 里没有的文件：不改写，原地址照旧（本来就打不开或在别处）
        console.log(`本地缺失、未改写的文件 ${counters.missing.size} 个：`);
        for (const name of [...counters.missing].slice(0, 20)) console.log(`  ${name}`);
    }
}

main().catch((error) => {
    console.error('迁移失败：', error.message);
    process.exitCode = 1;
});
