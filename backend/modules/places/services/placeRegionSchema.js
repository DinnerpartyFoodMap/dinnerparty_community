'use strict';

// 地点的省 / 市 / 区（services/placeRegions.js）。单独一张表：Place 的 UPDATE 会推进评分算法时钟，补齐地区不能碰它。
// lat / lng 是查询时的坐标，地点挪了位置后对不上，后台会重新查。
function initPlaceRegionSchema(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS PlaceRegion (
        place_id INTEGER PRIMARY KEY REFERENCES Place(id) ON DELETE CASCADE,
        province TEXT,
        city TEXT,
        district TEXT,
        adcode TEXT,
        lat REAL,
        lng REAL,
        checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_place_region_names ON PlaceRegion(province, city, district);`);
}

module.exports = { initPlaceRegionSchema };
