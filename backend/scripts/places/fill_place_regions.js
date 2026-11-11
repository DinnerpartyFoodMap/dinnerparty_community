// 一次补齐所有地点的省 / 市 / 区（高德逆地理编码，每次 20 个）。后端运行时后台也会慢慢补（services/placeRegions.js），
// 这个脚本用于新部署后立刻补完，或在别的数据库文件上运行（DB_FILE=...）。
//
//   npm run places:regions              补齐没查过 / 坐标变了的地点
//   npm run places:regions -- --dry-run 只统计数量
//
// 需要 backend/.env 里的 AMAP_WEB_SERVICE_KEY。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const { db } = require('../../infrastructure/database');
    const regions = require('../../modules/places/services/placeRegions');
    // 后端还没用新代码启动过时也能运行：先建表
    require('../../modules/places/services/placeRegionSchema').initPlaceRegionSchema(db._raw);
    const total = regions.countPendingPlaces();
    console.log(`数据库：${db._raw.name}\n需要查询省市区的地点：${total} 个`);
    if (dryRun || !total) return;
    let done = 0;
    const rejected = [];
    for (;;) {
        const result = await regions.refreshPendingBatch();
        done += result.checked;
        rejected.push(...(result.rejected || []));
        process.stdout.write(`\r已查询 ${done} / ${total}`);
        if (!result.more) break;
        await new Promise((resolve) => setTimeout(resolve, 400)); // 高德 Web 服务的并发限制
    }
    const unresolved = db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRegion WHERE province IS NULL').get().n;
    console.log(`\n完成。没有省市区（境外或高德无结果）的地点：${unresolved} 个`);
    if (rejected.length) {
        console.log(`其中 ${rejected.length} 个地点的坐标被高德拒绝（INVALID_PARAMS），记为没有省市区；坐标改正后会重新查询：`);
        const name = db._raw.prepare('SELECT name FROM Place WHERE id = ?');
        for (const place of rejected) console.log(`  #${place.id} ${name.get(place.id)?.name || ''}  经度 ${place.lng}  纬度 ${place.lat}`);
    }
}

main().catch((error) => {
    console.error(`\n${error && error.message || error}`);
    process.exitCode = 1;
});
