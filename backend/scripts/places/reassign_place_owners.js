// 按 CSV 把地点的所有者（Place.creator_id）改成 qq 列对应的住民。默认只预览，不写库。
//
// CSV 需要表头「名称」「qq」（其余列忽略），UTF-8，可带 BOM：
//   名称,创建人,qq
//   酱饼摊,alipay_森近霖之助,1714284791
//
//   npm run places:reassign-owners -- import.csv            预览
//   npm run places:reassign-owners -- import.csv --apply    备份数据库后写入
//
// 规则：
//  1. qq 在 User.qq 里找不到住民 → 跳过该行；
//  2. 名称在 Place 里找不到 → 跳过该行；
//  3. 同名地点有多个时：CSV 里该名称的所有行 qq 都相同 → 同名地点全部改给这个人；
//     否则行数与地点数相等时按 CSV 行序对应地点 id 从小到大，不相等就整组跳过（需手动处理）；
//  4. 原最近修改人（updated_by）就是原所有者时一并改掉，否则卡片的「最近修改」仍显示原账号；
//     别人改过的地点保留 updated_by；
//  5. 原所有者的创建评分（PlaceRating.source 为 create / migration）转给新所有者，分数、来源和创建时间不变，
//     权重取新所有者的；新所有者已经评过这家店时保留他的评分，只删掉原所有者那条。原所有者自己通过评分
//     接口打的分（source = user）不动。删除 + 插入会触发两人的偏好重算，并各记一条评分历史（RatingRevision）。
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

/** 解析 CSV（支持双引号字段、字段内逗号和换行），返回字符串数组的数组。 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((cell) => cell.trim())) rows.push(row);
            row = [];
        } else field += ch;
    }
    row.push(field);
    if (row.some((cell) => cell.trim())) rows.push(row);
    return rows;
}

/** 读取 CSV，返回 [{ line, name, qq }]（line 为文件中的行号）。 */
function readEntries(file) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const header = (rows.shift() || []).map((cell) => cell.trim());
    const nameIndex = header.indexOf('名称');
    const qqIndex = header.findIndex((cell) => cell.toLowerCase() === 'qq');
    if (nameIndex < 0 || qqIndex < 0) throw new Error(`CSV 表头缺少「名称」或「qq」列：${header.join(',')}`);
    return rows.map((row, index) => ({
        line: index + 2,
        name: String(row[nameIndex] || '').trim(),
        qq: String(row[qqIndex] || '').trim(),
    }));
}

const SCORE_LABELS = { 4: '强烈推荐', 3: '均线之上', 2: '均线之下', 1: '强烈拒绝' };
const CREATION_SOURCES = ['create', 'migration'];
const RATING_ORIGIN = 'owner_reassign';

function hasTable(sql, name) {
    return !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 原所有者那条评分要怎么处理：none 没有 / personal 自己打的不动 / move 转给新所有者 / drop 新所有者已评过，删掉。 */
function ratingAction(sql, placeId, fromId, toId) {
    if (!hasTable(sql, 'PlaceRating')) return { kind: 'none' };
    const findRating = sql.prepare('SELECT * FROM PlaceRating WHERE place_id = ? AND user_id = ?');
    const old = fromId ? findRating.get(placeId, fromId) : null;
    if (!old) return { kind: 'none' };
    if (!CREATION_SOURCES.includes(old.source)) return { kind: 'personal', old };
    return { kind: findRating.get(placeId, toId) ? 'drop' : 'move', old };
}

function describeRating(rating) {
    const label = rating.old ? SCORE_LABELS[rating.old.score] || rating.old.score : '';
    switch (rating.kind) {
        case 'move': return `，创建评分「${label}」一并转移`;
        case 'drop': return `，新所有者已评过，删除原创建评分「${label}」`;
        case 'personal': return `，原所有者自己的评分「${label}」保留`;
        default: return '';
    }
}

/** 在事务里把原所有者的创建评分转给新所有者，返回实际执行的 kind。 */
function moveCreatorRating(sql, change, now) {
    const rating = ratingAction(sql, change.placeId, change.fromId, change.toId);
    if (rating.kind !== 'move' && rating.kind !== 'drop') return rating.kind;
    const withHistory = hasTable(sql, 'RatingRevision') && hasTable(sql, 'RatingStream');
    const { appendRatingRevision } = withHistory ? require('../../modules/ratings/services/ratingHistory') : {};
    const { old } = rating;

    sql.prepare('DELETE FROM PlaceRating WHERE place_id = ? AND user_id = ?').run(change.placeId, change.fromId);
    if (withHistory) {
        appendRatingRevision({ userId: change.fromId, placeId: change.placeId, before: old, after: null, action: 'withdraw', origin: RATING_ORIGIN, now });
    }
    if (rating.kind === 'drop') return 'drop';

    const weight = (hasTable(sql, 'UserReputation')
        && sql.prepare('SELECT weight FROM UserReputation WHERE user_id = ?').get(change.toId)?.weight) || 0.5;
    sql.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at, weight)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(change.placeId, change.toId, old.score, old.source, old.created_at, now, weight);
    if (withHistory) {
        const after = sql.prepare('SELECT * FROM PlaceRating WHERE place_id = ? AND user_id = ?').get(change.placeId, change.toId);
        appendRatingRevision({ userId: change.toId, placeId: change.placeId, before: null, after, action: 'create', origin: RATING_ORIGIN, now });
    }
    return 'move';
}

/** 计算改动，返回 { changes, skipped }；不写库。 */
function plan(sql, entries) {
    const findUser = sql.prepare('SELECT id, username FROM User WHERE qq = ?');
    const findPlaces = sql.prepare(
        `SELECT p.id, p.name, p.creator_id, p.updated_by, u.username AS creator_name
         FROM Place p LEFT JOIN User u ON p.creator_id = u.id
         WHERE p.name = ? ORDER BY p.id`
    );
    const skipped = [];
    const groups = new Map();
    for (const entry of entries) {
        if (!entry.name || !entry.qq) { skipped.push({ ...entry, reason: '名称或 qq 为空' }); continue; }
        const user = findUser.get(entry.qq);
        if (!user) { skipped.push({ ...entry, reason: `qq ${entry.qq} 没有对应住民` }); continue; }
        if (!groups.has(entry.name)) groups.set(entry.name, []);
        groups.get(entry.name).push({ ...entry, user });
    }

    const changes = [];
    for (const [name, rows] of groups) {
        const places = findPlaces.all(name);
        if (!places.length) {
            for (const row of rows) skipped.push({ ...row, reason: '找不到同名地点' });
            continue;
        }
        let pairs;
        if (rows.every((row) => row.user.id === rows[0].user.id)) {
            pairs = places.map((place) => ({ place, row: rows[0] }));
        } else if (rows.length === places.length) {
            pairs = places.map((place, index) => ({ place, row: rows[index] }));
        } else {
            for (const row of rows) {
                skipped.push({ ...row, reason: `同名地点 ${places.length} 个、CSV ${rows.length} 行且 qq 不一致，无法对应` });
            }
            continue;
        }
        for (const { place, row } of pairs) {
            if (place.creator_id === row.user.id) continue;
            changes.push({
                line: row.line,
                placeId: place.id,
                name,
                from: place.creator_name || place.creator_id || '无',
                fromId: place.creator_id,
                to: row.user.username,
                toId: row.user.id,
                qq: row.qq,
                updateModifier: place.updated_by == null || place.updated_by === place.creator_id,
                rating: ratingAction(sql, place.id, place.creator_id, row.user.id),
            });
        }
    }
    return { changes, skipped };
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const csvArg = args.find((arg) => !arg.startsWith('--'));
    if (!csvArg) {
        console.log('用法：npm run places:reassign-owners -- <file.csv> [--apply]');
        process.exitCode = 1;
        return;
    }
    const entries = readEntries(path.resolve(process.cwd(), csvArg));

    const { db } = require('../../infrastructure/database');
    const sql = db._raw;
    try {
        const { changes, skipped } = plan(sql, entries);
        console.log(`数据库：${sql.name}`);
        console.log(`CSV ${entries.length} 行，需要改动 ${changes.length} 个地点，跳过 ${skipped.length} 行`);
        for (const change of changes) {
            console.log(`  第 ${change.line} 行 地点 ${change.placeId}「${change.name}」 ${change.from} → ${change.to}（qq ${change.qq}）${describeRating(change.rating)}`);
        }
        if (skipped.length) {
            console.log('\n跳过：');
            for (const row of skipped) console.log(`  第 ${row.line} 行「${row.name}」 — ${row.reason}`);
        }
        if (!changes.length) return;
        if (!apply) {
            console.log('\n这是预览，未写库。确认无误后加 --apply 执行。');
            return;
        }

        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const backup = `${sql.name}.pre-reassign-${stamp}.bak`;
        await sql.backup(backup);
        console.log(`\n数据库已备份：${backup}`);

        const setOwner = sql.prepare('UPDATE Place SET creator_id = ? WHERE id = ? AND creator_id IS ?');
        const setOwnerAndModifier = sql.prepare('UPDATE Place SET creator_id = ?, updated_by = ? WHERE id = ? AND creator_id IS ?');
        const run = sql.transaction(() => {
            const now = Date.now();
            const counts = { updated: 0, move: 0, drop: 0, personal: 0, none: 0 };
            for (const change of changes) {
                const result = change.updateModifier
                    ? setOwnerAndModifier.run(change.toId, change.toId, change.placeId, change.fromId)
                    : setOwner.run(change.toId, change.placeId, change.fromId);
                if (!result.changes) continue; // 预览之后所有者又变了，不再动它的评分
                counts.updated++;
                counts[moveCreatorRating(sql, change, now)]++;
            }
            return counts;
        });
        const counts = run.immediate();
        console.log(`已改动 ${counts.updated} 个地点；创建评分转移 ${counts.move} 条，`
            + `新所有者已评过而删除 ${counts.drop} 条，原所有者自己的评分保留 ${counts.personal} 条。`);
    } finally {
        try { db.close(); } catch (_) { }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('执行失败：', error.message);
        process.exitCode = 1;
    });
}

module.exports = { parseCsv, readEntries, plan, ratingAction };
