// WGS-84（GPS 原始坐标）→ GCJ-02（高德使用的坐标系）本地转换。
// 系统定位插件和浏览器定位返回 WGS-84；高德 IP 定位已返回 GCJ-02，不能再转换一次。
// 采用公开的近似算法，境外坐标原样返回；误差通常在数米以内。
// “境外”以高德自己的范围为准（见 chinaRegion.js）：常见的 72°E–137.8°E 粗矩形会把大阪、首尔等地也当成境内，
// 定位点因此偏出约 500 米。

import { isInAmapChinaRegion } from './chinaRegion.js';

const A = 6378245.0;
const EE = 0.00669342162296594323;

export function isOutOfChina(lng, lat) {
    return !isInAmapChinaRegion(lng, lat);
}

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
}

/** @returns {{lng: number, lat: number}} */
export function wgs84ToGcj02(lng, lat) {
    if (isOutOfChina(lng, lat)) return { lng, lat };
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return { lng: lng + dLng, lat: lat + dLat };
}
