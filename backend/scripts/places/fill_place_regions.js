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
    const total = regions.countPendingPlaces();
    console.log(`数据库：${db._raw.name}\n需要查询省市区的地点：${total} 个`);
    if (dryRun || !total) return;
    let done = 0;
    for (;;) {
        const result = await regions.refreshPendingBatch();
        done += result.checked;
        process.stdout.write(`\r已查询 ${done} / ${total}`);
        if (!result.more) break;
        await new Promise((resolve) => setTimeout(resolve, 400)); // 高德 Web 服务的并发限制
    }
    const unresolved = db._raw.prepare('SELECT COUNT(*) AS n FROM PlaceRegion WHERE province IS NULL').get().n;
    console.log(`\n完成。没有省市区（境外或高德无结果）的地点：${unresolved} 个`);
}

main().catch((error) => {
    console.error(`\n${error && error.message || error}`);
    process.exitCode = 1;
});
