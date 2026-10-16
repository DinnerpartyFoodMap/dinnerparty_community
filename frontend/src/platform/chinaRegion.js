// 高德的“境内”范围：高德坐标转换（AMap.convertFrom，gps → GCJ-02）只偏移落在下表 1°×1° 格子里的点，
// 格子外按 WGS-84 原样返回，高德地图在那里也按 WGS-84 显示。2026-10 用转换服务逐格实测得到，
// 边界恰好落在整数经纬度上。范围比国界外扩约一格（如海参崴、新义州、廷布算境内，平壤、加德满都、石垣岛不算），
// 并覆盖港澳台与南海。
// 本地 WGS-84 → GCJ-02 转换与海外底图的覆盖范围都以它为准，才能与高德自身一致。
//
// 每行：[纬度格 floor(lat), [[起始经度格, 结束经度格], ...]]，经度格为 floor(lng)，区间两端都包含。
const AMAP_GCJ_CELLS = [
    [53, [[120, 125]]], [52, [[120, 126]]], [51, [[119, 126]]], [50, [[119, 127]]],
    [49, [[86, 87], [116, 129]]], [48, [[85, 88], [115, 130], [133, 134]]],
    [47, [[82, 83], [85, 90], [115, 134]]], [46, [[82, 90], [116, 134]]],
    [45, [[80, 92], [111, 112], [114, 133]]], [44, [[79, 95], [111, 131]]],
    [43, [[80, 96], [110, 131]]], [42, [[79, 102], [106, 131]]],
    [41, [[76, 128]]], [40, [[73, 125]]], [39, [[73, 124]]], [38, [[73, 123]]],
    [37, [[74, 123]]], [36, [[74, 124]]], [35, [[76, 124]]], [34, [[78, 124]]],
    [33, [[78, 124]]], [32, [[78, 125]]], [31, [[78, 127]]], [30, [[79, 127]]],
    [29, [[82, 127]]], [28, [[84, 127]]], [27, [[87, 89], [91, 126]]], [26, [[92, 93], [98, 125]]],
    [25, [[97, 124]]], [24, [[97, 122]]], [23, [[97, 122]]], [22, [[99, 122]]],
    [21, [[99, 101], [106, 122]]], [20, [[108, 121]]], [19, [[107, 120]]], [18, [[107, 119]]],
    [17, [[108, 118]]], [16, [[109, 118]]], [15, [[110, 118]]], [14, [[110, 118]]],
    [13, [[110, 118]]], [12, [[110, 118]]], [11, [[110, 118]]], [10, [[110, 117]]],
    [9, [[109, 116]]], [8, [[108, 116]]], [7, [[108, 115]]], [6, [[108, 114]]],
    [5, [[108, 113]]], [4, [[109, 112]]], [3, [[109, 111]]]
];

const ROWS = new Map(AMAP_GCJ_CELLS);

function rowHasCellIn(runs, fromLng, toLng) {
    return !!runs && runs.some(([a, b]) => a <= toLng && b >= fromLng);
}

/** 该点是否在高德的“境内”格子里（即高德会对它做 GCJ-02 偏移）。 */
export function isInAmapChinaRegion(lng, lat) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    const cell = Math.floor(lng);
    return rowHasCellIn(ROWS.get(Math.floor(lat)), cell, cell);
}

/** 经纬度矩形是否碰到任何境内格子（贴边也算）。 */
export function rectTouchesAmapChinaRegion(west, south, east, north) {
    const fromLng = Math.floor(west), toLng = Math.floor(east);
    for (let lat = Math.floor(south); lat <= Math.floor(north); lat++) {
        if (rowHasCellIn(ROWS.get(lat), fromLng, toLng)) return true;
    }
    return false;
}

/** 经纬度矩形是否完全落在境内格子里（只要有一格在境外就返回 false）。 */
export function rectWithinAmapChinaRegion(west, south, east, north) {
    const fromLng = Math.floor(west), toLng = Math.floor(east);
    for (let lat = Math.floor(south); lat <= Math.floor(north); lat++) {
        const runs = ROWS.get(lat);
        if (!runs || !runs.some(([a, b]) => a <= fromLng && b >= toLng)) return false;
    }
    return true;
}
