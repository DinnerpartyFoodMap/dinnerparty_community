// 附近地点的范围缓存与请求失效控制。
//
// 后端 /places/nearby 按范围返回全部地点（无分页截断），因此一次成功响应可以视为该范围内的完整数据：
// 范围内缓存里有而响应里没有的地点即已删除或移出。缓存有点数与区域数上限，按最近使用淘汰旧区域。

import { boundsContains, expandBounds, pointInBounds } from './snapshot.js';
import { placeKey } from './engine.js';

export const PLACE_CACHE_DEFAULTS = Object.freeze({
    ttlMs: 2 * 60 * 1000,
    maxPlaces: 8000,
    maxRegions: 12,
    edgeRatio: 0.5
});

export class PlaceRangeCache {
    constructor(options = {}) {
        this.options = { ...PLACE_CACHE_DEFAULTS, ...options };
        this.now = options.now || (() => Date.now());
        this.regions = [];
        this.places = new Map();
        this.version = 0;
    }

    /**
     * covered：视野完全落在某个已加载区域内；fresh：该区域未过期；
     * nearEdge：视野向外扩展 edgeRatio 个视口后超出覆盖，应在后台请求下一片区域。
     */
    coverage(viewBounds) {
        const now = this.now();
        const outer = expandBounds(viewBounds, this.options.edgeRatio);
        let covered = false;
        let fresh = false;
        let nearEdge = true;
        for (const region of this.regions) {
            if (!boundsContains(region.bounds, viewBounds)) continue;
            covered = true;
            region.lastUsed = now;
            if (now - region.fetchedAt <= this.options.ttlMs) fresh = true;
            if (boundsContains(region.bounds, outer)) nearEdge = false;
        }
        return { covered, fresh: covered && fresh, nearEdge: !covered || nearEdge };
    }

    /** 写入一次成功响应。返回数据是否真的发生了变化。 */
    apply(bounds, list, { fetchedAt = this.now() } = {}) {
        let changed = false;
        const incoming = new Map();
        for (const place of Array.isArray(list) ? list : []) {
            const key = placeKey(place);
            if (key) incoming.set(key, place);
        }
        for (const [key, place] of this.places) {
            if (!incoming.has(key) && pointInBounds(bounds, Number(place.longitude), Number(place.latitude))) {
                this.places.delete(key);
                changed = true;
            }
        }
        for (const [key, place] of incoming) {
            const previous = this.places.get(key);
            if (previous !== place) {
                if (!previous || JSON.stringify(previous) !== JSON.stringify(place)) changed = true;
                this.places.set(key, place);
            }
        }
        this.regions = this.regions.filter((region) => !boundsContains(bounds, region.bounds));
        this.regions.push({ bounds: { ...bounds }, fetchedAt, lastUsed: fetchedAt });
        if (this._evict()) changed = true;
        if (changed) this.version += 1;
        return changed;
    }

    _evict() {
        const { maxPlaces, maxRegions } = this.options;
        let evicted = false;
        while (this.regions.length > 1 && (this.regions.length > maxRegions || this.places.size > maxPlaces)) {
            let oldest = 0;
            for (let i = 1; i < this.regions.length - 1; i++) {
                if (this.regions[i].lastUsed < this.regions[oldest].lastUsed) oldest = i;
            }
            this.regions.splice(oldest, 1);
            for (const [key, place] of this.places) {
                const lng = Number(place.longitude);
                const lat = Number(place.latitude);
                if (!this.regions.some((region) => pointInBounds(region.bounds, lng, lat))) {
                    this.places.delete(key);
                    evicted = true;
                }
            }
        }
        return evicted;
    }

    /** 让所有区域过期（例如从后台恢复、增删改地点后），下一次加载必定请求网络。 */
    invalidate() {
        for (const region of this.regions) region.fetchedAt = -Infinity;
    }

    /** 本地增删改后立即反映到缓存，不等待下一次请求。 */
    upsert(place) {
        const key = placeKey(place);
        if (!key) return;
        this.places.set(key, place);
        this.version += 1;
    }

    remove(placeOrKey) {
        const key = typeof placeOrKey === 'string' ? placeOrKey : placeKey(placeOrKey);
        if (key && this.places.delete(key)) this.version += 1;
    }

    all() {
        return Array.from(this.places.values());
    }

    clear() {
        this.regions = [];
        this.places.clear();
        this.version += 1;
    }
}

/**
 * 请求闸门：每次开始新请求时取消旧请求，并用递增序号保证即使取消失败，旧响应也不能覆盖新状态。
 * invalidate() 用于模式切换（进入搜索、沿途等）：未完成的附近请求全部作废。
 */
export class RequestGate {
    constructor() {
        this.seq = 0;
        this.controller = null;
    }

    begin() {
        this.invalidate();
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        this.controller = controller;
        return { id: this.seq, signal: controller ? controller.signal : undefined };
    }

    isCurrent(ticket) {
        return !!ticket && ticket.id === this.seq;
    }

    invalidate() {
        this.seq += 1;
        if (this.controller) {
            try { this.controller.abort(); } catch (e) { /* ignore */ }
        }
        this.controller = null;
    }
}
