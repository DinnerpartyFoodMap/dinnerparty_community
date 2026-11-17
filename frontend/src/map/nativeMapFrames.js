// iOS 原生底图（MapKit）的坐标校准：苹果在每个地区用 GCJ-02 还是 WGS-84，取决于手机在哪
// （手机在大陆是高德版：大陆、港澳台为 GCJ-02；在港澳台或境外是全球版：港澳台为 WGS-84），而且没有接口能查。
// 这里用苹果自己的地点搜索查几个位置固定的地标：返回的坐标靠近地标的 GCJ-02 还是 WGS-84，就是这台手机上该地区的底图坐标。
//
// 店铺坐标按高德的规则存（高德境内格子里是 GCJ-02，含港澳台；格子外是 WGS-84）。
// 底图在某地区用 WGS-84 时，交给原生前把这个地区的店转成 WGS-84，读回（点地图、相机中心）时再转回来；
// 校准失败或没结论的地区不换算（大陆用户的情况）。
import { isInAmapChinaRegion } from '../platform/chinaRegion.js';
import { wgs84ToGcj02Raw, gcj02ToWgs84Raw } from '../platform/coordTransform.js';

export const FRAME_REGIONS = Object.freeze(['mainland', 'hk', 'mo', 'tw']);
export const FRAMES_STORAGE_KEY = 'foodmap.nativeMapFrames';
// 缓存的校准结果只在这段时间内用作启动时的初值（随后照常重新校准）
export const FRAMES_CACHE_MS = 6 * 60 * 60 * 1000;
// 搜索结果离地标超过这个距离就不是同一个地方
const PROBE_MATCH_METERS = 3000;
const PROBE_RADIUS_METERS = 3000;

// 香港：沿深圳湾与深圳河的粗略多边形（[经度, 纬度]），界河附近误差约 200 米，那里几乎没有店
const HK_POLYGON = [
    [113.82, 22.19], [113.83, 22.40], [113.86, 22.42], [113.955, 22.495], [114.02, 22.512],
    [114.068, 22.519], [114.09, 22.525], [114.113, 22.532], [114.13, 22.542], [114.152, 22.562],
    [114.17, 22.56], [114.226, 22.546], [114.31, 22.55], [114.38, 22.49], [114.45, 22.43],
    [114.51, 22.40], [114.51, 22.15], [114.30, 22.13], [113.95, 22.13]
];
// 澳门：半岛、氹仔、路环（西侧沿十字门水道，避开横琴）
const MO_POLYGON = [
    [113.531, 22.217], [113.556, 22.218], [113.575, 22.200], [113.600, 22.170], [113.605, 22.110],
    [113.555, 22.105], [113.553, 22.120], [113.553, 22.160], [113.540, 22.172], [113.528, 22.185]
];
// 台湾本岛与澎湖（西北边沿台湾海峡，不含福建沿海与金门、马祖）
const TW_POLYGON = [
    [119.25, 23.15], [119.25, 23.90], [120.40, 24.80], [121.30, 25.40], [122.10, 25.20],
    [122.10, 22.00], [120.70, 21.80], [120.00, 22.40]
];

function pointInPolygon(lng, lat, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** 店铺坐标属于哪个校准地区；高德境内格子以外是 abroad（两边都是 WGS-84，不换算） */
export function frameRegion(lng, lat) {
    if (!isInAmapChinaRegion(lng, lat)) return 'abroad';
    if (pointInPolygon(lng, lat, HK_POLYGON)) return 'hk';
    if (pointInPolygon(lng, lat, MO_POLYGON)) return 'mo';
    if (pointInPolygon(lng, lat, TW_POLYGON)) return 'tw';
    return 'mainland';
}

function toWgs(lng, lat) {
    const p = gcj02ToWgs84Raw(lng, lat);
    return [p.lng, p.lat];
}

function toGcj(lng, lat) {
    const p = wgs84ToGcj02Raw(lng, lat);
    return [p.lng, p.lat];
}

/**
 * 校准地标：每个地区两个，名称有中文与英文（手机语言不同也能搜到）。
 * 大陆的参考坐标取高德的 GCJ-02（天安门是高德示例的默认中心），其余取公开资料的 WGS-84。
 */
const PROBE_SOURCES = [
    { id: 'mainland-tiananmen', region: 'mainland', names: ['天安门', 'Tiananmen'], gcj: [116.397428, 39.90923] },
    { id: 'mainland-pearl', region: 'mainland', names: ['东方明珠广播电视塔', 'Oriental Pearl Tower'], gcj: [121.499718, 31.239703] },
    { id: 'hk-ifc', region: 'hk', names: ['国际金融中心二期', 'Two International Finance Centre'], wgs: [114.1589, 22.2853] },
    { id: 'hk-hkcec', region: 'hk', names: ['香港会议展览中心', 'Hong Kong Convention and Exhibition Centre'], wgs: [114.1736, 22.2833] },
    { id: 'mo-stpaul', region: 'mo', names: ['大三巴牌坊', 'Ruins of St. Paul'], wgs: [113.5409, 22.1975] },
    { id: 'mo-tower', region: 'mo', names: ['澳门旅游塔', 'Macau Tower'], wgs: [113.5364, 22.1800] },
    { id: 'tw-101', region: 'tw', names: ['台北101', 'Taipei 101'], wgs: [121.5645, 25.0337] },
    { id: 'tw-station', region: 'tw', names: ['台北车站', 'Taipei Main Station'], wgs: [121.5170, 25.0478] }
];

export const FRAME_PROBES = Object.freeze(PROBE_SOURCES.map((probe) => {
    const wgs = probe.wgs || toWgs(probe.gcj[0], probe.gcj[1]);
    const gcj = probe.gcj || toGcj(probe.wgs[0], probe.wgs[1]);
    return Object.freeze({ id: probe.id, region: probe.region, names: probe.names, wgs, gcj });
}));

/** 交给原生搜索的参数：在地标附近 3 公里内搜（两套坐标相差几百米，都在范围内） */
export function nativeProbeRequests(probes = FRAME_PROBES) {
    return probes.map((probe) => ({ id: probe.id, names: probe.names, lng: probe.wgs[0], lat: probe.wgs[1], radius: PROBE_RADIUS_METERS }));
}

export function distanceMeters(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 一个地标的结论：在搜到的点里取离地标最近的一个，它离 GCJ-02 参考点明显更近是 'gcj'，离 WGS-84 明显更近是 'wgs'，
 * 否则（没搜到、搜到别处、落在中间）为 null。“明显”：离一边不到两套坐标间距的 0.6，且只有另一边距离的一半。
 * @param {{ wgs: number[], gcj: number[] }} probe
 * @param {number[][]} points  原生搜到的 [经度, 纬度]
 */
export function decideProbe(probe, points) {
    const separation = distanceMeters(probe.wgs, probe.gcj);
    if (!(separation > 100)) return null;
    let best = null;
    for (const point of Array.isArray(points) ? points : []) {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
        const dWgs = distanceMeters(point, probe.wgs);
        const dGcj = distanceMeters(point, probe.gcj);
        const near = Math.min(dWgs, dGcj);
        if (near > PROBE_MATCH_METERS) continue;
        if (!best || near < best.near) best = { dWgs, dGcj, near };
    }
    if (!best || best.near > separation * 0.6) return null;
    if (best.dGcj < best.dWgs * 0.5) return 'gcj';
    if (best.dWgs < best.dGcj * 0.5) return 'wgs';
    return null;
}

/**
 * 各地区的结论：同一地区的地标都没矛盾时采用（只有一个有结论也算），有矛盾或都没结论时不写（不换算）。
 * @param {Array<{ id: string, points: number[] }>} results  原生返回：points 为扁平的 [经度, 纬度, 经度, 纬度, …]
 * @returns {{ mainland?: 'gcj'|'wgs', hk?: 'gcj'|'wgs', mo?: 'gcj'|'wgs', tw?: 'gcj'|'wgs' }}
 */
export function decideFrames(results, probes = FRAME_PROBES) {
    const byId = new Map();
    for (const result of Array.isArray(results) ? results : []) {
        const flat = Array.isArray(result?.points) ? result.points : [];
        const points = [];
        for (let i = 0; i + 1 < flat.length; i += 2) points.push([Number(flat[i]), Number(flat[i + 1])]);
        if (typeof result?.id === 'string') byId.set(result.id, points);
    }
    const votes = new Map();
    for (const probe of probes) {
        const decision = decideProbe(probe, byId.get(probe.id));
        if (!decision) continue;
        if (!votes.has(probe.region)) votes.set(probe.region, new Set());
        votes.get(probe.region).add(decision);
    }
    const frames = {};
    for (const region of FRAME_REGIONS) {
        const set = votes.get(region);
        if (set && set.size === 1) frames[region] = [...set][0];
    }
    return frames;
}

/** 店铺坐标 → 交给 MapKit 的坐标 */
export function toNativeCoordinate(lng, lat, frames) {
    const region = frameRegion(lng, lat);
    if (region === 'abroad' || frames?.[region] !== 'wgs') return [lng, lat];
    return toWgs(lng, lat);
}

/** MapKit 的坐标 → 店铺坐标（点地图、相机中心、可见范围） */
export function fromNativeCoordinate(lng, lat, frames) {
    const region = frameRegion(lng, lat);
    if (region === 'abroad' || frames?.[region] !== 'wgs') return [lng, lat];
    return toGcj(lng, lat);
}

export function sameFrames(a, b) {
    return FRAME_REGIONS.every((region) => (a?.[region] || null) === (b?.[region] || null));
}

export function readCachedFrames(now = Date.now(), storage = globalThis.localStorage) {
    try {
        const saved = JSON.parse(storage.getItem(FRAMES_STORAGE_KEY) || 'null');
        if (!saved || typeof saved !== 'object' || !(now - Number(saved.at) < FRAMES_CACHE_MS)) return null;
        const frames = {};
        for (const region of FRAME_REGIONS) {
            if (saved.frames?.[region] === 'gcj' || saved.frames?.[region] === 'wgs') frames[region] = saved.frames[region];
        }
        return frames;
    } catch (e) {
        return null;
    }
}

export function saveCachedFrames(frames, now = Date.now(), storage = globalThis.localStorage) {
    try { storage.setItem(FRAMES_STORAGE_KEY, JSON.stringify({ frames, at: now })); } catch (e) { /* 存不了就每次重新校准 */ }
}
