// 旧的修改记录（评论）存的是整段字段对比，如「描述：旧全文 → 新全文」。现在只记录描述里新增的文字
// （改前 123、改后 123456 记 456，规则见 modules/places/services/placeEditDiff.js）。本脚本把已有记录改成新格式。
// 默认只预览，不写库。
//
//   npm run edit-comments:rewrite                              预览（backend/data.sqlite 或 DB_FILE）
//   npm run edit-comments:rewrite -- --db ../snapshot.sqlite   预览另一个数据库文件
//   npm run edit-comments:rewrite -- --verbose                 逐条列出改前改后
//   npm run edit-comments:rewrite -- --apply                   备份数据库后写入
//   npm run edit-comments:rewrite -- --apply --delete-empty    同时删除没有新增描述文字的记录
//
// 只处理地点修改产生的记录（PlaceRevision.path 为 owner_edit / admin_edit / request_approved），新地点的创建者描述不动：
//  1. 有新增描述文字的：Comment.content 改成新增的文字；
//  2. 没有新增描述文字的（只改了店名、分类、人均、图片、位置，或只删了字）：默认保留原样；加 --delete-empty 才删除。
//     删除会写入 DeletedEditComment（回填不再生成），并按删除评论的既有规则作废这些作者的研究数据包。
// 修改历史仍完整保存在 PlaceRevision；评分和评分文本证据（RatingTextEvidence）不动。
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
const { backendPath } = require('../../infrastructure/paths');
const { editCommentText } = require('../../modules/places/services/placeEditDiff');

function resolveDbFile(args) {
    const index = args.indexOf('--db');
    const value = index >= 0 ? args[index + 1] : String(process.env.DB_FILE || '').trim();
    if (!value) return backendPath('data.sqlite');
    return path.isAbsolute(value) ? value : path.resolve(index >= 0 ? process.cwd() : backendPath(), value);
}

function plan(sql) {
    const rows = sql.prepare(`SELECT c.id, c.place_id, c.content, r.before_state, r.after_state FROM Comment c
        JOIN PlaceRevision r ON r.id = c.place_revision_id
        WHERE r.before_state IS NOT NULL AND r.path IN ('owner_edit', 'admin_edit', 'request_approved') ORDER BY c.id`).all();
    const rewrite = [], empty = [];
    for (const row of rows) {
        let text;
        try { text = editCommentText(JSON.parse(row.before_state), JSON.parse(row.after_state)); } catch { continue; }
        if (!text) empty.push(row);
        else if (text !== row.content) rewrite.push({ ...row, text });
    }
    return { total: rows.length, rewrite, empty };
}

const short = (value) => { const text = String(value || '').replace(/\s+/g, ' '); return text.length > 80 ? `${text.slice(0, 80)}…` : text; };

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply'), deleteEmpty = args.includes('--delete-empty');
    const dbFile = resolveDbFile(args);
    const sql = new Database(dbFile, { fileMustExist: true, readonly: !apply });
    sql.pragma('busy_timeout = 5000');
    try {
        const { total, rewrite, empty } = plan(sql);
        console.log(`数据库：${dbFile}`);
        console.log(`地点修改记录 ${total} 条：${rewrite.length} 条改成只含新增的描述文字，${empty.length} 条没有新增描述文字（${deleteEmpty ? '将删除' : '保留原样，加 --delete-empty 删除'}），其余已是新格式。`);
        if (args.includes('--verbose')) {
            for (const row of rewrite) console.log(`  评论 ${row.id}（地点 ${row.place_id}）\n    改前：${short(row.content)}\n    改后：${short(row.text)}`);
            for (const row of empty) console.log(`  评论 ${row.id}（地点 ${row.place_id}）无新增描述：${short(row.content)}`);
        }
        if (!rewrite.length && !(deleteEmpty && empty.length)) { console.log('\n没有需要改的记录。'); return; }
        if (!apply) { console.log('\n这是预览，未写库。加 --verbose 逐条列出，确认无误后加 --apply 执行。'); return; }

        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const backup = `${dbFile}.pre-edit-comment-rewrite-${stamp}.bak`;
        await sql.backup(backup);
        console.log(`\n数据库已备份：${backup}`);
        const result = sql.transaction(() => {
            const update = sql.prepare('UPDATE Comment SET content = ? WHERE id = ? AND content = ?');
            const remove = sql.prepare('DELETE FROM Comment WHERE id = ?');
            let updated = 0, removed = 0;
            for (const row of rewrite) updated += update.run(row.text, row.id, row.content).changes;
            if (deleteEmpty) for (const row of empty) removed += remove.run(row.id).changes;
            return { updated, removed };
        }).immediate();
        console.log(`已改写 ${result.updated} 条${deleteEmpty ? `，已删除 ${result.removed} 条` : ''}。`);
    } finally {
        sql.close();
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
