// 地图标记层控制器：所有数据入口（附近、搜索、沿途、增删改、外观更新）都收敛到 update()，
// 由这里决定索引、快照、持久覆盖物和转场时序。React 只提交目标数据，不逐帧参与标记定位。
//
// 时序规则：
// - 缩放结束后提交完整目标快照；跨瓦片级别时等待对应数据，既有节点跟随地图。
// - zoomstart / movestart / 页面隐藏 / 销毁时终止转场并收敛到目标快照，手势始终优先。
// - 分帧调和进行中相机移动或有新提交时，调和继续完成（不再起动画），不退回上一份快照；新结果到达后从当前标记接替。
// - 每个转场有版本号，过期的完成回调不会回收新节点。
// - 单点标记的名称总是显示（不做碰撞避让）；转场期间先隐藏，相机静止、转场结束后统一显示。

import { CLUSTER_DEFAULTS } from './cluster/engine.js';
import { shouldRefineMarkerAnchors } from './cluster/snapshot.js';
import { planTransition } from './cluster/transitions.js';
import { createComputeScheduler } from './cluster/computeScheduler.js';
import { createWorkerClient } from './cluster/workerClient.js';
import { prepareClusterInput } from './cluster/computeInput.js';
import { t } from '../i18n/index.js';
import { createMarkerRenderQueue } from './markerRenderQueue.js';
import {
    createMarkerParts, applyNodeAppearance, glyphSize
} from './markerContent.js';
import { readViewBounds, readMapViewport, getMapZoomRange, projectToContainer } from './viewport.js';
import { getMotionPolicy, startFrameProbe } from '../motion/policy.js';
import { NativeClusterLayer } from './nativeClusterLayer.js';

// 设计起点，依据真机调节
export const MARKER_TIMING = Object.freeze({
    merge: 260,           // 旧图形朝父聚合移动
    mergeTargetDelay: 110,
    mergeTarget: 210,     // 父聚合接续出现并轻微回弹
    labelOut: 80,
    split: 320,
    splitSource: 170,
    fadeIn: 160,
    fadeOut: 140,
    reposition: 220,
    reducedFade: 120,
    cleanupFade: 80
});

const LIMITS = Object.freeze({ travelers: 160, ghosts: 120, degradedGhosts: 30 });
const SDK_MARKER_BATCH = 4;
// Marker creation, placement and attachment share a cancellable frame budget.
const Z_INDEX = Object.freeze({ ghost: 100, place: 110, cluster: 120, selected: 400 });
const EASE_OUT = 'cubic-bezier(0.22, 0.8, 0.25, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';
const ONSCREEN_MARGIN = 80;
// 双指手势结束后这段时间内的标记点按不生效
const MULTI_TOUCH_TAP_GUARD_MS = 350;
const TOUCH_TAP_SLOP_PX = 10;
const TOUCH_SDK_CLICK_GUARD_MS = 500;

function readDebugFlag() {
    try { return window.localStorage.getItem('debug.mapMetrics') === '1'; } catch (e) { return false; }
}

function setMarkerZ(marker, z) {
    try {
        if (typeof marker.setzIndex === 'function') marker.setzIndex(z);
        else if (typeof marker.setZIndex === 'function') marker.setZIndex(z);
    } catch (e) { /* ignore */ }
}

function sameCoordinate(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function sameViewport(a,b) {
    if (a === b) return true;
    return !!a && !!b && ['zoom','minLng','maxLng','minLat','maxLat'].every(key=>Math.abs(a[key]-b[key])<1e-7);
}

export class MarkerLayerController {
    /**
     * @param {object} map AMap.Map
     * @param {{
     *   getMarkerViewZoom?: (zoom: number) => number,
     *   onViewSettled?: (viewport: object) => void,
     *   onPlaceClick?: (place: object, node: object) => void,
     *   onClusterClick?: (node: object) => void,
     *   clusterRadiusPx?: number
     * }} options
     */
    constructor(map, options = {}) {
        this.map = map;
        this.AMap = window.AMap;
        this.options = options;
        this.zoomRange = getMapZoomRange(map);
        this.dataRevision = 0;
        this.viewRevision = 0;
        this.placeByKey = new Map();
        this.currentPlaces = [];
        this.scheduler = createComputeScheduler({
            execute: target => this._compute(target),
            onResult: (result,target) => this._receive(result,target),
            onError: error => this._computeError(error)
        });
        this.queryMode = 'nearby';
        this.markerBand = null;
        this.snapshot = null;
        this.logicalZoom = undefined;
        this.entries = new Map();
        this.selectedKey = null;
        this.version = 0;
        this.txns = new Set();
        this.cameraMoving = false;
        // 每次相机开始移动加一；调和途中发现它变了，就停止新动画并丢弃旧的投影缓存
        this.cameraEpoch = 0;
        this.destroyed = false;
        this.commitRaf = 0;
        this.labelRaf = 0;
        this.labelVisible = new Set();
        this.metrics = { indexBuilds: [], commits: [], frames: [], preparation: [], worker: [], renderSlices: [], domCount: 0 };
        this.pendingAttachments = [];
        this.renderQueue = createMarkerRenderQueue({
            flushSlice: () => this._flushAttachments(),
            onSlice: metric => this._pushMetric('renderSlices', metric)
        });
        this.cleanupQueue = createMarkerRenderQueue({onSlice:metric=>this._pushMetric('renderSlices',metric)});
        this.retiredMarkers = new Set();
        this.placeVersions = new Map();
        // 双指缩放时一根手指可能落在标记上：松手时不能当作点按（否则会展开聚合或打开地点卡片，地图跳到别处）
        this.multiTouch = false;
        this.multiTouchEndedAt = -Infinity;
        this.touchCount = 0;
        this.touchCameraFrame = 0;
        this.touchStartView = null;
        this._onTouch = (event) => {
            // Track the whole physical session, including a finger released
            // outside the container. SDK end events can occur mid-pinch or be
            // missing entirely for a pinch centered on the map.
            if (!this.touchCount && !(event.type === 'touchstart' && this.touchTarget?.contains(event.target))) return;
            const count = event.touches ? event.touches.length : 0;
            if (count && !this.touchCount) {
                this.touchStartView ||= readMapViewport(this.map);
                if (this.touchCameraFrame) cancelAnimationFrame(this.touchCameraFrame);
                this.touchCameraFrame = 0;
                // Keep touch targets connected until the last finger lifts.
                this.renderQueue.pause();
                this.cleanupQueue.pause();
            }
            this.touchCount = count;
            if (count > 1) {
                this.multiTouch = true;
            } else if (count === 0 && this.multiTouch) {
                this.multiTouch = false;
                this.multiTouchEndedAt = performance.now();
            }
            if (!count) this._settleTouchCamera();
        };
        this.touchTarget = map.getContainer?.() || null;
        if (this.touchTarget) {
            // 捕获阶段：先于高德在同一次 touchend 里判定点按
            for (const type of ['touchstart', 'touchend', 'touchcancel']) {
                window.addEventListener(type, this._onTouch, { capture: true, passive: true });
            }
        }

        this._onMoveStart = () => {
            if (!this.cameraMoving) this.cameraStartZoom = Number(this.map.getZoom());
            this.cameraMoving = true;
            this.cameraEpoch++;
            this.scheduler.invalidate();
            // 进行中的调和继续完成（不再起新动画），不退回上一份快照：
            // 退回会把刚显示的新标记撤掉、旧标记重建，下一次提交又换回来，连续缩放时标记一闪一闪。
            this._finishAll();
        };
        this._onZoomChange = () => {
            if (this.isTouchCameraActive()) return;
            if (this.cameraMoving && shouldRefineMarkerAnchors(this.snapshot, Number(this.map.getZoom()), this.cameraStartZoom)) {
                this._commit('refine');
            }
        };
        this._onMoveEnd = () => {
            if (this.isTouchCameraActive()) return;
            this.cameraMoving = false;
            this._scheduleCommit('camera');
        };
        this._onResize = () => this._scheduleCommit('resize');
        this._onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                if (this.touchCameraFrame) cancelAnimationFrame(this.touchCameraFrame);
                this.touchCameraFrame = 0; this.touchCount = 0; this.touchStartView = null; this.multiTouch = false;
                this.scheduler.invalidate(); this._cancelRender(); this._finishAll(); this.renderQueue.pause(); this.cleanupQueue.pause();
            }
            else { this._settleTouchCamera('resume'); }
        };
        for (const type of ['movestart', 'zoomstart', 'dragstart']) map.on(type, this._onMoveStart);
        for (const type of ['moveend', 'zoomend']) map.on(type, this._onMoveEnd);
        map.on('zoomchange', this._onZoomChange);
        map.on('resize', this._onResize);
        document.addEventListener('visibilitychange', this._onVisibility);
        this.nativeClusters = new NativeClusterLayer(this);
        // 开发环境，或在设备上设置 localStorage['debug.mapMetrics'] = '1' 时暴露控制器，便于记录性能数据
        if (typeof window !== 'undefined' && (import.meta.env?.DEV || readDebugFlag())) window.__foodMapMarkers = this;
    }

    // ---------------- 数据入口 ----------------

    /**
     * 单一更新入口。places 为当前模式下应参与聚合的完整列表。
     * 只有 key、坐标或参与聚类的集合变化才重建索引；名称、分类等变化只刷新外观。
     */
    async update({ places = [], queryMode = 'nearby', markerBand = null } = {}) {
        if (this.destroyed) return;
        // 进行中的调和保留到新结果到达时由 _apply 接替，避免先退回旧快照再换新（闪烁）
        ++this.dataRevision;
        this.currentPlaces = places;
        this.queryMode = queryMode;
        this.markerBand = markerBand;
        // Submit before preparation so continuous arrivals preserve the deadline.
        if (!this.cameraMoving && !this.isTouchCameraActive()) this._commit('data');
    }

    isTouchCameraActive() { return this.touchCount > 0 || !!this.touchCameraFrame; }

    _settleTouchCamera(reason = 'camera') {
        if (this.touchCameraFrame) cancelAnimationFrame(this.touchCameraFrame);
        let last = readMapViewport(this.map), stableSince = performance.now();
        const check = () => {
            if (this.destroyed || this.touchCount) { this.touchCameraFrame = 0; return; }
            const view = readMapViewport(this.map), now = performance.now();
            if (!sameViewport(view,last)) { last = view; stableSince = now; }
            if (now-stableSince < 50) { this.touchCameraFrame = requestAnimationFrame(check); return; }
            this.touchCameraFrame = 0;
            const changed = view && !sameViewport(view,this.touchStartView);
            this.touchStartView = null;
            const needsCommit = changed || this.cameraMoving || this.snapshot?.dataRevision !== this.dataRevision;
            this.cameraMoving = false;
            // The page must load the final tile band too; a controller-only
            // fallback would keep waiting for data from the previous band.
            try { if (changed) this.options.onViewSettled?.(view); }
            finally {
                if (needsCommit) this._scheduleCommit(reason);
                this.renderQueue.resume(); this.cleanupQueue.resume();
            }
        };
        this.touchCameraFrame = requestAnimationFrame(check);
    }

    setSelectedKey(key) {
        if (this.selectedKey === key) return;
        const previous = this.selectedKey;
        this.selectedKey = key || null;
        if (this.snapshot?.nodeByKey.get(this.selectedKey)?.sourceCoordinate) {
            this._commit('selection');
        }
        for (const k of [previous, this.selectedKey]) {
            const entry = k ? this.entries.get(k) : null;
            if (entry && !entry.ghost) this._refreshAppearance(entry);
        }
        this._scheduleLabels();
    }

    setNativeGlassVisible(visible) {
        this.nativeClusters?.setVisible(visible);
    }

    /** 皮肤等外观来源变化后重画全部标记（不重建、不打断转场） */
    refreshAppearance() {
        if (this.destroyed) return;
        for (const entry of this.entries.values()) {
            if (!entry.ghost) this._refreshAppearance(entry);
        }
        this._scheduleLabels();
    }

    getEngine() {
        return null; // The web index belongs exclusively to the worker.
    }

    getZoomState() {
        return { logicalZoom:this.snapshot?.logicalZoom,minZoom:this.zoomRange.min,maxZoom:this.zoomRange.max };
    }

    async getClusterInfo(nodeKey, dataRevision = this.snapshot?.dataRevision) {
        return this.client.request('clusterInfo',{nodeKey},{dataRevision});
    }

    async getClusterMembers(nodeKey, dataRevision = this.snapshot?.dataRevision) {
        const places = this.placeVersions.get(dataRevision) || this.placeByKey;
        const {keys} = await this.client.request('members',{nodeKey},{dataRevision});
        return keys.map(key=>places.get(key)).filter(Boolean);
    }

    async getPlaceRevealZoom(place,baseZoom,maxZoom,dataRevision = this.snapshot?.dataRevision) {
        if (!this.client || !this.snapshot) return Math.min(baseZoom,maxZoom);
        const {zoom} = await this.client.request('reveal',{place,baseZoom,maxZoom},{dataRevision});
        return zoom;
    }

    /** 搜索结果自动适配视野时使用。 */
    getDataBounds() {
        return this.dataBounds || null;
    }

    destroy() {
        if (this.destroyed) return;
        this.nativeClusters?.destroy();
        this._finishAll();
        this.destroyed = true;
        this.scheduler.destroy();
        this.renderQueue.destroy();
        this.cleanupQueue.destroy();
        this.prepareAbort?.abort();
        this.client?.destroy();
        this.errorButton?.remove();
        if (this.commitRaf) cancelAnimationFrame(this.commitRaf);
        if (this.touchCameraFrame) cancelAnimationFrame(this.touchCameraFrame);
        this.touchCameraFrame = 0; this.touchCount = 0; this.touchStartView = null;
        if (this.labelRaf) cancelAnimationFrame(this.labelRaf);
        const map = this.map;
        try {
            for (const type of ['movestart', 'zoomstart', 'dragstart']) map.off(type, this._onMoveStart);
            for (const type of ['moveend', 'zoomend']) map.off(type, this._onMoveEnd);
            map.off('zoomchange', this._onZoomChange);
            map.off('resize', this._onResize);
        } catch (e) { /* ignore */ }
        document.removeEventListener('visibilitychange', this._onVisibility);
        if (this.touchTarget) {
            for (const type of ['touchstart', 'touchend', 'touchcancel']) {
                window.removeEventListener(type, this._onTouch, { capture: true });
            }
            this.touchTarget = null;
        }
        const markers = [...Array.from(this.entries.values()).filter((entry) => entry.attached).map((entry) => entry.marker),...this.retiredMarkers];
        this._removeMarkers(markers);
        this.retiredMarkers.clear();
        this.entries.clear();
        if (typeof window !== 'undefined' && window.__foodMapMarkers === this) delete window.__foodMapMarkers;
    }

    // ---------------- 快照提交 ----------------

    _scheduleCommit(reason) {
        if (this.destroyed || this.commitRaf) return;
        this.commitRaf = requestAnimationFrame(() => {
            this.commitRaf = 0;
            if (!this.cameraMoving && !this.isTouchCameraActive()) this._commit(reason);
        });
    }

    _commit(reason) {
        if (this.destroyed) return;
        const viewBounds = readViewBounds(this.map);
        if (!viewBounds) return;
        const zoom = Number(this.map.getZoom());
        this.scheduler.submit({
            kind:reason === 'data' ? 'data' : 'camera',reason,dataRevision:this.dataRevision,viewRevision:++this.viewRevision,places:this.currentPlaces,
            immediate:!this.snapshot || this.snapshot.queryMode !== this.queryMode
                || ['kind','tile','cell'].some(key=>this.snapshot.markerBand?.[key] !== this.markerBand?.[key]),
            payload:{viewBounds,zoom,refining:reason === 'refine',
                viewZoom:this.options.getMarkerViewZoom?.(zoom),queryMode:this.queryMode,markerBand:this.markerBand,
                selectedKey:this.selectedKey,transitionVersion:this.version+1,orphans:true}
        });
    }

    async _compute(target) {
        this.client ||= createWorkerClient({...this.options.workerOptions,onFatal:error=>this._computeError(error)});
        const payload = {...target.payload};
        let prepared = this.prepared;
        if (prepared?.revision !== target.dataRevision) {
            const started = performance.now();
            const abort = this.prepareAbort = new AbortController();
            const input = await prepareClusterInput(target.places, { signal: abort.signal });
            if (this.destroyed || target.dataRevision !== this.dataRevision) return {skipped:true};
            prepared = this.prepared = {revision:target.dataRevision,...input};
            this._pushMetric('preparation',{size:input.data.keys.length,ms:performance.now()-started});
        }
        const transfer = [];
        if (this.sentRevision !== prepared.revision) {
            payload.data = prepared.data;
            payload.options = {minZoom:Math.max(0,Math.floor(this.zoomRange.min)),maxZoom:Math.min(30,Math.ceil(this.zoomRange.max)),
                radiusPx:this.options.clusterRadiusPx || CLUSTER_DEFAULTS.radiusPx};
            transfer.push(prepared.data.coordinates.buffer);
            this.sentRevision = prepared.revision;
        }
        target.byKey = prepared.byKey;
        return this.client.request('compute',payload,{
            dataRevision:target.dataRevision,viewRevision:target.viewRevision,baseSnapshotId:this.snapshot?.snapshotId
        },transfer);
    }

    async _receive(result,target) {
        if (result.skipped || this.destroyed || target.dataRevision !== this.dataRevision) return;
        const started = performance.now();
        const visibleNodes = result.nodes.map(node=>({...node,dataRevision:result.dataRevision,
            ...(node.kind === 'place' ? {place:target.byKey.get(node.key)} : {})}));
        const next = {...result,visibleNodes,nodeByKey:new Map(visibleNodes.map(node=>[node.key,node]))};
        for (const revision of this.placeVersions.keys()) {
            if (revision !== this.snapshot?.dataRevision && revision !== result.dataRevision) this.placeVersions.delete(revision);
        }
        this.placeVersions.set(result.dataRevision,target.byKey);
        this.errorButton?.remove(); this.errorButton = null;
        this._pushMetric('worker',{...result.metrics,maxSendMs:this.client.metrics.maxSendMs});
        if (result.metrics.indexMs > 0) this._pushMetric('indexBuilds',{size:result.metrics.inputCount,ms:result.metrics.indexMs});
        // 不等分帧调和完成就放开计算调度：相机停下后的新结果要能直接接替进行中的调和，
        // 而不是排在一份已过时的调和后面（慢设备上会晚几秒）。
        this._apply(result.plan,next,target.reason,result.orphanPlan).then(applied => {
            if (applied === false || this.destroyed) return;
            this.client?.acknowledge(result.snapshotId);
            for (const revision of this.placeVersions.keys()) if (revision !== result.dataRevision) this.placeVersions.delete(revision);
            this._pushMetric('commits',{reason:target.reason,kind:result.plan.kind,nodes:visibleNodes.length,ms:performance.now()-started});
        }).catch(error => this._computeError(error));
    }

    _computeError(error) {
        if (this.destroyed) return;
        console.warn('Map marker computation failed',error);
        this.client?.destroy(); this.client = null; this.sentRevision = null;
        if (!this.retriedWorker) { this.retriedWorker = true; this.retry(); return; }
        if (!this.errorButton) {
            const button = this.errorButton = document.createElement('button');
            button.className = 'fm-marker-retry';
            button.textContent = t('map:main.reload');
            button.onclick = () => this.retry();
            this.map.getContainer()?.appendChild(button);
        }
    }

    retry() {
        this.retriedWorker = true;
        this.update({places:this.currentPlaces,queryMode:this.queryMode,markerBand:this.markerBand});
    }

    _pushMetric(kind, value) {
        this.options.onMetric?.(kind,value);
        const list = this.metrics[kind];
        list.push(value);
        if (list.length > 60) list.shift();
    }

    // ---------------- 覆盖物与转场 ----------------

    _createEntry(node) {
        const parts = createMarkerParts();
        const marker = new this.AMap.Marker({
            position: node.coordinate,
            content: parts.root,
            anchor: 'top-left',
            offset: new this.AMap.Pixel(0, 0),
            zIndex: node.kind === 'cluster' ? Z_INDEX.cluster : Z_INDEX.place,
            bubble: false
        });
        const entry = { key: node.key, node, marker, parts, ghost: false, size: null, interactive:false };
        parts.root.dataset.staged = '';
        this._setInteractive(entry,false);
        marker.on('click', () => this._handleActivate(entry));
        // entry 会在单点与聚合之间复用，所以监听常驻，按当前节点类型判断。
        // 原生玻璃只负责显示；轻触由 DOM 命中区域处理，不依赖高德合成 click。
        let touch = null;
        const blockSdkClick = () => { entry.touchSdkBlockedUntil = performance.now() + TOUCH_SDK_CLICK_GUARD_MS; };
        parts.hit.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' || entry.node.kind !== 'cluster') entry.touchSdkBlockedUntil = 0;
            const clusterTouch = event.pointerType === 'touch' && entry.node.kind === 'cluster';
            if (clusterTouch) {
                blockSdkClick();
                // 浏览器在触摸点按后补发兼容鼠标事件；高德收到其中的 mousedown 会停下进行中的动画，
                // 点聚合的放大因此停在半路（如 13→14 停在 13.1，聚合拆不开）。取消 pointerdown 不再补发鼠标事件；
                // 高德的拖动、捏合用触摸事件，不受影响。
                if (event.cancelable) event.preventDefault();
            }
            touch = clusterTouch && event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
        });
        parts.hit.addEventListener('pointermove', (event) => {
            if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > TOUCH_TAP_SLOP_PX) touch = null;
        });
        parts.hit.addEventListener('pointercancel', () => { if (touch) blockSdkClick(); touch = null; });
        parts.hit.addEventListener('pointerup', (event) => {
            const start = touch;
            touch = null;
            if (event.pointerType === 'touch' && entry.node.kind === 'cluster') blockSdkClick();
            if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TOUCH_TAP_SLOP_PX) return;
            // 等本轮地图手势收尾后再移动相机，避免 touchend 的 SDK 清理打断缩放。
            requestAnimationFrame(() => {
                if (this.entries.get(entry.key) === entry && entry.node.kind === 'cluster') this._handleActivate(entry, 'touch');
            });
        });
        parts.hit.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._handleActivate(entry, 'keyboard');
            }
        });
        this._refreshAppearance(entry);
        return entry;
    }

    _refreshAppearance(entry) {
        const selected = entry.key === this.selectedKey;
        entry.size = applyNodeAppearance(entry.parts, entry.node, { selected });
        const base = entry.node.kind === 'cluster'
            ? Z_INDEX.cluster + Math.min(40, Math.round(Math.log2(entry.node.count) * 4))
            : Z_INDEX.place;
        const z = selected ? Z_INDEX.selected : base;
        if (entry.z !== z) { setMarkerZ(entry.marker,z); entry.z = z; }
        this.nativeClusters?.invalidate();
    }

    _handleActivate(entry, source = 'sdk') {
        if (this.destroyed || entry.ghost || entry.interactive === false) return;
        const now = performance.now();
        if (this.multiTouch || now - this.multiTouchEndedAt < MULTI_TOUCH_TAP_GUARD_MS) return;
        if (source === 'sdk' && now < (entry.touchSdkBlockedUntil || 0)) return;
        const node = entry.node;
        if (node.kind === 'place') this.options.onPlaceClick?.(node.place, node);
        else this.options.onClusterClick?.(node);
    }

    _setInteractive(entry,enabled) {
        entry.interactive = enabled;
        entry.parts.hit.tabIndex = enabled ? 0 : -1;
        entry.parts.hit.setAttribute('aria-disabled',enabled ? 'false' : 'true');
        entry.parts.root.toggleAttribute('data-pending',!enabled);
    }

    _removeMarkers(markers) {
        if (!markers.length) return;
        try {
            if (typeof this.map.remove === 'function') this.map.remove(markers);
            else markers.forEach((m) => m.setMap(null));
        } catch (e) {
            markers.forEach((m) => { try { m.setMap(null); } catch (err) { /* ignore */ } });
        }
    }

    _queueAttachment(marker, onAttached) {
        this.pendingAttachments.push({ marker, onAttached });
        if (this.pendingAttachments.length === SDK_MARKER_BATCH) this._flushAttachments();
    }

    _flushAttachments() {
        if (!this.pendingAttachments.length) return;
        const batch = this.pendingAttachments;
        this.pendingAttachments = [];
        this._addMarkers(batch.map(({ marker }) => marker));
        for (const { onAttached } of batch) onAttached?.();
    }

    _addMarkers(markers) {
        if (!markers.length) return;
        try {
            if (typeof this.map.add === 'function') this.map.add(markers);
            else markers.forEach((m) => m.setMap(this.map));
        } catch (e) {
            markers.forEach((m) => { try { m.setMap(this.map); } catch (err) { /* ignore */ } });
        }
    }

    _containerSize() {
        const el = this.map.getContainer?.();
        return el ? { width: el.clientWidth, height: el.clientHeight } : { width: window.innerWidth, height: window.innerHeight };
    }

    /** 读取元素当前可视的位移、缩放与透明度（动画进行中也准确）。 */
    _readVisual(el) {
        const cs = getComputedStyle(el);
        let tx = 0, ty = 0, scale = 1;
        if (cs.transform && cs.transform !== 'none' && typeof DOMMatrixReadOnly === 'function') {
            const m = new DOMMatrixReadOnly(cs.transform);
            tx = m.m41;
            ty = m.m42;
            scale = Math.hypot(m.a, m.b) || 1;
        }
        return { tx, ty, scale, opacity: Number(cs.opacity) };
    }

    /**
     * 接管仍在播放转场的节点：记下当前可视状态并取消旧动画，新动画从这里出发，
     * 而不是跳回旧起点重新播放或直接跳到终点。没有进行中的动画时返回 null。
     */
    _takeOver(entry, measured) {
        if (!entry.anims || !entry.anims.size) return null;
        const visual = measured || { travel: this._readVisual(entry.parts.travel), glyph: this._readVisual(entry.parts.glyph) };
        for (const anim of Array.from(entry.anims)) {
            try { anim.cancel(); } catch (e) { /* ignore */ }
        }
        entry.anims.clear();
        return visual;
    }

    _cancelRender({restore = true} = {}) {
        if (!this.renderQueue?.cancel()) return;
        this._finishAll();
        if (!restore || this.destroyed) return;
        if (this.snapshot) {
            const snapshot = this.snapshot;
            this.renderQueue.replace({version:this.version+1,operations:this._render(planTransition(null,snapshot),snapshot,'resume')})
                .catch(error=>this._computeError(error));
        } else {
            const markers = [...this.entries.values()].filter(entry=>entry.attached).map(entry=>entry.marker);
            this.entries.clear();
            this._retireMarkers(markers);
        }
    }

    _apply(plan, next, reason, orphans = null) {
        this._cancelRender({restore:false});
        return this.renderQueue.replace({version:this.version+1,operations:this._render(plan,next,reason,orphans)});
    }

    /**
     * @param {object} plan 以上一份确认快照为基准的转场计划
     * @param {object|null} orphans 被打断的调和留下的节点（主计划里没有）的去向，见 planOrphans
     */
    *_render(plan, next, reason, orphans = null) {
        const policy = getMotionPolicy();
        // 新手势开始时旧转场已收敛。相机结束事件可能晚于数据提交，保留刚开始的转场。
        if (reason === 'resize' || reason === 'resume' || !policy.clusterMotion || !policy.pageVisible) {
            this._finishAll();
        }
        const version = ++this.version;
        let animate = policy.clusterMotion && policy.pageVisible && !this.cameraMoving
            && plan.kind !== 'initial' && reason !== 'resume';
        const reduced = policy.reducedMotion;
        const degraded = policy.degradeLevel > 0;
        const size = this._containerSize();
        const projCache = new Map();
        // 调和跨多帧。相机开始移动后（_onMoveStart 已收敛本次转场）不再起动画或残影，
        // 屏幕投影也需重新计算；剩余节点直接就位，等相机停下后的提交接替。
        let epoch = this.cameraEpoch;
        const stopMotionIfCameraMoved = () => {
            if (this.cameraEpoch === epoch) return;
            epoch = this.cameraEpoch;
            animate = false;
            projCache.clear();
        };
        const project = (coordinate) => {
            const id = `${coordinate[0]},${coordinate[1]}`;
            if (!projCache.has(id)) projCache.set(id, projectToContainer(this.map, coordinate));
            return projCache.get(id);
        };
        const onscreen = (p) => !!p && p.x > -ONSCREEN_MARGIN && p.y > -ONSCREEN_MARGIN
            && p.x < size.width + ONSCREEN_MARGIN && p.y < size.height + ONSCREEN_MARGIN;

        const oldEntries = new Map(this.entries);
        const nextEntries = new Map();
        const prevEntryByKey = new Map(oldEntries);
        const animations = [];
        const ghosts = [];
        const ghostLimit = degraded ? LIMITS.degradedGhosts : LIMITS.ghosts;
        const existingGhosts = this._ghostCount();
        const txn = {version,animations,ghosts,done:false,probe:startFrameProbe()};
        this.txns.add(txn);
        let travelers = 0;
        const run = (entry, el, keyframes, timing) => {
            if (!el || typeof el.animate !== 'function') return null;
            const anim = el.animate(keyframes, { fill: 'backwards', ...timing });
            animations.push(anim);
            if (!entry.anims) entry.anims = new Set();
            entry.anims.add(anim);
            const drop = () => entry.anims && entry.anims.delete(anim);
            anim.finished.then(drop, drop);
            return anim;
        };
        // 从接管时的可视状态回到静止位置
        const settle = (entry, visual, offset) => {
            const tx = offset.x + (visual ? visual.travel.tx : 0);
            const ty = offset.y + (visual ? visual.travel.ty : 0);
            const opacity = visual ? visual.travel.opacity : 1;
            if (Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5 || opacity < 0.99) {
                run(entry, entry.parts.travel, [
                    { transform: `translate(${tx}px, ${ty}px)`, opacity },
                    { transform: 'translate(0px, 0px)', opacity: 1 }
                ], { duration: reduced ? MARKER_TIMING.reducedFade : MARKER_TIMING.reposition, easing: EASE_OUT });
            }
            if (visual && (Math.abs(visual.glyph.scale - 1) > 0.01 || visual.glyph.opacity < 0.99)) {
                run(entry, entry.parts.glyph, [
                    { transform: `scale(${visual.glyph.scale})`, opacity: visual.glyph.opacity },
                    { transform: 'scale(1)', opacity: 1 }
                ], { duration: MARKER_TIMING.fadeIn, easing: EASE_OUT });
            }
        };

        // ---- 目标节点 ----
        const visuals = new Map();
        for (const entry of oldEntries.values()) {
            yield {sdk:false};
            if (entry.anims?.size) visuals.set(entry,{travel:this._readVisual(entry.parts.travel),glyph:this._readVisual(entry.parts.glyph)});
        }
        // 合并的旧节点跟着父聚合在同一步开始收拢，不等全部目标节点建完：
        // 调和要分很多帧，等到最后才收拢会先显示父聚合、旧节点停在原处，再缩小时两者同屏。
        const mergeSources = new Map();
        for (const relations of [plan.mergeInto, orphans?.mergeInto]) {
            for (const [prevKey, nextKey] of relations || []) {
                yield {sdk:false};
                if (!mergeSources.has(nextKey)) mergeSources.set(nextKey, []);
                mergeSources.get(nextKey).push(prevKey);
            }
        }
        const mergeTargetOf = key => plan.mergeInto.get(key) ?? orphans?.mergeInto.get(key);
        const isMergeTarget = key => plan.mergeTargets.has(key) || !!orphans?.mergeTargets.has(key);
        const isSplitSource = key => plan.splitSources.has(key) || !!orphans?.splitSources.has(key);
        // 主计划的来源已不在屏幕上时（被打断的调和已换掉它），改用留下的节点
        const orphanEntry = (relations, key, entries) => {
            for (const from of relations?.get(key) || []) if (entries.has(from)) return entries.get(from);
            return null;
        };
        const sourceOnscreen = key => (mergeSources.get(key) || []).some(prevKey => {
            const source = oldEntries.get(prevKey);
            return !!source?.attached && onscreen(project(source.node.coordinate));
        });
        const priority = node => node.key === this.selectedKey ? 0
            : onscreen(project(node.coordinate)) || sourceOnscreen(node.key) ? 1 : 2;
        const buckets = [[],[],[]];
        for (const node of next.visibleNodes) { yield {sdk:false}; buckets[priority(node)].push(node); }
        const retireSplitSource = (source) => {
            if (!source || !oldEntries.delete(source.key)) return;
            this.entries.delete(source.key);
            this._setInteractive(source,false);
            const visual = this._takeOver(source,visuals.get(source));
            source.ghost = true;
            source.parts.root.dataset.ghost = '';
            source.parts.label.dataset.hidden = '';
            if (!source.attached) return;
            if (!animate || ghosts.length + existingGhosts >= ghostLimit || !onscreen(project(source.node.coordinate))) {
                this._removeMarkers([source.marker]);
                return;
            }
            setMarkerZ(source.marker,Z_INDEX.ghost);
            ghosts.push(source);
            const glyph = visual?.glyph || {scale:1,opacity:1};
            run(source,source.parts.glyph,[
                {transform:`scale(${glyph.scale})`,opacity:glyph.opacity},
                {transform:'scale(0.86)',opacity:0}
            ],{duration:MARKER_TIMING.splitSource,easing:'ease-in',fill:'both'});
        };
        // 退出节点：残影只做视觉过渡，不可点击。没有动画时把标记放进 removals，由调用方一次移除。
        // 返回是否有 SDK 操作。
        const retire = (key, entry, removals) => {
            this.entries.delete(key);
            const own = animate ? project(entry.node.coordinate) : null;
            const visual = this._takeOver(entry,visuals.get(entry));
            if (!entry.attached) return false;
            if (!animate || !own || !onscreen(own) || ghosts.length + existingGhosts >= ghostLimit) {
                entry.ghost = true;
                entry.parts.root.dataset.ghost = '';
                removals.push(entry.marker);
                return true;
            }
            const startTravel = visual ? visual.travel : { tx: 0, ty: 0, opacity: 1 };
            const startGlyph = visual ? visual.glyph : { scale: 1, opacity: 1 };
            entry.ghost = true;
            entry.parts.root.dataset.ghost = '';
            entry.parts.label.dataset.hidden = '';
            setMarkerZ(entry.marker, Z_INDEX.ghost);
            ghosts.push(entry);
            const targetKey = mergeTargetOf(key);
            const targetNode = targetKey ? next.nodeByKey.get(targetKey) : null;
            const target = targetNode ? project(targetNode.coordinate) : null;
            const fromTranslate = `translate(${startTravel.tx}px, ${startTravel.ty}px)`;
            if (target && !reduced && travelers < LIMITS.travelers) {
                travelers += 1;
                run(entry, entry.parts.travel, [
                    { transform: fromTranslate, opacity: startTravel.opacity },
                    { transform: `translate(${target.x - own.x}px, ${target.y - own.y}px)`, opacity: startTravel.opacity }
                ], { duration: MARKER_TIMING.merge, easing: EASE_IN_OUT, fill: 'both' });
                run(entry, entry.parts.glyph, [
                    { transform: `scale(${startGlyph.scale})`, opacity: startGlyph.opacity },
                    { transform: 'scale(0.82)', opacity: startGlyph.opacity, offset: 0.7 },
                    { transform: 'scale(0.72)', opacity: 0 }
                ], { duration: MARKER_TIMING.merge, easing: EASE_IN_OUT, fill: 'both' });
            } else if (isSplitSource(key) && !reduced) {
                run(entry, entry.parts.glyph, [
                    { transform: `scale(${startGlyph.scale})`, opacity: startGlyph.opacity },
                    { transform: 'scale(0.86)', opacity: 0 }
                ], { duration: MARKER_TIMING.splitSource, easing: 'ease-in', fill: 'both' });
            } else {
                run(entry, entry.parts.travel, [
                    { transform: fromTranslate, opacity: startTravel.opacity },
                    { transform: fromTranslate, opacity: 0 }
                ], {
                    duration: reduced ? MARKER_TIMING.reducedFade : MARKER_TIMING.fadeOut,
                    easing: 'ease-in',
                    fill: 'both'
                });
            }
            return true;
        };
        for (const node of buckets.flat()) {
            yield {sdk:false};
            stopMotionIfCameraMoved();
            // 先让汇入这个节点的旧节点开始收拢（或在无动画时移除），同一步里再建父聚合，
            // 中途暂停或被打断时每组要么全是旧节点，要么已经换成父聚合。
            const sources = mergeSources.get(node.key);
            if (sources) {
                const removals = [];
                for (const key of sources) {
                    const source = oldEntries.get(key);
                    if (!source) continue;
                    oldEntries.delete(key);
                    retire(key, source, removals);
                }
                this._removeMarkers(removals);
            }
            const fromKey = plan.reuse.get(node.key);
            let entry = (fromKey ? oldEntries.get(fromKey) : null) || oldEntries.get(node.key)
                || orphanEntry(orphans?.reuse, node.key, oldEntries);
            if (entry) {
                oldEntries.delete(entry.key);
                this.entries.delete(entry.key);
                const previousNode = entry.node;
                const previousZ = entry.z, wasAttached = entry.attached;
                entry.key = node.key;
                entry.node = node;
                this._setInteractive(entry,false);
                this.entries.set(node.key,entry);
                const moved = !sameCoordinate(previousNode.coordinate, node.coordinate);
                const recounted = previousNode.count !== node.count;
                if (moved || recounted) {
                    const visual = this._takeOver(entry,visuals.get(entry));
                    const animateMove = animate && !plan.reanchor.has(node.key);
                    let offset = { x: 0, y: 0 };
                    if (moved) {
                        const from = animateMove ? project(previousNode.coordinate) : null;
                        entry.marker.setPosition(node.coordinate);
                        const to = animateMove ? project(node.coordinate) : null;
                        if (from && to && (onscreen(from) || onscreen(to)) && !reduced) offset = { x: from.x - to.x, y: from.y - to.y };
                    }
                    if (animateMove) settle(entry, visual, offset);
                    if (recounted && animate && !reduced && !degraded && !(visual && visual.glyph.opacity < 0.99)) {
                        run(entry, entry.parts.glyph, [
                            { transform: 'scale(0.94)' },
                            { transform: 'scale(1.04)', offset: 0.6 },
                            { transform: 'scale(1)' }
                        ], { duration: MARKER_TIMING.mergeTarget, easing: EASE_OUT });
                    }
                }
                // 没有变化的节点保留进行中的动画（例如刚刚开始的拆分），不打断
                this._refreshAppearance(entry);
                nextEntries.set(node.key, entry);
                // 尚未挂载的缓冲节点已经进入可见范围（平移后）：立即挂载
                if (!entry.attached) {
                    const pos = project(node.coordinate);
                    if (pos && onscreen(pos)) {
                        entry.attached = true;
                        this._queueAttachment(entry.marker);
                    }
                }
                yield {sdk:moved || previousZ !== entry.z || !wasAttached};
                continue;
            }

            entry = this._createEntry(node);
            nextEntries.set(node.key, entry);
            this.entries.set(node.key,entry);
            const own = project(node.coordinate);
            entry.attached = true;
            const reveal = () => { delete entry.parts.root.dataset.staged; };
            const sourceKey = plan.splitFrom.get(node.key);
            const parentEntry = (sourceKey ? prevEntryByKey.get(sourceKey) : null)
                || orphanEntry(orphans?.splitFrom, node.key, prevEntryByKey);
            retireSplitSource(parentEntry);
            if (!animate) {
                this._queueAttachment(entry.marker, reveal);
                yield {sdk:true};
                continue;
            }
            const parentNode = parentEntry ? parentEntry.node : null;
            let parentPoint = parentNode ? project(parentNode.coordinate) : null;
            if (parentPoint && parentEntry.anims && parentEntry.anims.size) {
                // 父节点仍在移动：从它当前的可视位置出发
                const v = visuals.get(parentEntry)?.travel || {tx:0,ty:0};
                parentPoint = { x: parentPoint.x + v.tx, y: parentPoint.y + v.ty };
            }

            // Start Web Animations only after the SDK has actually attached the DOM.
            this._queueAttachment(entry.marker, () => {
                reveal();
                if (parentPoint && onscreen(parentPoint) && !reduced && travelers < LIMITS.travelers) {
                    travelers += 1;
                    const parentScale = glyphSize(parentNode).height / glyphSize(node).height;
                    run(entry, entry.parts.travel, [
                        { transform: `translate(${parentPoint.x - own.x}px, ${parentPoint.y - own.y}px)` },
                        { transform: 'translate(0px, 0px)' }
                    ], { duration: MARKER_TIMING.split, easing: EASE_OUT });
                    run(entry, entry.parts.glyph, [
                        { transform: `scale(${Math.min(1, parentScale * 0.7).toFixed(3)})`, opacity: 0.35 },
                        { transform: 'scale(1)', opacity: 1, offset: 0.55 },
                        { transform: 'scale(1)', opacity: 1 }
                    ], { duration: MARKER_TIMING.split, easing: EASE_OUT });
                } else if (isMergeTarget(node.key) && !reduced && onscreen(own)) {
                    const keyframes = degraded
                        ? [{ transform: 'scale(0.86)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }]
                        : [
                            { transform: 'scale(0.82)', opacity: 0 },
                            { transform: 'scale(1.06)', opacity: 1, offset: 0.55 },
                            { transform: 'scale(0.985)', opacity: 1, offset: 0.8 },
                            { transform: 'scale(1)', opacity: 1 }
                        ];
                    run(entry, entry.parts.glyph, keyframes, {
                        duration: MARKER_TIMING.mergeTarget,
                        delay: MARKER_TIMING.mergeTargetDelay,
                        easing: 'ease-out'
                    });
                } else if (onscreen(own)) {
                    run(entry, entry.parts.travel, [{ opacity: 0 }, { opacity: 1 }], {
                        duration: reduced ? MARKER_TIMING.reducedFade : MARKER_TIMING.fadeIn,
                        easing: 'ease-out'
                    });
                }
            });
            yield {sdk:true};
        }

        this._flushAttachments();

        // ---- 其余退出节点（汇入父聚合的已在上面处理） ----

        for (const [key, entry] of oldEntries) {
            yield {sdk:false};
            stopMotionIfCameraMoved();
            const removals = [];
            if (!retire(key, entry, removals)) continue;
            this._removeMarkers(removals);
            yield {sdk:true};
        }


        for (const entry of nextEntries.values()) {
            yield {sdk:false};
            delete entry.parts.root.dataset.staged;
            entry.parts.hit.tabIndex = 0;
            entry.parts.hit.setAttribute('aria-disabled','false');
            entry.parts.root.removeAttribute('data-pending');
        }
        this.entries = nextEntries;
        this.snapshot = next;
        this.logicalZoom = next.logicalZoom;
        this.dataBounds = next.dataBounds;
        this.placeByKey = this.placeVersions.get(next.dataRevision) || this.placeByKey;
        for (const entry of nextEntries.values()) entry.interactive = true;
        this.metrics.domCount = nextEntries.size + ghosts.length + existingGhosts;

        // 新增的单点在转场后段才显示名称：先隐藏，转场结束时统一布局
        if (animations.length && !txn.done) {
            for (const entry of nextEntries.values()) {
                if (!this.labelVisible.has(entry.key)) entry.parts.label.dataset.hidden = '';
            }
        }


        this.nativeClusters?.invalidate();
        // txn.done：调和途中相机移动，转场已被 _finishAll 收敛，名称按最终状态重新布局
        if (txn.done || !animations.length) {
            this._completeTransaction(txn);
            if (!this.txns.size) this._scheduleLabels();
            return;
        }
        Promise.all(animations.map((anim) => anim.finished.catch(() => null))).then(() => this._completeTransaction(txn));
    }

    _ghostCount() {
        let count = 0;
        for (const txn of this.txns) if (!txn.done) count += txn.ghosts.length;
        return count;
    }

    _retireMarkers(markers) {
        for (const marker of markers) this.retiredMarkers.add(marker);
        if (this.cleanupQueue.busy || this.destroyed) return;
        const controller = this;
        this.cleanupQueue.replace({version:this.version,operations:(function*() {
            while (controller.retiredMarkers.size) {
                const markers = [];
                for (const marker of controller.retiredMarkers) {
                    controller.retiredMarkers.delete(marker);
                    markers.push(marker);
                    if (markers.length === SDK_MARKER_BATCH) break;
                }
                controller._removeMarkers(markers);
                yield;
            }
        })()}).catch(error=>console.warn('Marker cleanup failed',error));
    }

    _completeTransaction(txn) {
        if (txn.done) return;
        txn.done = true;
        this.txns.delete(txn);
        if (txn.probe) this._pushMetric('frames', txn.probe());
        if (txn.ghosts.length) {
            for (const entry of txn.ghosts) entry.parts.root.dataset.retired = '';
            this._retireMarkers(txn.ghosts.map((entry) => entry.marker));
        }
        this.nativeClusters?.invalidate();
        if (!this.txns.size) this._scheduleLabels();
    }

    /** 收敛到完整目标快照：取消全部转场（元素回到静态的最终样式），立即回收残影。 */
    _finishAll() {
        for (const txn of Array.from(this.txns)) {
            for (const anim of txn.animations) {
                try { anim.cancel(); } catch (e) { /* ignore */ }
            }
            this._completeTransaction(txn);
        }
        for (const entry of this.entries.values()) {
            if (entry.anims) {
                for (const anim of entry.anims) { try { anim.cancel(); } catch (e) { /* already removed */ } }
                entry.anims.clear();
            }
        }
    }

    // ---------------- 名称显隐 ----------------

    _scheduleLabels() {
        if (this.destroyed || this.labelRaf) return;
        this.labelRaf = requestAnimationFrame(() => {
            this.labelRaf = 0;
            this._layoutLabels();
        });
    }

    // 只要标记以单点显示（没有被聚合），名称就跟着显示；名称不再与其他名称或图标互相避让。
    // 转场进行中先隐藏，吸附动画结束后统一显示
    _layoutLabels() {
        if (this.destroyed || this.cameraMoving || this.txns.size) return;
        const visible = new Set();
        for (const entry of this.entries.values()) {
            const show = entry.attached && !entry.ghost && entry.node.kind === 'place' && !!entry.node.place?.name;
            if (show) {
                delete entry.parts.label.dataset.hidden;
                visible.add(entry.key);
            } else {
                entry.parts.label.dataset.hidden = '';
            }
        }
        this.labelVisible = visible;
    }
}
