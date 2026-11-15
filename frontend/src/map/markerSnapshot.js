// 地图标记的数据（取代按视野请求的 /places/nearby，见 backend modules/places/services/placeMarkers.js）：
//
// 1. 公共快照 GET /places/markers：全部公开地点的精简字段（按列存 fields + rows），与观看者无关，
//    CDN 和浏览器都能缓存；请求不带 Authorization，App 里也不发预检。上一份存在 IndexedDB，
//    下次打开先用它画出标记，再后台刷新。快照里的地点带 marker_only: true，打开卡片时再读
//    GET /places/:id 补全描述、图片、创建者等（MapView 的 ensurePlaceDetail）。
// 2. 个人叠加 GET /places/overlay（登录时）：自己还在审核中 / 未通过的地点（完整行），
//    以及观看者屏蔽的住民创建的地点 id。
// 3. 本地修改（新增、修改、删除、评价）：立即生效，直到快照追上（标记字段一致、或删除的地点已不在快照里），
//    最多保留 PATCH_TTL_MS。CDN 上的快照最多晚一两分钟，这段时间靠本地修改撑住。
//
// 这里不依赖 React 和地图，npm run test:map 直接测试。

import { placeKey } from './cluster/engine.js';
import { readCache, writeCache } from '../platform/cacheStore.js';

export const PATCH_TTL_MS = 10 * 60 * 1000;
/** 地图移动时快照超过这个时间就后台刷新一次（CDN 与浏览器有缓存，大多数刷新不回源） */
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
/** 刷新失败后，非强制刷新至少隔这么久再试 */
export const SNAPSHOT_RETRY_MS = 15 * 1000;
const STORAGE_PREFIX = 'map.markers.v1:';

/** 接口返回的按列快照 → 地点对象；格式不对时为 null */
export function expandMarkerSnapshot(data) {
    if (!data || typeof data.version !== 'string' || !Array.isArray(data.fields) || !Array.isArray(data.rows)) return null;
    const fields = data.fields.map(String);
    const places = [];
    for (const row of data.rows) {
        if (!Array.isArray(row)) continue;
        const place = { marker_only: true };
        for (let i = 0; i < fields.length; i += 1) place[fields[i]] = row[i] === undefined ? null : row[i];
        places.push(place);
    }
    return { version: data.version, generatedAt: Number(data.generated_at) || 0, fields, places };
}

function sameFields(a, b, fields) {
    for (const field of fields) {
        if ((a?.[field] ?? null) !== (b?.[field] ?? null)) return false;
    }
    return true;
}

/**
 * 合并快照、个人叠加与本地修改，得到地图上的地点列表。
 * all() 在内容不变时返回同一个数组，React 状态可以直接比较引用。
 */
export class MarkerSnapshotStore {
    constructor({ now = () => Date.now(), patchTtlMs = PATCH_TTL_MS } = {}) {
        this.now = now;
        this.patchTtlMs = patchTtlMs;
        this.snapshot = null;
        this.overlay = { own: [], hiddenIds: new Set(), signature: '[]|' };
        this.patches = new Map();
        this.version = 0;
        this._memo = null;
    }

    get hasSnapshot() {
        return !!this.snapshot;
    }

    /** 写入一份快照；比当前的旧（generatedAt 更早）或内容相同时忽略。返回地图数据是否变化 */
    setSnapshot(expanded) {
        if (!expanded || !Array.isArray(expanded.places)) return false;
        const current = this.snapshot;
        if (current && expanded.generatedAt < current.generatedAt) return false;
        if (current && current.version === expanded.version) {
            current.generatedAt = Math.max(current.generatedAt, expanded.generatedAt);
            return false;
        }
        const byKey = new Map();
        for (const place of expanded.places) {
            const key = placeKey(place);
            if (key) byKey.set(key, place);
        }
        this.snapshot = { version: expanded.version, generatedAt: expanded.generatedAt, fields: expanded.fields || [], byKey };
        // 快照追上了的本地修改不再需要
        for (const [key, patch] of this.patches) {
            const row = byKey.get(key);
            if (patch.place === null ? !row : (row && sameFields(row, patch.place, this.snapshot.fields))) this.patches.delete(key);
        }
        this._bump();
        return true;
    }

    /** 个人叠加（GET /places/overlay 的响应；退出登录传 null）。返回地图数据是否变化 */
    setOverlay(data) {
        const own = Array.isArray(data?.own) ? data.own.filter((place) => placeKey(place)) : [];
        const hiddenIds = new Set((Array.isArray(data?.hidden_ids) ? data.hidden_ids : []).map(String));
        // 叠加层是刚读到的，自己这些地点的本地修改以它为准
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

    /** 换账号：个人叠加与本地修改都作废 */
    resetPersonal() {
        const changed = this.patches.size > 0 || this.overlay.own.length > 0 || this.overlay.hiddenIds.size > 0;
        this.patches.clear();
        this.overlay = { own: [], hiddenIds: new Set(), signature: '[]|' };
        if (changed) this._bump();
        return changed;
    }

    /** 本地新增 / 修改：立即显示 */
    upsert(place) {
        const key = placeKey(place);
        if (!key) return;
        this.patches.set(key, { place, at: this.now() });
        this._bump();
    }

    /** 本地删除：立即从地图上去掉 */
    remove(placeOrKey) {
        const key = typeof placeOrKey === 'string' ? placeOrKey : placeKey(placeOrKey);
        if (!key) return;
        this.patches.set(key, { place: null, at: this.now() });
        this._bump();
    }

    /** 只改地图上那份地点的部分字段（例如评价汇总）；没有这个地点或值没变时不动，返回是否改了 */
    patchPlace(key, fields) {
        const current = this.get(key);
        if (!current) return false;
        if (Object.keys(fields).every((field) => (current[field] ?? null) === (fields[field] ?? null))) return false;
        this.upsert({ ...current, ...fields });
        return true;
    }

    get(key) {
        return this._compose().byKey.get(key) || null;
    }

    all() {
        return this._compose().list;
    }

    _bump() {
        this.version += 1;
        this._memo = null;
    }

    _compose() {
        const now = this.now();
        if (this._memo && now < this._memo.expiresAt) return this._memo;
        const byKey = new Map(this.snapshot ? this.snapshot.byKey : []);
        for (const place of this.overlay.own) byKey.set(placeKey(place), place);
        let expiresAt = Infinity;
        for (const [key, patch] of this.patches) {
            if (now - patch.at >= this.patchTtlMs) {
                this.patches.delete(key);
                continue;
            }
            expiresAt = Math.min(expiresAt, patch.at + this.patchTtlMs);
            if (patch.place) byKey.set(key, patch.place);
            else byKey.delete(key);
        }
        for (const id of this.overlay.hiddenIds) byKey.delete(`place:${id}`);
        const previous = this._memo;
        const list = Array.from(byKey.values());
        // 本地修改过期但内容没变时沿用旧数组
        const same = previous && previous.list.length === list.length && previous.list.every((place, index) => place === list[index]);
        this._memo = { byKey, list: same ? previous.list : list, expiresAt };
        return this._memo;
    }
}

/** 读取快照接口；不带 Authorization，走浏览器默认缓存（max-age 内直接用、过期后带 ETag 校验） */
export async function fetchMarkerSnapshot(backendUrl, { signal } = {}) {
    const res = await fetch(`${backendUrl}/places/markers`, { signal });
    if (!res.ok) throw new Error(`Failed to fetch place markers: ${res.status}`);
    return res.json();
}

/**
 * 一个后端地址一份快照来源，所有地图实例（首页地图、全屏选点）共用：
 * 启动时先读本机上一份，同时请求网络；新快照推给订阅者并存回本机。
 */
export class MarkerSnapshotSource {
    constructor({ fetchSnapshot, readStored = async () => null, writeStored = async () => undefined, now = () => Date.now() }) {
        this.fetchSnapshot = fetchSnapshot;
        this.readStored = readStored;
        this.writeStored = writeStored;
        this.now = now;
        this.current = null;
        this.fetchedAt = -Infinity;
        this.failedAt = -Infinity;
        this.request = null;
        /** 本机缓存读完（有没有都算）后 resolve；start() 之前为 null */
        this.storedLoaded = null;
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        if (this.current) listener(this.current);
        return () => this.listeners.delete(listener);
    }

    /**
     * 地图打开时调用：第一次先读本机缓存；网络快照不够新（或从没成功过）时请求，不受失败后的等待限制。
     * 返回网络请求（失败时 reject）
     */
    start() {
        if (!this.storedLoaded) {
            this.storedLoaded = Promise.resolve()
                .then(() => this.readStored())
                .then((raw) => this._accept(expandMarkerSnapshot(raw), null))
                .catch(() => { /* 本机缓存可有可无 */ });
        }
        return this.refresh({ force: true });
    }

    /** 超过 maxAgeMs 才重新请求；同一时间只有一个请求。force 忽略失败后的等待 */
    refresh({ maxAgeMs = SNAPSHOT_MAX_AGE_MS, force = false } = {}) {
        if (this.request) return this.request;
        const now = this.now();
        if (now - this.fetchedAt < maxAgeMs) return Promise.resolve(this.current);
        if (!force && now - this.failedAt < SNAPSHOT_RETRY_MS) {
            return Promise.reject(Object.assign(new Error('marker snapshot retry pending'), { code: 'RETRY_PENDING' }));
        }
        this.request = Promise.resolve()
            .then(() => this.fetchSnapshot())
            .then((raw) => {
                const expanded = expandMarkerSnapshot(raw);
                if (!expanded) throw new Error('Invalid place markers response');
                this.fetchedAt = this.now();
                this._accept(expanded, raw);
                return this.current;
            })
            .catch((error) => {
                this.failedAt = this.now();
                throw error;
            })
            .finally(() => { this.request = null; });
        return this.request;
    }

    _accept(expanded, raw) {
        if (!expanded) return;
        if (this.current && (expanded.generatedAt < this.current.generatedAt || expanded.version === this.current.version)) return;
        this.current = expanded;
        if (raw) Promise.resolve().then(() => this.writeStored(raw)).catch(() => { /* 写不进去下次就从网络读 */ });
        for (const listener of this.listeners) {
            try { listener(expanded); } catch (error) { console.warn('标记快照回调失败', error); }
        }
    }
}

const sources = new Map();

export function markerSnapshotSource(backendUrl) {
    let source = sources.get(backendUrl);
    if (!source) {
        const key = STORAGE_PREFIX + backendUrl;
        source = new MarkerSnapshotSource({
            fetchSnapshot: () => fetchMarkerSnapshot(backendUrl),
            readStored: () => readCache(key),
            writeStored: (raw) => writeCache(key, raw)
        });
        sources.set(backendUrl, source);
    }
    return source;
}

/** 启动时（main.jsx）与高德 SDK 并行开始加载，地图建好时标记数据多半已经到了 */
export function prefetchMarkerSnapshot(backendUrl) {
    if (!backendUrl) return;
    markerSnapshotSource(backendUrl).start().catch(() => { /* 地图页会提示并重试 */ });
}
