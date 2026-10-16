// 修复地点图片字段（Place.exterior_images / menu_images）。在正式服务器上运行（要读真实的 backend/uploads/）。
//
//  1. 损坏的 JSON：2024-12 ~ 2025-04 导入的一批数据，数组项缺结尾引号、用 \r\n 分隔、有的缺结尾 "]，
//     前端解析失败后整组图片不显示、编辑面板也打不开。逐项取出地址，重新写成标准 JSON 数组。
//  2. 失效图片（--drop-missing）：指向本站 uploads、但文件已不存在的地址（早期 uploads/<目录>/<文件名>
//     那批，包括上面 snapshot_temp_*_thumb.jpeg 都从未上传成功）。前端显示为裂图，从数组里移除。
//
//   node scripts/images/repair_place_images.js                        预演：列出每条记录修复前后，不写入
//   node scripts/images/repair_place_images.js --drop-missing         预演，同时列出要移除的失效图片
//   node scripts/images/repair_place_images.js --drop-missing --apply 备份数据库后写入
//
// 应在 migrate_uploads_to_oss.js 之前运行。可重复执行；取不出合法地址的记录原样保留并列出。
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const imageStorage = require('../../modules/media/services/imageStorage');

const APPLY = process.argv.includes('--apply');
const DROP_MISSING = process.argv.includes('--drop-missing');
const FIELDS = ['exterior_images', 'menu_images'];
// 失效比例超过这个值时多半是在没有图片文件的机器上运行（例如本地开发库），拒绝移除
const MAX_MISSING_RATIO = 0.1;
// 每项必须是完整的图片地址（以图片扩展名结尾），避免把被截断的地址当成有效数据
const ITEM = /^(?:https?:\/\/|\/)[^\s"'<>]+\.(?:jpe?g|jfif|png|webp|gif)$/i;

/** 损坏的数组文本 → 地址列表；无法可靠拆分时返回 null */
function repairList(text) {
    const body = String(text).trim();
    if (!body.startsWith('[')) return null;
    const items = body.slice(1).replace(/\]\s*$/, '')
        .split(/,\s*(?=["']?(?:https?:\/\/|\/))/i)
        .map((part) => part.trim().replace(/^["']+|["',\s]+$/g, '').trim())
        .filter(Boolean);
    if (!items.length || !items.every((item) => ITEM.test(item))) return null;
    return items;
}

/** 本站本地图片且文件不存在 → true；外部地址、OSS 地址一律视为有效 */
function isMissingLocal(url, exists) {
    const name = imageStorage.localUploadName(url);
    return !!name && !exists(name);
}

function localFileExists(name) {
    return imageStorage.isSafeName(name) && fs.existsSync(path.join(imageStorage.LOCAL_UPLOAD_DIR, name));
}

/**
 * 逐条计算修复结果。返回 updates（需写入的字段）、unfixable（无法拆分的损坏记录）和本地图片引用统计。
 * @param {(name: string) => boolean} exists uploads 下相对路径是否存在
 */
function collect(sql, { dropMissing, exists }) {
    const updates = [];
    const unfixable = [];
    const stats = { localRefs: 0, missingRefs: 0 };
    for (const row of sql.prepare('SELECT id, name, exterior_images, menu_images FROM Place').all()) {
        const next = {};
        const notes = [];
        for (const field of FIELDS) {
            const text = row[field];
            if (!text) continue;
            let items;
            let repaired = false;
            try {
                items = JSON.parse(text);
            } catch {
                items = repairList(text);
                if (!items) {
                    unfixable.push(`地点 ${row.id}（${row.name}）${field}`);
                    continue;
                }
                repaired = true;
            }
            if (!Array.isArray(items)) continue;
            const missing = items.filter((url) => isMissingLocal(url, exists));
            stats.localRefs += items.filter((url) => imageStorage.localUploadName(url)).length;
            stats.missingRefs += missing.length;
            const kept = dropMissing ? items.filter((url) => !missing.includes(url)) : items;
            if (!repaired && kept.length === items.length) continue;
            next[field] = JSON.stringify(kept);
            notes.push({ field, before: text, kept, dropped: dropMissing ? missing : [], repaired, missing });
        }
        if (Object.keys(next).length) updates.push({ row, next, notes });
    }
    return { updates, unfixable, stats };
}

async function main() {
    const { db, init } = require('../../infrastructure/database');
    init();
    const sql = db._raw;
    const { updates, unfixable, stats } = collect(sql, { dropMissing: DROP_MISSING, exists: localFileExists });

    for (const { row, notes } of updates) {
        console.log(`\n地点 ${row.id}（${row.name}）`);
        for (const note of notes) {
            const what = [note.repaired ? '修复损坏 JSON' : '', note.dropped.length ? `移除失效图片 ${note.dropped.length} 张` : ''].filter(Boolean).join('，');
            console.log(`  ${note.field}：${what}`);
            if (note.repaired) console.log(`    修复前原文：${JSON.stringify(note.before)}`);
            for (const url of note.dropped) console.log(`    - ${url}`);
            if (note.repaired && !DROP_MISSING) for (const url of note.missing) console.log(`    （文件不存在）${url}`);
            console.log(`    保留 ${note.kept.length} 张${note.kept.length ? '：' : ''}`);
            for (const url of note.kept) console.log(`    + ${url}`);
        }
    }

    const ratio = stats.localRefs ? stats.missingRefs / stats.localRefs : 0;
    console.log(`\n本地图片引用 ${stats.localRefs} 个，其中文件不存在 ${stats.missingRefs} 个（${(ratio * 100).toFixed(1)}%），uploads 目录：${imageStorage.LOCAL_UPLOAD_DIR}`);
    if (DROP_MISSING && stats.missingRefs && ratio > MAX_MISSING_RATIO) {
        console.log(`失效比例超过 ${MAX_MISSING_RATIO * 100}%，看起来不是在存放图片的服务器上运行，已停止（未写入）。`);
        process.exitCode = 3;
        try { db.close(); } catch (_) { }
        return;
    }
    if (!DROP_MISSING && stats.missingRefs) console.log('加 --drop-missing 可同时移除这些失效图片。');
    console.log(`${APPLY ? '写入' : '预演（加 --apply 才会写入）'}：需要修改的地点 ${updates.length} 个`);
    for (const line of unfixable) console.log(`  无法自动修复（原样保留）：${line}`);
    if (unfixable.length) process.exitCode = 2;

    if (APPLY && updates.length) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const backup = `${sql.name}.pre-image-repair-${stamp}.bak`;
        await sql.backup(backup);
        console.log(`数据库已备份：${backup}`);
        let written = 0;
        // 写事务里重新计算，备份期间有人编辑过的地点按最新内容处理
        sql.transaction(() => {
            for (const { row, next } of collect(sql, { dropMissing: DROP_MISSING, exists: localFileExists }).updates) {
                for (const [field, value] of Object.entries(next)) {
                    written += sql.prepare(`UPDATE Place SET ${field} = ? WHERE id = ?`).run(value, row.id).changes;
                }
            }
        }).immediate();
        console.log(`已写入 ${written} 个字段`);
    }
    try { db.close(); } catch (_) { }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('修复失败：', error.message);
        process.exitCode = 1;
    });
}

module.exports = { repairList, collect };
