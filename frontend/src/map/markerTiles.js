// 地图标记的分层瓦片（取代 2026-11-15 的整份快照 GET /places/markers；后端 backend/modules/places/services/placeTiles.js，
// 格式与级别两边一起改）。没有哪个请求能一次拿到全部店名和坐标：
//
// 1. 清单 GET /places/tiles/manifest：各级瓦片的内容哈希（公共缓存，约一分钟跟上修改）；字典 /tiles/<哈希>/dict：标签名、地区名。
// 2. 三级聚合瓦片（z2 / z5 / z8 瓦片，格子 z9 / z12 / z14）：格子位置、每家店匿名的一行（标签、人均、地区、图标类型）。
//    这里把每一行展开成一个“匿名点”（aggregate: true，没有店名）交给现有聚合引擎。前两级同一格的点都放在格子重心；
//    最细一级（瓦片带 sub）的行带店所在的 1/16 小格（约 140 m），点放在小格中心，换到明细时只挪几个像素，
//    aggregateCell 的第 4 项记下小格的级别（z18）。筛选（places/placeFilter.js）照常作用在这些点的标签、人均、地区上。
// 3. 明细瓦片（z12）：店名、精确坐标、评价汇总，与旧快照的字段相同（marker_only，打开卡片时再读 GET /places/:id）。
//    按 IP / 账号限流（登录后带票据 ?t=），只在浏览器和 IndexedDB 里缓存。拿不到的那块用城市级聚合顶上。
//
// 显示哪一级由地图缩放决定（bandForZoom）；换级时等新一级的请求结束再整体切换，
// 缺块用聚合顶上，补位瓦片最多额外等 BAND_SWITCH_WAIT_MS。聚合级不叠加本地修改和屏蔽，明细级与旧快照一样叠加。
// 预取（prefetchLeafAt）：城市级停下、放大越过 z12.3、点聚合、跳到某家店时提前拉明细瓦片，见 doc/README.md。
// 这里不依赖 React 和地图，npm run test:map 直接测试。

import { placeKey } from './cluster/engine.js';
import { computeLogicalZoom, expandBounds, normalizeViewBounds } from './cluster/snapshot.js';
import { readCache, writeCache, deleteCache } from '../platform/cacheStore.js';
import { collectInSlices, yieldTask } from './cluster/cooperative.js';

export const GLYPH_KINDS = Object.freeze(['place', 'avoid', 'unexplored']);
/** 换到明细级时等待补位瓦片的预算 */
export const BAND_SWITCH_WAIT_MS = 1500;
/** 地图移动时清单超过这个时间就后台刷新一次（CDN 与浏览器有缓存，大多数刷新不回源） */
export const MANIFEST_MAX_AGE_MS = 5 * 60 * 1000;
export const MANIFEST_RETRY_MS = 15 * 1000;
/** 本地修改最多保留这么久（明细瓦片追上以后提前去掉） */
export const PATCH_TTL_MS = 10 * 60 * 1000;
/** 聚合级给视野四周留的缓冲（比例）；明细级只取视野内的，省游客额度 */
export const AGGREGATE_BUFFER = 0.35;
export const PREFETCH = Object.freeze({ stopZoom: 12, crossZoom: 12.3, maxPerTrigger: 2, maxInFlight: 2 });
const STORAGE_PREFIX = 'map.tiles.v1:';
const MAX_TILES_PER_LEVEL = 48;
const TICKET_REFRESH_MS = 60 * 60 * 1000;

// ---- Web Mercator 瓦片坐标（与后端 placeTiles.js 相同） ----

const MAX_LAT = 85.0511;
export function worldX(lng, z) { return ((lng + 180) / 360) * 2 ** z; }
export function worldY(lat, z) {
    const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
function clampIndex(value, z) { return Math.max(0, Math.min(2 ** z - 1, Math.floor(value))); }
export function lngOf(x, z) { return (x / 2 ** z) * 360 - 180; }
export function latOf(y, z) {
    const n = Math.PI * (1 - (2 * y) / 2 ** z);
    return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}
export function tileOf(lng, lat, z) { return [clampIndex(worldX(lng, z), z), clampIndex(worldY(lat, z), z)]; }

/** 范围（经纬度）覆盖的 z 级瓦片 key（"x/y"），最多 limit 块（按离中心的距离取） */
export function tileKeysForBounds(bounds, z, limit = MAX_TILES_PER_LEVEL) {
    if (!bounds) return [];
    const [x0, y0] = tileOf(bounds.minLng, bounds.maxLat, z);
    const [x1, y1] = tileOf(bounds.maxLng, bounds.minLat, z);
    limit = Math.max(0, Math.floor(Number(limit) || 0));
    if (!limit || x1 < x0 || y1 < y0) return [];
    const keys = [], heap = [], seen = new Set();
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const compare = (a,b) => a.d - b.d || a.x - b.x || a.y - b.y;
    const push = (x,y) => {
        const key = `${x}/${y}`;
        if (x < x0 || x > x1 || y < y0 || y > y1 || seen.has(key)) return;
        seen.add(key);
        const item = {x,y,key,d:(x-cx)**2+(y-cy)**2};
        let i = heap.length;
        heap.push(item);
        while (i > 0) {
            const parent = (i-1) >> 1;
            if (compare(heap[parent],item) <= 0) break;
            heap[i] = heap[parent]; i = parent;
        }
        heap[i] = item;
    };
    const pop = () => {
        const first = heap[0], last = heap.pop();
        if (heap.length) {
            let i = 0;
            while (i*2+1 < heap.length) {
                let child = i*2+1;
                if (child+1 < heap.length && compare(heap[child+1],heap[child]) < 0) child++;
                if (compare(last,heap[child]) <= 0) break;
                heap[i] = heap[child]; i = child;
            }
            heap[i] = last;
        }
        return first;
    };
    push(Math.floor(cx),Math.floor(cy));
    while (heap.length && keys.length < limit) {
        const {x,y,key} = pop();
        keys.push(key);
        push(x-1,y); push(x+1,y); push(x,y-1); push(x,y+1);
    }
    return keys;
}

/** 当前逻辑缩放该用哪一级：{ kind: 'aggregate', tile, cell, minZoom, maxZoom } 或 { kind: 'leaf', tile, minZoom } */
export function bandForZoom(manifest, logicalZoom) {
    if (!manifest) return null;
    if (logicalZoom >= manifest.leaf.minZoom) return { kind: 'leaf', ...manifest.leaf };
    const level = manifest.levels.find((item) => logicalZoom >= item.minZoom && logicalZoom <= item.maxZoom)
        || manifest.levels[manifest.levels.length - 1];
    return { kind: 'aggregate', ...level };
}

const bandId = (band) => (band ? `${band.kind}:${band.tile}` : '');

/** 点聚合或匿名点时要放大到的层级：下一级的起始缩放 */
export function nextBandZoom(manifest, zoom) {
    if (!manifest) return zoom + 2;
    const band = bandForZoom(manifest, Math.round(zoom));
    if (!band || band.kind === 'leaf') return zoom + 2;
    const index = manifest.levels.findIndex((item) => item.tile === band.tile);
    const next = manifest.levels[index + 1];
    return next ? next.minZoom : manifest.leaf.minZoom;
}

// ---- 展开瓦片 ----

/** 聚合瓦片 → 匿名点（每家店一个，同一格坐标相同）。key 为 agg:<格子级>/<x>/<y>#<序号> */
function* aggregateRows(body, dict, tileKey) {
    if (!body || !Array.isArray(body.cells) || !dict) return;
    const [tx, ty] = tileKey.split('/').map(Number);
    const shift = 2 ** (body.cell - body.z);
    // 格内小格：sub 必须是 2 的幂，小格就是 cell + log2(sub) 级的瓦片
    const subBits = Number.isInteger(body.sub) && body.sub > 1 ? Math.log2(body.sub) : NaN;
    const sub = Number.isInteger(subBits) ? body.sub : 0;
    for (const cell of body.cells) {
        if (!Array.isArray(cell) || !Array.isArray(cell[4])) continue;
        const cellX = tx * shift + cell[0];
        const cellY = ty * shift + cell[1];
        const centroid = [lngOf(cellX + (cell[2] + 0.5) / 8, body.cell), latOf(cellY + (cell[3] + 0.5) / 8, body.cell)];
        for (const [index, row] of cell[4].entries()) {
            const [tags, cost, region, glyph, subIndex] = row;
            const names = Array.isArray(tags) ? tags.map((i) => dict.tags[i]).filter(Boolean) : [];
            const regionNames = region >= 0 && Array.isArray(dict.regions[region]) ? dict.regions[region] : null;
            const inCell = sub && Number.isInteger(subIndex) && subIndex >= 0 && subIndex < sub * sub;
            const [longitude, latitude] = inCell
                ? [lngOf(cellX + (subIndex % sub + 0.5) / sub, body.cell), latOf(cellY + (Math.floor(subIndex / sub) + 0.5) / sub, body.cell)]
                : centroid;
            yield {
                aggregateKey: `agg:${body.cell}/${cellX}/${cellY}#${index}`,
                aggregate: true,
                aggregateCell: inCell ? [body.cell, cellX, cellY, body.cell + subBits] : [body.cell, cellX, cellY],
                name: '',
                longitude,
                latitude,
                category: names.join(','),
                per_person_cost: cost > 0 ? cost : null,
                province: regionNames ? regionNames[0] : null,
                city: regionNames ? regionNames[1] : null,
                district: regionNames ? regionNames[2] : null,
                glyph: GLYPH_KINDS[glyph] || 'place'
            };
        }
    }
}

export function expandAggregateTile(body, dict, tileKey) {
    return Array.from(aggregateRows(body, dict, tileKey));
}

/** 明细瓦片 → 地点（marker_only：打开卡片时再补全） */
export function expandLeafTile(body) {
    return Array.from(leafRows(body));
}

function* leafRows(body) {
    if (!body || !Array.isArray(body.fields) || !Array.isArray(body.rows)) return;
    const fields = body.fields.map(String);
    for (const row of body.rows) {
        if (!Array.isArray(row)) continue;
        const place = { marker_only: true };
        fields.forEach((field,index) => { place[field] = row[index] === undefined ? null : row[index]; });
        yield place;
    }
}

function connectionIsSlow() {
    const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
    return !!connection && (connection.saveData === true || /(^|-)2g$/.test(String(connection.effectiveType || '')));
}

// ---- 共享数据源：清单、字典、瓦片的拉取与缓存（一个后端地址一份，首页地图与全屏选点共用） ----

export class MarkerTileSource {
    /**
     * @param {{ backendUrl: string, fetchImpl?: Function, readStored?: Function, writeStored?: Function, removeStored?: Function, now?: Function }} options
     */
    constructor({ backendUrl, fetchImpl, readStored = async () => null, writeStored = async () => undefined, removeStored = async () => undefined, now = () => Date.now() }) {
        this.backendUrl = backendUrl;
        this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
        this.readStored = readStored;
        this.writeStored = writeStored;
        this.removeStored = removeStored;
        this.now = now;
        this.manifest = null;
        this.dict = null;
        this.manifestFetchedAt = -Infinity;
        this.manifestFailedAt = -Infinity;
        this.manifestRequest = null;
        this.storedLoaded = null;
        this.tiles = new Map();      // "z/x/y" -> { hash, places }
        this.pending = new Map();    // "z/x/y@hash" -> Promise
        this.failed = new Map();     // "z/x/y@hash" -> 时间
        this.token = null;
        this.ticket = null;
        this.ticketRequest = null;
        this.leafLimitedUntil = 0;
        this.prefetchInFlight = 0;
        this.listeners = new Set();
        this.limitListeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onLimited(listener) {
        this.limitListeners.add(listener);
        return () => this.limitListeners.delete(listener);
    }

    /** 几块瓦片前后脚到达时合并成一次通知，标记层不必每块重建一次聚合 */
    _emit() {
        if (this._emitTimer) return;
        this._emitTimer = setTimeout(() => {
            this._emitTimer = null;
            for (const listener of this.listeners) {
                try { listener(); } catch (error) { console.warn('标记瓦片回调失败', error); }
            }
        }, 16);
    }

    get hasData() {
        return !!this.manifest && !!this.dict;
    }

    get leafLimited() {
        return this.leafLimitedUntil > this.now();
    }

    setToken(token) {
        if (token === this.token) return;
        this.token = token || null;
        this.ticket = null;
        this.ticketRequest = null;
        this.leafLimitedUntil = 0;
    }

    /** 启动：先读本机存的清单与字典，同时请求网络 */
    start() {
        if (!this.storedLoaded) {
            this.storedLoaded = Promise.resolve()
                .then(() => this.readStored(`${STORAGE_PREFIX}${this.backendUrl}:manifest`))
                .then(async (stored) => {
                    if (!stored || this.manifest || !stored.manifest || !stored.dict) return;
                    this.manifest = stored.manifest;
                    this.dict = stored.dict;
                    this._emit();
                })
                .catch(() => { /* 本机缓存可有可无 */ });
        }
        return this.refresh({ force: true });
    }

    /** 清单超过 maxAgeMs 才重新请求；同一时间只有一个请求 */
    refresh({ maxAgeMs = MANIFEST_MAX_AGE_MS, force = false } = {}) {
        if (this.manifestRequest) return this.manifestRequest;
        const now = this.now();
        if (now - this.manifestFetchedAt < maxAgeMs) return Promise.resolve(this.manifest);
        if (!force && now - this.manifestFailedAt < MANIFEST_RETRY_MS) {
            return Promise.reject(Object.assign(new Error('marker tiles retry pending'), { code: 'RETRY_PENDING' }));
        }
        this.manifestRequest = (async () => {
            const res = await this.fetchImpl(`${this.backendUrl}/places/tiles/manifest`);
            if (!res.ok) throw new Error(`Failed to fetch marker tiles: ${res.status}`);
            const manifest = await res.json();
            if (!manifest || !manifest.tiles || !Array.isArray(manifest.levels) || !manifest.leaf || typeof manifest.dict !== 'string') {
                throw new Error('Invalid marker tiles manifest');
            }
            let dict = this.dict;
            if (!dict || this.manifest?.dict !== manifest.dict) {
                const dictRes = await this.fetchImpl(`${this.backendUrl}/places/tiles/${manifest.dict}/dict`);
                if (!dictRes.ok) throw new Error(`Failed to fetch marker tiles dictionary: ${dictRes.status}`);
                dict = await dictRes.json();
                if (!dict || !Array.isArray(dict.tags) || !Array.isArray(dict.regions)) throw new Error('Invalid marker tiles dictionary');
            }
            this.manifestFetchedAt = this.now();
            const changed = !this.manifest || this.manifest.version !== manifest.version;
            // 旧清单里更新过的瓦片作废（内存里按哈希判断，这里只是不再保留）
            this.manifest = manifest;
            this.dict = dict;
            if (changed) {
                Promise.resolve().then(() => this.writeStored(`${STORAGE_PREFIX}${this.backendUrl}:manifest`, { manifest, dict })).catch(() => {});
                this._emit();
            }
            return manifest;
        })()
            .catch((error) => {
                this.manifestFailedAt = this.now();
                throw error;
            })
            .finally(() => { this.manifestRequest = null; });
        return this.manifestRequest;
    }

    hashOf(z, key) {
        return this.manifest?.tiles?.[z]?.[key] || null;
    }

    /** 已经在内存里、且与当前清单一致的瓦片（展开后的地点数组）；没有时 undefined，这块本来就空时 [] */
    peek(z, key) {
        const hash = this.hashOf(z, key);
        if (!hash) return this.manifest ? [] : undefined;
        const entry = this.tiles.get(`${z}/${key}`);
        return entry && entry.hash === hash ? entry.places : undefined;
    }

    async _ticketQuery() {
        if (!this.token) return '';
        const now = this.now();
        if (this.ticket && this.ticket.expires_at - now > TICKET_REFRESH_MS) return `?t=${encodeURIComponent(this.ticket.ticket)}`;
        if (!this.ticketRequest) {
            const token = this.token;
            this.ticketRequest = this.fetchImpl(`${this.backendUrl}/places/tiles/ticket`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
                .then(async (res) => {
                    if (!res.ok) return null;
                    const data = await res.json();
                    if (this.token === token && data && typeof data.ticket === 'string') this.ticket = data;
                    return this.ticket;
                })
                .catch(() => null)
                .finally(() => { this.ticketRequest = null; });
        }
        await this.ticketRequest;
        return this.ticket ? `?t=${encodeURIComponent(this.ticket.ticket)}` : '';
    }

    /**
     * 拉一块瓦片（内存 → 本机 → 网络）。resolve 展开后的地点数组；这块没有店时 []；
     * 明细瓦片超额（429）或网络失败时 null（调用方用聚合顶上）。
     */
    load(z, key, { priority = 'auto' } = {}) {
        const hash = this.hashOf(z, key);
        if (!hash || !this.dict) return Promise.resolve(this.manifest ? [] : null);
        const cached = this.peek(z, key);
        if (cached) return Promise.resolve(cached);
        const leaf = z === this.manifest.leaf.tile;
        if (leaf && this.leafLimited) return Promise.resolve(null);
        const id = `${z}/${key}@${hash}`;
        const failedAt = this.failed.get(id);
        if (failedAt && this.now() - failedAt < MANIFEST_RETRY_MS) return Promise.resolve(null);
        if (this.pending.has(id)) return this.pending.get(id);
        const dict = this.dict;
        const storageKey = `${STORAGE_PREFIX}${this.backendUrl}:${z}/${key}`;
        const request = (async () => {
            let body = null;
            try {
                const stored = await this.readStored(storageKey);
                if (stored && stored.hash === hash) body = stored.body;
            } catch (_) { /* 没有就从网络读 */ }
            if (!body) {
                const query = leaf ? await this._ticketQuery() : '';
                const res = await this.fetchImpl(`${this.backendUrl}/places/tiles/${hash}/${z}/${key}${query}`, { priority });
                if (res.status === 429) {
                    const data = await res.json().catch(() => ({}));
                    const retry = Number(data.retry_after) || Number(res.headers?.get?.('Retry-After')) || 3600;
                    this.leafLimitedUntil = this.now() + retry * 1000;
                    for (const listener of this.limitListeners) {
                        try { listener({ guest: data.guest !== false, retryAfter: retry }); } catch (_) { /* ignore */ }
                    }
                    return null;
                }
                if (res.status === 404) {
                    // 清单旧了：这块已经没有了，下次地图移动时刷新清单
                    this.manifestFetchedAt = -Infinity;
                    return [];
                }
                if (!res.ok) throw new Error(`Failed to fetch marker tile: ${res.status}`);
                body = await res.json();
                Promise.resolve().then(() => this.writeStored(storageKey, { hash, body })).catch(() => {});
            }
            const places = await collectInSlices(leaf ? leafRows(body) : aggregateRows(body, dict, key));
            if (this.hashOf(z, key) !== hash) return null;
            this.tiles.set(`${z}/${key}`, { hash, places });
            this._emit();
            return places;
        })()
            .catch((error) => {
                this.failed.set(id, this.now());
                console.warn('加载标记瓦片失败', error);
                return null;
            })
            .finally(() => { this.pending.delete(id); });
        this.pending.set(id, request);
        return request;
    }

    /**
     * 预取明细瓦片：points 里每个坐标所在的那一块，最多 maxTiles 块；已在缓存的不拉，
     * 同时在飞的预取最多 PREFETCH.maxInFlight 个，省流量模式 / 2G / 超额时不预取。预取也计入服务端额度。
     */
    prefetchLeafAt(points, { maxTiles = PREFETCH.maxPerTrigger } = {}) {
        if (!this.manifest || !this.dict || this.leafLimited || connectionIsSlow()) return 0;
        const z = this.manifest.leaf.tile;
        let started = 0;
        const seen = new Set();
        for (const [lng, lat] of points) {
            if (started >= maxTiles || this.prefetchInFlight >= PREFETCH.maxInFlight) break;
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            const key = tileOf(lng, lat, z).join('/');
            if (seen.has(key)) continue;
            seen.add(key);
            const hash = this.hashOf(z, key);
            if (!hash || this.peek(z, key) || this.pending.has(`${z}/${key}@${hash}`)) continue;
            this.prefetchInFlight += 1;
            started += 1;
            this.load(z, key, { priority: 'low' }).finally(() => { this.prefetchInFlight -= 1; });
        }
        return started;
    }

    /** 测试用：清空本机缓存的清单 */
    async clearStored() {
        try { await this.removeStored(`${STORAGE_PREFIX}${this.backendUrl}:manifest`); } catch (_) { /* ignore */ }
    }
}

const sources = new Map();

export function markerTileSource(backendUrl) {
    let source = sources.get(backendUrl);
    if (!source) {
        source = new MarkerTileSource({ backendUrl, readStored: readCache, writeStored: writeCache, removeStored: deleteCache });
        sources.set(backendUrl, source);
    }
    return source;
}

/** 启动时（main.jsx）与高德 SDK 并行开始加载清单与字典 */
export function prefetchMarkerTiles(backendUrl) {
    if (!backendUrl) return;
    markerTileSource(backendUrl).start().catch(() => { /* 地图页会提示并重试 */ });
}

// ---- 每个地图实例一份：按视野拼出要画的点 ----

function sameFields(a, b) {
    for (const field of ['name', 'longitude', 'latitude', 'category', 'per_person_cost', 'rating_count', 'rating_average', 'rating_negative_count', 'checkin_count']) {
        if ((a?.[field] ?? null) !== (b?.[field] ?? null)) return false;
    }
    return true;
}

export class MarkerTileStore {
    constructor(source, { now = () => Date.now(), patchTtlMs = PATCH_TTL_MS, switchWaitMs = BAND_SWITCH_WAIT_MS } = {}) {
        this.source = source;
        this.now = now;
        this.patchTtlMs = patchTtlMs;
        this.switchWaitMs = switchWaitMs;
        this.view = null;            // { bounds, logicalZoom }
        this.displayBand = null;
        this.displayBounds = null;
        this.targetBand = null;
        this.switchToken = 0;
        this.overlay = { own: [], hiddenIds: new Set(), signature: '[]|' };
        this.patches = new Map();
        this.version = 0;
        this._memo = null;
        this.listeners = new Set();
        this._unsubscribe = null;
    }

    dispose() {
        this.disposed = true;
        this.switchToken += 1;
        this._unsubscribe?.();
        this._unsubscribe = null;
        this.listeners.clear();
    }

    /** 有人订阅时才跟着数据源（React 严格模式重复渲染时新建的实例不会留下订阅） */
    subscribe(listener) {
        this.listeners.add(listener);
        if (!this._unsubscribe) this._unsubscribe = this.source.subscribe(() => this._onSourceChange());
        return () => {
            this.listeners.delete(listener);
            if (!this.listeners.size && this._unsubscribe) {
                this._unsubscribe();
                this._unsubscribe = null;
            }
        };
    }

    get hasSnapshot() {
        return this.source.hasData && !!this.displayBand;
    }

    get band() {
        return this.displayBand;
    }

    _notify() {
        for (const listener of this.listeners) {
            try { listener(); } catch (error) { console.warn('标记数据回调失败', error); }
        }
    }

    _bump() {
        this.version += 1;
    }

    _coverage(band, bounds = this.view?.bounds) {
        if (!bounds || !band) return [];
        if (band.kind === 'leaf') return tileKeysForBounds(bounds, band.tile).filter((key) => this.source.hashOf(band.tile, key));
        return tileKeysForBounds(expandBounds(bounds, AGGREGATE_BUFFER), band.tile).filter((key) => this.source.hashOf(band.tile, key));
    }

    /** 明细级用来顶缺块的城市级聚合 */
    _fallbackLevel() {
        const levels = this.source.manifest?.levels || [];
        return levels[levels.length - 1] || null;
    }

    _neededLoads(band) {
        const loads = [];
        if (!band) return loads;
        if (band.kind === 'leaf') {
            const fallback = this._fallbackLevel();
            if (fallback) for (const key of tileKeysForBounds(this.view.bounds, fallback.tile).filter((k) => this.source.hashOf(fallback.tile, k))) loads.push([fallback.tile, key]);
        }
        for (const key of this._coverage(band)) loads.push([band.tile, key]);
        return loads;
    }

    logicalZoomAt(zoom) {
        return computeLogicalZoom(zoom, this.view?.logicalZoom, { minZoom: 0, maxZoom: 22 });
    }

    isBandChange(zoom) {
        const band = bandForZoom(this.source.manifest, this.logicalZoomAt(zoom));
        return !!this.targetBand && !!band && bandId(band) !== bandId(this.targetBand);
    }

    /**
     * 地图视野变化（移动结束、缩放结束）：决定显示哪一级并拉缺的瓦片。返回地图数据是否立即变化。
     * @param {{ bounds: object, zoom: number }} view bounds 为 { minLng, maxLng, minLat, maxLat }
     */
    setView({ bounds, zoom }) {
        const normalized = normalizeViewBounds(bounds);
        if (!normalized || !Number.isFinite(zoom)) return false;
        const logicalZoom = this.logicalZoomAt(zoom);
        this.view = { bounds: normalized, logicalZoom, zoom };
        const manifest = this.source.manifest;
        if (!manifest) return false;
        const band = bandForZoom(manifest, logicalZoom);
        this.targetBand = band;
        const token = ++this.switchToken;
        const loads = this._neededLoads(band);
        const promises = loads.map(([z, key]) => this.source.load(z, key));
        if (bandId(band) === bandId(this.displayBand)) {
            this.displayBounds = normalized;
            this._bump();
            return true;
        }
        const ready = loads.every(([z, key]) => this.source.peek(z, key) !== undefined);
        if (ready || !this.displayBand) {
            this.displayBand = band;
            this.displayBounds = normalized;
            this._bump();
            return true;
        }
        // 目标级请求仍在途时保留旧快照，否则超时会先拆匿名点，明细到达又过渡一次。
        const targetLoads = promises.filter((_, index) => loads[index][0] === band.tile);
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(resolve, this.switchWaitMs); });
        const fallbackReady = Promise.race([Promise.allSettled(promises), timeout]).finally(() => {
            clearTimeout(timer);
        });
        Promise.all([Promise.allSettled(targetLoads), fallbackReady]).then(() => {
            if (token !== this.switchToken || bandId(this.displayBand) === bandId(band)) return;
            this.displayBand = band;
            this.displayBounds = this.view.bounds;
            this._bump();
            this._notify();
        });
        return false;
    }

    _onSourceChange() {
        // 清单或瓦片到了：目标级还没切过去时检查能否切；当前级有新瓦片就重拼
        if (!this.view) return;
        const manifest = this.source.manifest;
        if (!manifest) return;
        if (!this.targetBand) {
            this.setView({ bounds: this.view.bounds, zoom: this.view.zoom });
            this._notify();
            return;
        }
        if (bandId(this.targetBand) !== bandId(this.displayBand)) {
            const ready = this._neededLoads(this.targetBand).every(([z, key]) => this.source.peek(z, key) !== undefined);
            if (!ready) return;
            this.displayBand = this.targetBand;
            this.displayBounds = this.view.bounds;
        }
        this._bump();
        this._notify();
    }

    /** 个人叠加（GET /places/overlay 的响应；退出登录传 null）。返回地图数据是否变化 */
    setOverlay(data) {
        const own = Array.isArray(data?.own) ? data.own.filter((place) => placeKey(place)) : [];
        const hiddenIds = new Set((Array.isArray(data?.hidden_ids) ? data.hidden_ids : []).map(String));
        let changed = false;
        for (const place of own) changed = this.patches.delete(placeKey(place)) || changed;
        const signature = `${JSON.stringify(own)}|${[...hiddenIds].sort().join(',')}`;
        if (signature !== this.overlay.signature) {
            this.overlay = { own, hiddenIds, signature };
            changed = true;
        }
        if (changed) this._bump();
        return changed;
    }

    resetPersonal() {
        const changed = this.patches.size > 0 || this.overlay.own.length > 0 || this.overlay.hiddenIds.size > 0;
        this.patches.clear();
        this.overlay = { own: [], hiddenIds: new Set(), signature: '[]|' };
        if (changed) this._bump();
        return changed;
    }

    upsert(place) {
        const key = placeKey(place);
        if (!key) return;
        this.patches.set(key, { place, at: this.now() });
        this._bump();
    }

    remove(placeOrKey) {
        const key = typeof placeOrKey === 'string' ? placeOrKey : placeKey(placeOrKey);
        if (!key) return;
        this.patches.set(key, { place: null, at: this.now() });
        this._bump();
    }

    patchPlace(key, fields) {
        const current = this.get(key);
        if (!current) return false;
        if (Object.keys(fields).every((field) => (current[field] ?? null) === (fields[field] ?? null))) return false;
        this.upsert({ ...current, ...fields });
        return true;
    }

    /** 明细瓦片里或本地修改里的地点（聚合级时也能按 key 找到已经拉过的明细） */
    get(key) {
        const composed = this._compose().byKey.get(key);
        if (composed) return composed;
        const patch = this.patches.get(key);
        if (patch) return patch.place;
        const leafZ = this.source.manifest?.leaf?.tile;
        for (const [tileId, entry] of this.source.tiles) {
            if (!tileId.startsWith(`${leafZ}/`)) continue;
            const found = entry.places.find((place) => placeKey(place) === key);
            if (found) return found;
        }
        return null;
    }

    all() {
        return this._compose().list;
    }

    async allAsync({signal} = {}) {
        const version = this.version;
        const cancelled = () => signal?.aborted || this.disposed || version !== this.version;
        if (cancelled()) throw new DOMException('Cancelled','AbortError');
        if (this._memo?.version === version && this.now() < this._memo.expiresAt) return this._memo.list;
        const task = this._composeSteps();
        let started = performance.now(), step;
        while (true) {
            if (cancelled()) { task.return(); throw new DOMException('Cancelled','AbortError'); }
            step = task.next();
            if (step.done) break;
            if (performance.now()-started >= 4) { await yieldTask(); started = performance.now(); }
        }
        if (cancelled()) throw new DOMException('Cancelled','AbortError');
        if (this._memo?.version !== version || this.now() >= this._memo.expiresAt) this._memo = step.value;
        return this._memo.list;
    }

    *_leafRows(band) {
        const fallback = this._fallbackLevel();
        const fallbackShift = fallback ? 2 ** (band.tile - fallback.tile) : 1;
        const fallbackCellShift = fallback ? 2 ** (fallback.cell - band.tile) : 1;
        for (const key of this._coverage(band, this.displayBounds)) {
            const leaf = this.source.peek(band.tile, key);
            if (leaf) {
                yield* leaf;
                continue;
            }
            // 这块明细还没到或拿不到：用城市级聚合里落在这块里的格子顶上
            if (!fallback) continue;
            const [x, y] = key.split('/').map(Number);
            const parentKey = `${Math.floor(x / fallbackShift)}/${Math.floor(y / fallbackShift)}`;
            const parent = this.source.peek(fallback.tile, parentKey);
            if (!parent) continue;
            for (const place of parent) {
                const [, cellX, cellY] = place.aggregateCell;
                yield Math.floor(cellX / fallbackCellShift) === x && Math.floor(cellY / fallbackCellShift) === y ? place : null;
            }
        }
    }

    _compose() {
        const now = this.now();
        if (this._memo?.version === this.version && now < this._memo.expiresAt) return this._memo;
        const task = this._composeSteps();
        let step;
        do { step = task.next(); } while (!step.done);
        this._memo = step.value;
        return this._memo;
    }

    *_composeSteps() {
        const now = this.now(), version = this.version;
        const band = this.displayBand;
        const byKey = new Map();
        let expiresAt = Infinity;
        if (band && band.kind === 'aggregate') {
            for (const key of this._coverage(band, this.displayBounds)) {
                const places = this.source.peek(band.tile, key);
                if (places) for (const place of places) { yield; byKey.set(place.aggregateKey, place); }
            }
        } else if (band) {
            for (const place of this._leafRows(band)) {
                yield;
                if (!place) continue;
                const key = placeKey(place);
                if (key) byKey.set(key, place);
            }
            // 本地修改：明细瓦片追上了（字段一致、或删除的已不在）就去掉
            for (const [key, patch] of this.patches) {
                yield;
                if (now - patch.at >= this.patchTtlMs) {
                    this.patches.delete(key);
                    continue;
                }
                const row = byKey.get(key);
                if (row && !row.aggregate && (patch.place === null ? false : sameFields(row, patch.place)) && row !== patch.place) {
                    this.patches.delete(key);
                    continue;
                }
                expiresAt = Math.min(expiresAt, patch.at + this.patchTtlMs);
                if (patch.place) byKey.set(key, patch.place);
                else byKey.delete(key);
            }
            for (const id of this.overlay.hiddenIds) { yield; byKey.delete(`place:${id}`); }
        }
        for (const place of this.overlay.own) { yield; byKey.set(placeKey(place), place); }
        const previous = this._memo;
        const list = [];
        let same = previous && previous.list.length === byKey.size;
        for (const place of byKey.values()) {
            yield;
            if (same && previous.list[list.length] !== place) same = false;
            list.push(place);
        }
        return {version,byKey,list:same ? previous.list : list,expiresAt};
    }
}
