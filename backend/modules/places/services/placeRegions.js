'use strict';

// 地点所在的省 / 市 / 区（高德逆地理编码），用于地图与列表按地区筛选。
//
// - 存在单独的 PlaceRegion 表，不写 Place：Place 的任何 UPDATE 都会推进评分算法的时钟（algorithmSchema.js 的触发器），
//   后台补齐几千个地点时不能让评分缓存全部失效。
// - 记录查询时的坐标（lat / lng）：地点挪了位置，坐标对不上，后台会重新查。
// - 后台任务（startPlaceRegionWorker）每次取最多 20 个没查过或坐标变了的地点，用高德 Web 服务批量逆地理编码
//   （AMAP_WEB_SERVICE_KEY，batch=true 一次 20 个）；新地点创建后 wakePlaceRegionWorker 立即补一次。
// - 境外坐标高德不返回行政区：记为已查、省市区为空。请求失败时不记录，等下一轮。
// - 直辖市的 city 是空的，用省名（北京市 / 北京市 / 朝阳区）；省直辖县级市 city 也是空的，用区县名。

const { db } = require('../../../infrastructure/database');
const { publicPlaceSql } = require('./placeVisibility');
const { initPlaceRegionSchema } = require('./placeRegionSchema');

const AMAP_REST_BASE = 'https://restapi.amap.com';
const REQUEST_TIMEOUT_MS = 10000;
const BATCH_SIZE = 20;
const IDLE_INTERVAL_MS = 60 * 1000;
const BUSY_INTERVAL_MS = 1500;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const TREE_CACHE_MS = 5 * 60 * 1000;

function webServiceKey() {
    return String(process.env.AMAP_WEB_SERVICE_KEY || '').trim();
}

const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** 高德 addressComponent → { province, city, district, adcode }；境外 / 没有行政区时返回 null */
function regionFromComponent(component) {
    if (!component || typeof component !== 'object') return null;
    const province = pick(component.province);
    if (!province) return null;
    const district = pick(component.district);
    // 直辖市（北京、上海、天津、重庆）city 为空：用省名；省直辖县级市 city 也为空：用区县名
    const city = pick(component.city) || (/^(北京|上海|天津|重庆)市$/.test(province) ? province : district) || province;
    return { province, city, district, adcode: pick(component.adcode) };
}

/**
 * 批量逆地理编码（最多 20 个点）：返回与输入同序的数组，元素为 region 或 null（境外 / 无结果）。
 * 没有配置 key、请求失败时抛错（调用方不记录，下一轮再试）。
 */
// 每秒请求数超限（个人 key 的 QPS 很低；后端的后台任务与补齐脚本同时跑时也会撞上）：等一会儿重试
const RATE_LIMIT_RETRY_MS = [1000, 2000, 4000, 8000];
const isRateLimited = (error) => !!error && /QPS|TOO_FREQUENT|OVER_LIMIT_PER_SECOND/i.test(String(error.info || ''));

async function reverseGeocodeRegions(points, options = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await requestRegions(points, options);
        } catch (error) {
            if (!isRateLimited(error) || attempt >= RATE_LIMIT_RETRY_MS.length) throw error;
            await new Promise((resolve) => setTimeout(resolve, (options.retryDelays || RATE_LIMIT_RETRY_MS)[attempt]));
        }
    }
}

async function requestRegions(points, { fetchImpl = fetch } = {}) {
    const key = webServiceKey();
    if (!key) throw new Error('AMAP_WEB_SERVICE_KEY 未配置');
    if (!points.length) return [];
    const location = points.map((point) => `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`).join('|');
    const query = new URLSearchParams({ location, batch: 'true', extensions: 'base', key });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(`${AMAP_REST_BASE}/v3/geocode/regeo?${query}`, { signal: controller.signal, redirect: 'error' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || String(data.status) !== '1') {
            const error = new Error(`高德逆地理编码失败：${data && (data.info || data.infocode) || response.status}`);
            error.info = data && data.info ? String(data.info) : null;
            error.location = location.slice(0, 200);
            throw error;
        }
        const list = Array.isArray(data.regeocodes) ? data.regeocodes : (data.regeocode ? [data.regeocode] : []);
        return points.map((_, index) => regionFromComponent(list[index] && list[index].addressComponent));
    } finally {
        clearTimeout(timer);
    }
}

/** 还没查过、或查过之后坐标变了的地点 */
function pendingPlaces(limit = BATCH_SIZE, sql = db._raw) {
    return sql.prepare(`SELECT p.id, p.latitude AS lat, p.longitude AS lng
        FROM Place p LEFT JOIN PlaceRegion r ON r.place_id = p.id
        WHERE p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180
          AND (r.place_id IS NULL OR r.lat IS NOT p.latitude OR r.lng IS NOT p.longitude)
        ORDER BY p.id DESC
        LIMIT ?`).all(limit);
}

function countPendingPlaces(sql = db._raw) {
    return sql.prepare(`SELECT COUNT(*) AS n FROM Place p LEFT JOIN PlaceRegion r ON r.place_id = p.id
        WHERE p.latitude BETWEEN -90 AND 90 AND p.longitude BETWEEN -180 AND 180
          AND (r.place_id IS NULL OR r.lat IS NOT p.latitude OR r.lng IS NOT p.longitude)`).get().n;
}

function saveRegions(places, regions, sql = db._raw) {
    const upsert = sql.prepare(`INSERT INTO PlaceRegion (place_id, province, city, district, adcode, lat, lng, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(place_id) DO UPDATE SET province = excluded.province, city = excluded.city, district = excluded.district,
            adcode = excluded.adcode, lat = excluded.lat, lng = excluded.lng, checked_at = excluded.checked_at`);
    const exists = sql.prepare('SELECT 1 FROM Place WHERE id = ?');
    const now = Date.now();
    sql.transaction(() => {
        places.forEach((place, index) => {
            if (!exists.get(place.id)) return; // 查询期间被删掉了
            const region = regions[index];
            upsert.run(place.id, region?.province ?? null, region?.city ?? null, region?.district ?? null, region?.adcode ?? null, place.lat, place.lng, now);
        });
    })();
    treeCache = null;
}

const PER_POINT_DELAY_MS = 400;
const isParamError = (error) => !!error && error.info === 'INVALID_PARAMS';

/**
 * 高德整批拒绝（INVALID_PARAMS：其中某个坐标它不接受）时逐个重查：被拒绝的点记为没有省市区（不再反复重查），
 * 并在 rejected 里返回，方便核对这些地点的坐标。每个点单独查也全被拒绝时不是数据问题（key / 参数格式），照常抛错、不记录。
 */
async function regionsOneByOne(places, options) {
    const regions = [];
    const rejected = [];
    for (const [index, place] of places.entries()) {
        if (index) await new Promise((resolve) => setTimeout(resolve, PER_POINT_DELAY_MS));
        try {
            regions.push((await reverseGeocodeRegions([place], options))[0]);
        } catch (error) {
            if (!isParamError(error)) throw error;
            regions.push(null);
            rejected.push({ id: place.id, lat: place.lat, lng: place.lng });
        }
    }
    if (rejected.length === places.length) {
        const error = new Error(`高德逆地理编码失败：INVALID_PARAMS（这一批 ${places.length} 个地点单独查询也全部被拒绝，请检查 AMAP_WEB_SERVICE_KEY 是否为 Web 服务 key；示例坐标 ${places[0].lng},${places[0].lat}）`);
        error.info = 'INVALID_PARAMS';
        throw error;
    }
    return { regions, rejected };
}

/** 补一批：返回 { checked, more, rejected }（more 只是“这批取满了，可能还有”；rejected 为高德不接受坐标的地点） */
async function refreshPendingBatch({ limit = BATCH_SIZE, sql = db._raw, fetchImpl, retryDelays } = {}) {
    const places = pendingPlaces(limit, sql);
    if (!places.length) return { checked: 0, more: false, rejected: [] };
    const options = { ...(fetchImpl ? { fetchImpl } : null), ...(retryDelays ? { retryDelays } : null) };
    let regions;
    let rejected = [];
    try {
        regions = await reverseGeocodeRegions(places, options);
    } catch (error) {
        if (!isParamError(error)) throw error;
        ({ regions, rejected } = await regionsOneByOne(places, options));
    }
    saveRegions(places, regions, sql);
    if (rejected.length) console.warn(`Place region lookup: AMap rejected ${rejected.length} place(s): ${rejected.map((p) => `#${p.id} (${p.lng},${p.lat})`).join(', ')}`);
    return { checked: places.length, more: places.length >= limit, rejected };
}

let worker = null;

/** 后台补齐地点的省市区；没有配置 AMAP_WEB_SERVICE_KEY 或 PLACE_REGION_WORKER=false 时不启动 */
function startPlaceRegionWorker() {
    if (worker) return worker.stop;
    if (!webServiceKey() || String(process.env.PLACE_REGION_WORKER || 'true').toLowerCase() === 'false') return () => {};
    let timer = null;
    let running = false;
    let stopped = false;
    const schedule = (delay) => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(run, delay);
        timer.unref?.();
    };
    const run = async () => {
        if (running || stopped) return;
        running = true;
        let delay = IDLE_INTERVAL_MS;
        try {
            const result = await refreshPendingBatch();
            if (result.more) delay = BUSY_INTERVAL_MS;
        } catch (error) {
            console.warn('Place region worker failed:', error.message);
            delay = FAILURE_BACKOFF_MS;
        } finally {
            running = false;
            schedule(delay);
        }
    };
    schedule(5000);
    worker = {
        wake: () => { if (!running) schedule(500); },
        stop: () => { stopped = true; clearTimeout(timer); worker = null; }
    };
    return worker.stop;
}

/** 新地点创建 / 挪了位置后尽快补上省市区（后台没启动时什么也不做） */
function wakePlaceRegionWorker() {
    worker?.wake();
}

let treeCache = null;

function boundsOf(row) {
    return [row.min_lng, row.min_lat, row.max_lng, row.max_lat].map((value) => Math.round(Number(value) * 1e6) / 1e6);
}

function mergeBounds(a, b) {
    if (!a) return b.slice();
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * 有公开地点的地区树：[{ name, count, bounds, children: [{ name, count, bounds, children: [{ name, count, bounds }] }] }]，
 * 每层按地点数从多到少；bounds 为 [minLng, minLat, maxLng, maxLat]（地图筛选后移到这个范围）。
 */
function regionTree(sql = db._raw, now = Date.now()) {
    if (treeCache && treeCache.sql === sql && now - treeCache.at < TREE_CACHE_MS) return treeCache.value;
    const rows = sql.prepare(`SELECT r.province, r.city, r.district, COUNT(*) AS count,
            MIN(p.longitude) AS min_lng, MIN(p.latitude) AS min_lat, MAX(p.longitude) AS max_lng, MAX(p.latitude) AS max_lat
        FROM Place p JOIN PlaceRegion r ON r.place_id = p.id
        WHERE ${publicPlaceSql('p')} AND r.province IS NOT NULL
        GROUP BY r.province, r.city, r.district`).all();
    const provinces = new Map();
    for (const row of rows) {
        const bounds = boundsOf(row);
        let province = provinces.get(row.province);
        if (!province) provinces.set(row.province, province = { name: row.province, count: 0, bounds: null, cities: new Map() });
        province.count += row.count;
        province.bounds = mergeBounds(province.bounds, bounds);
        const cityName = row.city || row.province;
        let city = province.cities.get(cityName);
        if (!city) province.cities.set(cityName, city = { name: cityName, count: 0, bounds: null, children: [] });
        city.count += row.count;
        city.bounds = mergeBounds(city.bounds, bounds);
        if (row.district) city.children.push({ name: row.district, count: row.count, bounds });
    }
    const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN');
    const value = [...provinces.values()].map((province) => ({
        name: province.name,
        count: province.count,
        bounds: province.bounds,
        children: [...province.cities.values()].map((city) => ({ ...city, children: city.children.sort(byCount) })).sort(byCount)
    })).sort(byCount);
    treeCache = { sql, at: now, value };
    return value;
}

/** 查询参数里的地区筛选：{ province, city, district }，没设的层为 null；下层要有上层 */
function parseRegionFilter(query = {}) {
    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null);
    const province = text(query.province);
    const city = province ? text(query.city) : null;
    const district = city ? text(query.district) : null;
    return { province, city, district };
}

function hasRegionFilter(region) {
    return !!(region && region.province);
}

function matchesRegion(place, region) {
    if (!hasRegionFilter(region)) return true;
    if (place.province !== region.province) return false;
    if (region.city && place.city !== region.city) return false;
    if (region.district && place.district !== region.district) return false;
    return true;
}

module.exports = {
    initPlaceRegionSchema,
    regionFromComponent,
    reverseGeocodeRegions,
    pendingPlaces,
    countPendingPlaces,
    saveRegions,
    refreshPendingBatch,
    startPlaceRegionWorker,
    wakePlaceRegionWorker,
    regionTree,
    parseRegionFilter,
    hasRegionFilter,
    matchesRegion
};
