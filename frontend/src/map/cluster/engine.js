// 聚类引擎：把地点列表规范化后交给 Supercluster 建立分层索引，并以统一的节点契约（MapNode）对外提供查询。
// 只依赖纯数据，不接触 AMap 对象，便于在 Node 中测试，必要时可整体迁入 Web Worker。
//
// MapNode {
//   key: place:<id> | poi:<source>:<id> | cluster:<generation>:<clusterId>
//   kind: 'place' | 'cluster'
//   coordinate: [lng, lat]
//   count: number
//   memberSignature: string   // 快速匹配入口；认定成员相同前仍需核对成员 key
//   clusterId?: number        // 仅聚合节点；只在本代索引内有效，不跨代复用
//   place?: object            // 仅单点：当前外观数据（名称、分类等）
// }

import Supercluster from 'supercluster';

// 高德与 Supercluster 都使用 256px 瓦片的 Web Mercator：在同一整数缩放级别下，
// 聚类半径 radius（以 extent 为基准的瓦片单位）对应的屏幕 CSS 像素为 radius × 256 / extent。
// 这里按目标 CSS 像素换算，不把 radius 数字直接当作屏幕像素，也不乘设备 DPR。
export const AMAP_TILE_SIZE = 256;
export const CLUSTER_DEFAULTS = Object.freeze({
    radiusPx: 68,
    extent: 512,
    minZoom: 0,
    maxZoom: 20,
    minPoints: 2
});

export function radiusForCssPixels(cssPx, extent = CLUSTER_DEFAULTS.extent) {
    return cssPx * extent / AMAP_TILE_SIZE;
}

// ---- 稳定哈希：成员签名使用两路独立的 32 位哈希，以异或和加法合并，结果与成员顺序无关 ----

export function hashString(str, seed = 0x811c9dc5) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    // murmur3 fmix32，打散低位
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

const HASH_SEED_2 = 0x9747b28c;

// ---- 地点规范化 ----

const MAX_MERCATOR_LAT = 85.0511;

/** 数据库地点与高德临时 POI 使用不同的 key 命名空间。 */
export function placeKey(place) {
    if (!place) return null;
    const rawId = place.id;
    if (place.isMarked === false) {
        const text = String(rawId ?? '');
        const poiId = text.startsWith('amap_') ? text.slice(5) : text;
        if (poiId) return `poi:amap:${poiId}`;
    } else if (rawId !== undefined && rawId !== null && String(rawId) !== '') {
        return `place:${rawId}`;
    }
    const lng = Number(place.longitude);
    const lat = Number(place.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return `place:coord:${lng.toFixed(6)},${lat.toFixed(6)}`;
}

/**
 * 规范化坐标、按 key 去重（先出现者优先）并按 key 稳定排序：
 * Supercluster 的结果依赖输入顺序，排序后同一数据集无论原始顺序如何都得到同一棵树。
 * 坐标沿用高德现有约定（GCJ-02），这里不做任何坐标转换。
 */
export function normalizePlaces(list) {
    const byKey = new Map();
    for (const place of Array.isArray(list) ? list : []) {
        const key = placeKey(place);
        if (!key || byKey.has(key)) continue;
        const lng = Number(place.longitude);
        const lat = Number(place.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        if (lng < -180 || lng > 180 || Math.abs(lat) > MAX_MERCATOR_LAT) continue;
        byKey.set(key, { key, lng: Math.round(lng * 1e7) / 1e7, lat: Math.round(lat * 1e7) / 1e7, place });
    }
    return Array.from(byKey.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 只有参与聚类的数据（key 与坐标）决定签名；名称、收藏、主题变化不会让索引失效。 */
export function dataSignature(normalized) {
    let h1 = 0x811c9dc5;
    let h2 = HASH_SEED_2;
    for (const item of normalized) {
        const token = `${item.key}@${item.lng},${item.lat};`;
        h1 = hashString(token, h1);
        h2 = hashString(token, h2);
    }
    return `${normalized.length}:${h1.toString(36)}:${h2.toString(36)}`;
}

// ---- 引擎 ----

let generationSeq = 0;

export class ClusterEngine {
    /**
     * @param {Array} normalized normalizePlaces 的结果
     * @param {{ radiusPx?: number, extent?: number, minZoom?: number, maxZoom?: number, minPoints?: number, generation?: number }} [options]
     */
    constructor(normalized, options = {}) {
        const opts = { ...CLUSTER_DEFAULTS, ...options };
        this.options = opts;
        this.generation = options.generation ?? ++generationSeq;
        this.signature = dataSignature(normalized);
        this.size = normalized.length;
        this.maxZoom = opts.maxZoom;
        this.minZoom = opts.minZoom;
        this.placeByKey = new Map(normalized.map((item) => [item.key, item.place]));
        this._leafCache = new Map();
        this._expansionCache = new Map();
        this.index = new Supercluster({
            radius: radiusForCssPixels(opts.radiusPx, opts.extent),
            extent: opts.extent,
            minZoom: opts.minZoom,
            maxZoom: opts.maxZoom,
            minPoints: opts.minPoints,
            map: (props) => ({ h1: props.h1, h2: props.h2 }),
            reduce: (acc, props) => {
                acc.h1 = (acc.h1 ^ props.h1) >>> 0;
                acc.h2 = (acc.h2 + props.h2) >>> 0;
            }
        });
        this.index.load(normalized.map((item) => ({
            type: 'Feature',
            properties: { key: item.key, h1: hashString(item.key), h2: hashString(item.key, HASH_SEED_2) },
            geometry: { type: 'Point', coordinates: [item.lng, item.lat] }
        })));
    }

    /** 外观数据（名称、分类）更新不重建索引，只替换引用。 */
    updatePlaces(normalized) {
        for (const item of normalized) {
            if (this.placeByKey.has(item.key)) this.placeByKey.set(item.key, item.place);
        }
    }

    /** 查询层级限制在 maxZoom 内：越过聚类上限时 Supercluster 会直接吐出重合的单点。 */
    clampZoom(zoom) {
        return Math.max(this.minZoom, Math.min(this.maxZoom, Math.round(zoom)));
    }

    _toNode(feature) {
        const props = feature.properties || {};
        const [lng, lat] = feature.geometry.coordinates;
        if (props.cluster) {
            const count = props.point_count;
            return {
                key: `cluster:${this.generation}:${props.cluster_id}`,
                kind: 'cluster',
                clusterId: props.cluster_id,
                coordinate: [lng, lat],
                count,
                memberSignature: `${count}:${(props.h1 >>> 0).toString(36)}:${(props.h2 >>> 0).toString(36)}`
            };
        }
        return {
            key: props.key,
            kind: 'place',
            coordinate: [lng, lat],
            count: 1,
            memberSignature: props.key,
            place: this.placeByKey.get(props.key)
        };
    }

    /** @param {[number, number, number, number]} bbox [west, south, east, north] */
    query(bbox, zoom) {
        if (!this.size) return [];
        return this.index.getClusters(bbox, this.clampZoom(zoom)).map((f) => this._toNode(f));
    }

    children(node) {
        if (!node || node.kind !== 'cluster') return [];
        try {
            return this.index.getChildren(node.clusterId).map((f) => this._toNode(f));
        } catch (e) {
            return [];
        }
    }

    /** 聚合真正拆开的层级；大于 maxZoom 表示到最大缩放仍无法分开（坐标重合或过近）。 */
    expansionZoom(node) {
        if (!node || node.kind !== 'cluster') return this.minZoom;
        const cached = this._expansionCache.get(node.clusterId);
        if (cached !== undefined) return cached;
        let zoom;
        try {
            zoom = this.index.getClusterExpansionZoom(node.clusterId);
        } catch (e) {
            zoom = this.maxZoom + 1;
        }
        this._expansionCache.set(node.clusterId, zoom);
        return zoom;
    }

    /** 成员 key（已排序），按需展开并缓存；用于核对签名与跨代成员交集。 */
    memberKeys(node) {
        if (!node) return [];
        if (node.kind !== 'cluster') return [node.key];
        const cached = this._leafCache.get(node.clusterId);
        if (cached) return cached;
        let keys = [];
        try {
            keys = this.index.getLeaves(node.clusterId, Infinity).map((f) => f.properties.key).sort();
        } catch (e) {
            keys = [];
        }
        this._leafCache.set(node.clusterId, keys);
        return keys;
    }

    /**
     * node 在更大缩放级别 zoom 下可见的后代（同一索引代内的真实树关系）。
     * budget 为最多访问的节点数（数字，或可在多次调用间共享的 { remaining } 计数器）；
     * 超出时返回 null，由调用方降级为渐变。
     */
    descendantsAt(node, zoom, budget = 400) {
        const target = this.clampZoom(zoom);
        const counter = typeof budget === 'object' && budget ? budget : { remaining: budget };
        const out = [];
        const walk = (current) => {
            if (--counter.remaining < 0) return false;
            if (current.kind !== 'cluster' || target < this.expansionZoom(current)) {
                out.push(current);
                return true;
            }
            const kids = this.children(current);
            if (!kids.length) {
                out.push(current);
                return true;
            }
            for (const kid of kids) {
                if (!walk(kid)) return false;
            }
            return true;
        };
        return walk(node) ? out : null;
    }
}

export function createEngine(list, options) {
    return new ClusterEngine(normalizePlaces(list), options);
}
