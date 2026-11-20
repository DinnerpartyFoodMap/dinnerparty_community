'use strict';

// 场馆请求（denpawave → 饭联地图）：对端说「这个场馆该在地图上有一个点」，管理员人工建档后关联到 Place。
// 只存对端给的展示文字和自己人选的 place_id；不镜像活动生命周期，也没有坐标列（坐标系未确认前不落库）。
function initVenueRequestSchema(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS VenueRequest (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'denpawave',
        external_key TEXT NOT NULL,
        label TEXT NOT NULL,
        address TEXT,
        city TEXT,
        place_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_time DATETIME,
        handled_by TEXT,
        handled_time DATETIME,
        UNIQUE (source, external_key)
    );
    CREATE INDEX IF NOT EXISTS idx_venuerequest_status ON VenueRequest(status, id);
    CREATE INDEX IF NOT EXISTS idx_venuerequest_place ON VenueRequest(place_id);`);
}

module.exports = { initVenueRequestSchema };
