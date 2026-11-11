// 合并相同或相近的地点标签（合并表见 modules/places/categoryMerges.json）。默认只预览，不写库。
//
//   npm run categories:merge                          预览（backend/data.sqlite 或 DB_FILE）
//   npm run categories:merge -- --db ../snapshot.sqlite   预览另一个数据库文件
//   npm run categories:merge -- --apply               备份数据库后写入
//
// 写入内容（同一事务）：
//  1. Place.category：合并的标签换成保留的标签，同一地点重复的去掉，顺序不变；不改 updated_time / updated_by
//     （这不是住民的修改）；
//  2. 待处理的地点修改申请（PlaceRequest.status = 'pending'）里 proposed.category 同样换掉；
//  3. Category 表：保留的标签不存在时新建，is_common 取两者中常用的、sort_order 取较小的；删除合并掉的标签。
// 已审核的申请、修订历史不动。之后新写入的地点由 placeService.normalizeCategoryList 自动换成保留的标签。
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { backendPath } = require('../../infrastructure/paths');
const { canonicalCategoryName, canonicalCategoryNames, categoryMergeEntries } = require('../../modules/places/services/categoryMerges');

function parseCategoryNames(value) {
    return String(value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

/** 一个标签串合并后的结果；没有变化时返回 null */
function mergeCategoryText(value) {
    const before = parseCategoryNames(value);
    // 只改含合并标签的地点：其他地点的写法（空格、全角逗号）保持原样
    if (!before.some((name) => canonicalCategoryName(name) !== name)) return null;
    return canonicalCategoryNames(before).join(', ');
}

function resolveDbFile(args) {
    const index = args.indexOf('--db');
    const value = index >= 0 ? args[index + 1] : String(process.env.DB_FILE || '').trim();
    if (!value) return backendPath('data.sqlite');
    return path.isAbsolute(value) ? value : path.resolve(index >= 0 ? process.cwd() : backendPath(), value);
}

function validateMergeTable() {
    const entries = categoryMergeEntries();
    const sources = new Set(entries.map((entry) => entry.source.toLowerCase()));
    const chained = entries.filter((entry) => sources.has(entry.target.toLowerCase()));
    if (chained.length) {
        throw new Error(`合并表里保留的标签又被合并：${chained.map((entry) => `${entry.source} → ${entry.target}`).join('，')}`);
    }
    return entries;
}

function plan(sql) {
    const places = sql.prepare("SELECT id, name, category FROM Place WHERE category IS NOT NULL AND trim(category) <> ''").all();
    const placeChanges = [];
    const usage = new Map(); // source → 用到它的地点数
    for (const place of places) {
        const next = mergeCategoryText(place.category);
        if (next == null) continue;
        placeChanges.push({ id: place.id, name: place.name, from: place.category, to: next });
        for (const name of parseCategoryNames(place.category)) {
            if (canonicalCategoryName(name) !== name) usage.set(name, (usage.get(name) || 0) + 1);
        }
    }

    const requestChanges = [];
    for (const request of sql.prepare("SELECT id, proposed FROM PlaceRequest WHERE status = 'pending' AND proposed IS NOT NULL").all()) {
        let proposed;
        try { proposed = JSON.parse(request.proposed); } catch (e) { continue; }
        if (!proposed || typeof proposed.category !== 'string') continue;
        const next = mergeCategoryText(proposed.category);
        if (next == null) continue;
        requestChanges.push({ id: request.id, proposed: JSON.stringify({ ...proposed, category: next }), from: proposed.category, to: next });
    }

    const categories = sql.prepare('SELECT id, name, is_common, sort_order FROM Category').all();
    const byName = new Map(categories.map((row) => [row.name.toLowerCase(), row]));
    const categoryChanges = [];
    for (const row of categories) {
        const target = canonicalCategoryName(row.name);
        if (target === row.name) continue;
        categoryChanges.push({ source: row, target, existing: byName.get(target.toLowerCase()) || null });
    }
    return { placeChanges, requestChanges, categoryChanges, usage };
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const dbFile = resolveDbFile(args);
    const entries = validateMergeTable();
    const sql = new Database(dbFile, { fileMustExist: true });
    sql.pragma('busy_timeout = 5000');
    try {
        const { placeChanges, requestChanges, categoryChanges, usage } = plan(sql);
        console.log(`数据库：${dbFile}`);
        console.log(`合并表 ${entries.length} 条；需要改动 ${placeChanges.length} 个地点、${requestChanges.length} 条待处理申请、${categoryChanges.length} 个标签记录`);
        console.log('\n按合并表：');
        for (const entry of entries) {
            const count = [...usage.entries()].filter(([name]) => name.toLowerCase() === entry.source.toLowerCase()).reduce((sum, [, n]) => sum + n, 0);
            const inTable = categoryChanges.some((change) => change.source.name.toLowerCase() === entry.source.toLowerCase());
            if (!count && !inTable) continue;
            console.log(`  ${entry.source} → ${entry.target}  ${count} 个地点${inTable ? '' : '（标签表里没有）'}`);
        }
        if (args.includes('--verbose')) {
            console.log('\n地点：');
            for (const change of placeChanges) console.log(`  ${change.id}「${change.name}」 ${change.from} → ${change.to}`);
        }
        for (const change of requestChanges) console.log(`  申请 ${change.id}：${change.from} → ${change.to}`);
        if (!placeChanges.length && !requestChanges.length && !categoryChanges.length) {
            console.log('\n没有需要合并的标签。');
            return;
        }
        if (!apply) {
            console.log('\n这是预览，未写库。加 --verbose 列出每个地点，确认无误后加 --apply 执行。');
            return;
        }

        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const backup = `${dbFile}.pre-category-merge-${stamp}.bak`;
        await sql.backup(backup);
        console.log(`\n数据库已备份：${backup}`);

        const run = sql.transaction(() => {
            const setPlace = sql.prepare('UPDATE Place SET category = ? WHERE id = ? AND category = ?');
            let places = 0;
            for (const change of placeChanges) places += setPlace.run(change.to, change.id, change.from).changes;
            const setRequest = sql.prepare("UPDATE PlaceRequest SET proposed = ? WHERE id = ? AND status = 'pending'");
            for (const change of requestChanges) setRequest.run(change.proposed, change.id);

            const insert = sql.prepare('INSERT OR IGNORE INTO Category (name, is_common, sort_order, created_by) VALUES (?, ?, ?, NULL)');
            const update = sql.prepare('UPDATE Category SET is_common = MAX(is_common, ?), sort_order = MIN(sort_order, ?) WHERE name = ? COLLATE NOCASE');
            const remove = sql.prepare('DELETE FROM Category WHERE id = ?');
            for (const { source, target } of categoryChanges) {
                insert.run(target, source.is_common ? 1 : 0, source.sort_order);
                update.run(source.is_common ? 1 : 0, source.sort_order, target);
                remove.run(source.id);
            }
            // 地点里出现、标签表里还没有的保留标签（启动时 database.init 也会补，这里先补上）
            for (const change of placeChanges) {
                for (const name of parseCategoryNames(change.to)) insert.run(name, 0, 1000);
            }
            return places;
        });
        const updated = run();
        console.log(`已合并：${updated} 个地点、${requestChanges.length} 条申请、${categoryChanges.length} 个标签记录。`);
    } finally {
        sql.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error && error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = { mergeCategoryText };
