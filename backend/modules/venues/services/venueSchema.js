'use strict';

// 场馆（denpawave → 饭联地图）：对端说「这个场馆该在地图上有一个点」，管理员在地图上落点。
//
// 一行是一条场馆记录，从推送进来（pending）到落点（placed）始终是同一行；「待办」只是
// status = 'pending' 的那批，不是另一种资源。
//
// 场馆不是地点：不进 Place，不被评分、不被搜索、不进随机推荐与群推送。这里只存对端给的展示文字
// 和管理员选中的坐标（GCJ-02，与地图同一坐标系），跳转时直接按坐标聚焦。
// 不镜像活动生命周期（没有活动日期、改名同步、取消发布），状态只由我们这边推进。
function initVenueSchema(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS Venue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'denpawave',
        external_key TEXT NOT NULL,
        label TEXT NOT NULL,
        address TEXT,
        city TEXT,
        latitude REAL,
        longitude REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_time DATETIME,
        placed_by TEXT,
        placed_time DATETIME,
        UNIQUE (source, external_key)
    );
    CREATE INDEX IF NOT EXISTS idx_venue_status ON Venue(status, id);`);
}

module.exports = { initVenueSchema };
