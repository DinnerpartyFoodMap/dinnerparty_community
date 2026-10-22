// 检查已有数据中地图无法显示的坐标。只读，不写库。在正式服务器上运行。
//
// 地图（Web Mercator）只画到纬度 ±85.0511°。修复前，在世界地图上下边界外的空白处点击能存进 85°~90° 的纬度，
// 前端标记层会丢掉这些点（frontend/src/map/cluster/engine.js），地点既不显示也点不开。
// 规则与 placeService 的新增 / 编辑 / 修改申请校验一致：
//  1. Place：纬度超出 ±PLACE_MAX_LATITUDE、经度超出 ±180、或不是有效数字的地点；
//  2. PlaceRequest：待审核申请里提议的坐标无效（审核批准会被拒绝，只能驳回）。
//
//   npm run places:check-coordinates        有问题时退出码为 2
//
// 这些地点在界面上点不到；确认真实位置后用创建者或管理员账号调用 PUT /places/<id> 改坐标，或 DELETE /places/<id> 删除。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { PLACE_MAX_LATITUDE, normalizePlaceCoordinates } = require('../../modules/places/services/placeService');

function hasTable(sql, name) {
    return !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** 返回 { places, requests }：坐标无效的地点，以及提议坐标无效的待审核申请。 */
function collect(sql) {
    const places = [];
    for (const row of sql.prepare(
        `SELECT p.id, p.name, p.latitude, p.longitude, p.created_time, p.creator_id, u.username AS creator_name
         FROM Place p LEFT JOIN User u ON p.creator_id = u.id
         ORDER BY p.id`
    ).all()) {
        const checked = normalizePlaceCoordinates({ latitude: row.latitude, longitude: row.longitude });
        if (checked.error) places.push({ ...row, error: checked.error });
    }
    const requests = [];
    if (hasTable(sql, 'PlaceRequest')) {
        for (const row of sql.prepare(
            `SELECT r.id, r.place_id, r.proposed, r.created_time, p.name AS place_name
             FROM PlaceRequest r LEFT JOIN Place p ON r.place_id = p.id
             WHERE r.status = 'pending'
             ORDER BY r.id`
        ).all()) {
            let proposed;
            try {
                proposed = JSON.parse(row.proposed);
            } catch {
                continue; // 无法解析的申请审核时另有报错，不属于坐标问题
            }
            if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) continue;
            const checked = normalizePlaceCoordinates(proposed);
            if (checked.error) {
                requests.push({ id: row.id, place_id: row.place_id, place_name: row.place_name, created_time: row.created_time,
                    latitude: proposed.latitude, longitude: proposed.longitude, error: checked.error });
            }
        }
    }
    return { places, requests };
}

const show = (value) => (value === undefined ? '（未提议）' : JSON.stringify(value));

function main() {
    const { db } = require('../../infrastructure/database');
    const sql = db._raw;
    try {
        if (!hasTable(sql, 'Place')) {
            console.log(`数据库里没有 Place 表：${sql.name}`);
            process.exitCode = 1;
            return;
        }
        const total = sql.prepare('SELECT COUNT(*) AS n FROM Place').get().n;
        const { places, requests } = collect(sql);
        console.log(`数据库：${sql.name}`);
        console.log(`有效范围：纬度 ±${PLACE_MAX_LATITUDE}°，经度 ±180°`);
        console.log(`\n地图无法显示的地点 ${places.length} 个（共 ${total} 个地点）`);
        for (const place of places) {
            console.log(`  地点 ${place.id}「${place.name}」 纬度 ${show(place.latitude)} 经度 ${show(place.longitude)} — ${place.error}`);
            console.log(`    创建者 ${place.creator_name || place.creator_id || '未知'}，创建于 ${place.created_time || '未知'}`);
        }
        console.log(`\n提议坐标无效的待审核修改申请 ${requests.length} 个（批准会被拒绝，可直接驳回）`);
        for (const request of requests) {
            console.log(`  申请 ${request.id} → 地点 ${request.place_id}「${request.place_name || '已不存在'}」 纬度 ${show(request.latitude)} 经度 ${show(request.longitude)} — ${request.error}`);
        }
        if (places.length) {
            console.log('\n这些地点在界面上点不到；确认真实位置后用创建者或管理员账号 PUT /places/<id> 改坐标，或 DELETE /places/<id> 删除。');
        }
        if (places.length || requests.length) process.exitCode = 2;
    } finally {
        try { db.close(); } catch (_) { }
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error('检查失败：', error.message);
        process.exitCode = 1;
    }
}

module.exports = { collect };
