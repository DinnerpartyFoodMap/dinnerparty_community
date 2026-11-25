// iOS 原生底图的标记层：与 MarkerLayerController 同一个入口（update / setSelectedKey / refreshAppearance / destroy），
// 同一套聚合与转场规则，只是不在网页里画东西。
//
// - 聚合：复用网页的 Worker，按缩放、视野生成快照和转场计划。只保留最新的等待请求，
//   原生确认后才以该快照为下一次转场的起点。相机移动中跨层级或移出缓冲区时立即请求。
// - 显示：节点（单点或聚合）是 MapKit 的标注视图，拖动缩放时与底图同帧移动；合并 / 拆分动画由原生按计划用 Core Animation
//   播放，节奏与网页的 MARKER_TIMING 相同。网页只在聚合层级变化、视野出缓冲区、数据变化时发一次，不逐帧参与。
// - 点按：单点回传 markerTap（打开卡片），聚合回传 clusterTap，交给 MapView 的 handleClusterClick（与网页相同的展开逻辑）。
import { CLUSTER_DEFAULTS } from './cluster/engine.js';
import { resolveMarkerZoom, boundsContains, expandBounds, shouldRefineMarkerAnchors } from './cluster/snapshot.js';
import { createComputeRuntime } from './cluster/computeRuntime.js';
import { createComputeScheduler } from './cluster/computeScheduler.js';
import { prepareClusterInput } from './cluster/computeInput.js';
import { createWorkerClient } from './cluster/workerClient.js';
import { PLACE_GLYPH, CLUSTER_GLYPH } from './cluster/glyph.js';
import { placeGlyphKind, markerImageSources, DEFAULT_CLUSTER_CROP } from './markerContent.js';
import { readViewBounds, getMapZoomRange } from './viewport.js';
import { nativeImageSource } from '../skins/nativeSkin.js';
import { nativeColor } from '../platform/nativeMap.js';
import { getMotionPolicy } from '../motion/policy.js';
import { t } from '../i18n/index.js';

// 原生视图只在进入屏幕时创建，所以节点范围可以给大一些：上下左右各多一屏，平移时很少需要等新节点
export const NATIVE_BUFFER_RATIO = 1;

function cssVar(name) {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) {
        return '';
    }
}

function percent(value, fallback) {
    const number = parseFloat(value);
    return Number.isFinite(number) && /%\s*$/.test(String(value)) ? Math.min(1, Math.max(0, number / 100)) : fallback;
}

/**
 * 原生标记的样式：与 marker-motion.css 同一套取值（皮肤槽位的 CSS 变量优先，否则用设计令牌），
 * 按当前主题色与深浅色算好；图片只给原生能直接读的地址（App 包内资源或位图 data URL，SVG 皮肤图退回默认图）。
 */
export function buildNativeMarkerStyle({ readVar = cssVar, sources = markerImageSources(), imageSource = nativeImageSource } = {}) {
    const image = (entry) => imageSource(entry.src) || imageSource(entry.fallback);
    const skinCluster = !sources.cluster.isDefault && imageSource(sources.cluster.src);
    const color = (...names) => {
        for (const name of names) {
            const value = nativeColor(readVar(name));
            if (value) return value;
        }
        return undefined;
    };
    return {
        glyphs: {
            place: image(sources.place),
            avoid: image(sources.avoid),
            unexplored: image(sources.unexplored),
            add: image(sources.add)
        },
        glyphWidth: PLACE_GLYPH.width,
        glyphHeight: PLACE_GLYPH.height,
        clusterImage: skinCluster || imageSource(sources.cluster.fallback),
        // 默认聚合图裁去透明留白（与网页相同），皮肤图用整张画布
        clusterCrop: skinCluster ? undefined : [DEFAULT_CLUSTER_CROP.x, DEFAULT_CLUSTER_CROP.y, DEFAULT_CLUSTER_CROP.width, DEFAULT_CLUSTER_CROP.height],
        clusterWidth: CLUSTER_GLYPH.width,
        clusterHeight: CLUSTER_GLYPH.height,
        countX: percent(readVar('--skin-marker-count-x'), skinCluster ? 0.54 : 0.5),
        countY: percent(readVar('--skin-marker-count-y'), skinCluster ? 0.3 : 0.35),
        countColor: color('--skin-marker-count-color', '--color-on-emphasis'),
        labelText: color('--skin-marker-label-color', '--color-text-primary'),
        labelBackground: color('--skin-marker-label-bg', '--color-bg-surface'),
        labelBorder: color('--skin-marker-label-border', '--theme-primary'),
        avoidText: color('--color-danger-text', '--color-danger'),
        avoidBackground: color('--color-bg-overlay'),
        avoidBorder: color('--color-danger'),
        kindSuffix: {
            avoid: t('map:marker.avoidSuffix'),
            unexplored: t('map:marker.unexploredSuffix'),
            add: t('map:marker.unmarkedSuffix')
        },
        clusterLabel: t('map:marker.clusterLabel', { count: '%d' })
    };
}

/** 快照里的节点 → 原生节点（店铺坐标；原生前的坐标换算在 NativeMapView.setNodes） */
export function nativeNode(node) {
    const cluster = node.kind === 'cluster';
    const place = cluster ? null : node.place || {};
    return {
        id: node.key,
        cluster,
        lng: node.coordinate[0],
        lat: node.coordinate[1],
        count: node.count,
        name: place ? String(place.name || '') : '',
        glyph: place ? placeGlyphKind(place) : 'place'
    };
}

function nodesSignature(nodes) {
    return nodes.map((n) => `${n.id}|${n.lng}|${n.lat}|${n.count}|${n.glyph}|${n.name}`).join('\n');
}

function createLocalClient() {
    const runtime = createComputeRuntime();
    return {
        request: (op, payload, versions) => runtime.handle({ op, payload, ...versions }),
        acknowledge: (snapshotId) => runtime.handle({ op: 'commitAck', payload: { snapshotId } }),
        destroy: () => runtime.handle({ op: 'dispose' })
    };
}

export class NativeMarkerLayer {
    /**
     * @param {import('./nativeMapView.js').NativeMapView} map
     * @param {{ getMarkerViewZoom?: (zoom: number) => number,
     *           onPlaceClick?: (place: object, node: object) => void,
     *           onClusterClick?: (node: object) => void,
     *           clusterRadiusPx?: number, workerOptions?: object }} options
     */
    constructor(map, options = {}) {
        this.map = map;
        this.options = options;
        this.zoomRange = getMapZoomRange(map);
        this.snapshot = null;
        this.currentPlaces = [];
        this.dataRevision = 0;
        this.frameRevision = 0;
        this.appliedFrameRevision = 0;
        this.needsBridgeSync = false;
        this.pendingView = null;
        this.localCompute = typeof Worker !== 'function' && !options.workerOptions?.createWorker;
        this.queryMode = 'nearby';
        this.markerBand = null;
        this.selectedKey = null;
        this.sentKeys = new Set();
        this.sentSignature = '';
        this.version = 0;
        this.cameraMoving = false;
        this.styleKey = '';
        this.styleTimer = 0;
        this.destroyed = false;
        this.scheduler = createComputeScheduler({
            execute: (target) => this._compute(target),
            onResult: (result, target) => this._receive(result, target),
            onError: (error, target) => this._computeError(error, target)
        });

        this._onMoveStart = () => {
            if (!this.cameraMoving) {
                this.cameraStartZoom = Number(this.map.getZoom());
                this._invalidateView();
            }
            this.cameraMoving = true;
        };
        // 移动中：聚合层级变了（捏合、减速、点聚合后的放大动画）或视野出了缓冲区，立即换节点
        this._onMapMove = () => {
            const previous = this.pendingView || this.snapshot;
            if (this.destroyed || !previous) return;
            const zoom = Number(this.map.getZoom());
            const logical = this._resolveZoom(zoom, previous.logicalZoom);
            if (logical === null) {
                if (this.pendingView) this._invalidateView();
                return;
            }
            const viewBounds = readViewBounds(this.map);
            const refining = !this.pendingView && this.cameraMoving && this.snapshot?.dataRevision === this.dataRevision
                && logical === this.snapshot.logicalZoom && shouldRefineMarkerAnchors(this.snapshot, zoom, this.cameraStartZoom);
            if (refining || logical !== previous.logicalZoom || (viewBounds && !boundsContains(previous.coverageBounds, viewBounds))) {
                this._commit('live', refining);
            }
        };
        this._onMoveEnd = () => {
            this.cameraMoving = false;
            this._commit('camera');
        };
        this._onMarkerTap = ({ id }) => {
            const node = this.snapshot?.nodeByKey.get(id);
            const place = node?.place;
            if (place) this.options.onPlaceClick?.(place, node);
        };
        this._onClusterTap = ({ id }) => {
            const node = this.snapshot?.nodeByKey.get(id);
            if (node?.kind === 'cluster') return this.options.onClusterClick?.(node);
        };
        // 校准结果变了：同一份节点按新坐标重发（不播放转场）
        this._onFrameChange = () => {
            ++this.frameRevision;
            this._commit('frames');
        };
        map.on('movestart', this._onMoveStart);
        map.on('mapmove', this._onMapMove);
        map.on('moveend', this._onMoveEnd);
        map.on('markerTap', this._onMarkerTap);
        map.on('clusterTap', this._onClusterTap);
        map.on('framechange', this._onFrameChange);

        // 主题色、深浅色、皮肤变化：重新下发样式（网页标记靠 CSS 变量自动更新，原生要显式下发）
        this._onTheme = () => this._scheduleStyle();
        window.addEventListener('themechange', this._onTheme);
        this.themeObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(this._onTheme) : null;
        this.themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-skin', 'class'] });
        this.refreshAppearance();
    }

    /** 单一数据入口：当前模式下应参与聚合的完整列表（同 MarkerLayerController.update） */
    update({ places = [], queryMode = 'nearby', markerBand = null } = {}) {
        if (this.destroyed) return;
        ++this.dataRevision;
        this.prepareAbort?.abort();
        this.currentPlaces = places;
        this.queryMode = queryMode;
        this.markerBand = markerBand;
        if (!this.cameraMoving) this._commit('data');
    }

    _invalidateView() {
        this.scheduler.invalidate();
        this.prepareAbort?.abort();
        this.pendingView = null;
    }

    _commit(reason, refining = false, retryBridge = false) {
        if (this.destroyed || !this.dataRevision) return;
        const viewBounds = readViewBounds(this.map);
        if (!viewBounds) return;
        const zoom = Number(this.map.getZoom());
        const viewZoom = this.options.getMarkerViewZoom?.(zoom);
        const logicalZoom = this._resolveZoom(zoom, this.snapshot?.logicalZoom, viewZoom);
        if (logicalZoom === null) {
            this._invalidateView();
            return;
        }
        const kind = reason === 'data' ? 'data' : 'camera';
        const target = {
            kind, reason, retryBridge, viewRevision: ++this.version, dataRevision: this.dataRevision,
            logicalZoom, coverageBounds: expandBounds(viewBounds, NATIVE_BUFFER_RATIO), places: this.currentPlaces,
            immediate: !this.snapshot || this.queryMode !== this.snapshot.queryMode
                || ['kind', 'tile', 'cell'].some((key) => this.markerBand?.[key] !== this.snapshot.markerBand?.[key]),
            payload: { viewBounds, zoom, viewZoom, refining, queryMode: this.queryMode, markerBand: this.markerBand,
                bufferRatio: NATIVE_BUFFER_RATIO, selectedKey: this.selectedKey, transitionVersion: this.version }
        };
        this.pendingView = target;
        this.scheduler.submit(target);
    }

    async _compute(target) {
        if (!this.client) {
            const options = this.options.workerOptions;
            if (this.localCompute) this.client = createLocalClient();
            else if (options?.createWorker) this.client = createWorkerClient(options);
            else {
                // Bundle the worker so WKWebView can start it without a capacitor: worker request.
                const { default: InlineWorker } = await import('./cluster/computeWorker.js?worker&inline');
                if (this.destroyed) return { skipped: true };
                this.client = createWorkerClient({ ...options, createWorker: () => new InlineWorker() });
            }
        }
        const { dataRevision, places } = target;
        const payload = { ...target.payload };
        if (this.prepared?.revision !== dataRevision) {
            const abort = this.prepareAbort = new AbortController();
            const prepared = await prepareClusterInput(places, { signal: abort.signal });
            if (this.destroyed || dataRevision !== this.dataRevision) return { skipped: true };
            this.prepared = { ...prepared, revision: dataRevision };
        }
        target.byKey = this.prepared.byKey;
        const transfer = [];
        if (this.sentRevision !== dataRevision) {
            payload.data = this.prepared.data;
            payload.options = {
                maxZoom: Math.min(30, Math.ceil(this.zoomRange.max)),
                minZoom: Math.max(0, Math.floor(this.zoomRange.min)),
                radiusPx: this.options.clusterRadiusPx || CLUSTER_DEFAULTS.radiusPx
            };
            transfer.push(payload.data.coordinates.buffer);
            this.sentRevision = dataRevision;
        }
        return this.client.request('compute', payload, { dataRevision, viewRevision: target.viewRevision }, transfer);
    }

    async _receive(result, target) {
        try {
            if (result.skipped || this.destroyed || target.dataRevision !== this.dataRevision
                || this._resolveZoom(Number(this.map.getZoom()), this.snapshot?.logicalZoom) === null) return;
            const nodes = result.nodes.map((node) => ({ ...node, dataRevision: result.dataRevision,
                place: node.kind === 'place' ? target.byKey.get(node.key) : undefined }));
            const nativeNodes = nodes.map(nativeNode);
            const signature = nodesSignature(nativeNodes);
            const frameRevision = this.frameRevision;
            const frameChanged = frameRevision !== this.appliedFrameRevision;
            if (signature !== this.sentSignature || frameChanged || this.needsBridgeSync) {
                const policy = getMotionPolicy();
                const animate = policy.clusterMotion && policy.pageVisible && result.plan.kind !== 'initial'
                    && !frameChanged && !this.needsBridgeSync;
                const prevKeys = this.needsBridgeSync ? new Set() : this.sentKeys;
                const response = await this.map.setNodes(nativeNodes, result.plan, { prevKeys, animate, selected: this.selectedKey });
                if (this.destroyed) return;
                if (response === null) {
                    // A lost reply can mean either the old or the new snapshot is on screen.
                    this.needsBridgeSync = true;
                    if (!target.retryBridge && this.pendingView?.viewRevision === target.viewRevision) {
                        this._commit(target.reason, target.payload.refining, true);
                    }
                    return;
                }
                this.needsBridgeSync = false;
                this.sentKeys = new Set(nativeNodes.map((node) => node.id));
                this.sentSignature = signature;
                this.appliedFrameRevision = frameRevision;
            }
            this.snapshot = { ...result, coverageBounds: target.coverageBounds, byKey: target.byKey,
                nodeByKey: new Map(nodes.map((node) => [node.key, node])) };
            this.client.acknowledge(result.snapshotId);
        } finally {
            if (this.pendingView?.viewRevision === target.viewRevision) {
                this.pendingView = null;
                // The camera can cross a refinement point while the bridge is applying this snapshot.
                if (this.cameraMoving && Number(this.map.getZoom()) !== target.payload.zoom) this._onMapMove();
            }
        }
    }

    _computeError(error, target) {
        if (this.pendingView?.viewRevision === target.viewRevision) this.pendingView = null;
        if (this.destroyed || error.name === 'AbortError') return;
        if (!this.localCompute) {
            this.client?.destroy();
            this.client = null;
            this.localCompute = true;
            this.prepared = null;
            this.sentRevision = null;
            this._commit(target.reason);
        } else {
            console.warn('Native map marker computation failed', error);
        }
    }

    _resolveZoom(zoom, previousZoom, viewZoom = this.options.getMarkerViewZoom?.(zoom)) {
        const range = { minZoom: this.zoomRange.min, maxZoom: this.zoomRange.max };
        return resolveMarkerZoom(zoom, previousZoom, range, this.markerBand,
            Number.isFinite(viewZoom) ? () => viewZoom : undefined);
    }

    setSelectedKey(key) {
        const next = key || null;
        if (next === this.selectedKey) return;
        this.selectedKey = next;
        if (this.pendingView || this.snapshot?.nodeByKey.get(next)?.sourceCoordinate) {
            this._commit('selection', this.pendingView?.payload.refining);
        }
        this.map.setSelectedPlace(next);
    }

    /** 皮肤、主题变化后重新下发样式（不重发节点） */
    refreshAppearance() {
        if (this.destroyed) return;
        const style = buildNativeMarkerStyle();
        const key = JSON.stringify(style);
        if (key === this.styleKey) return;
        this.styleKey = key;
        this.map.setMarkerStyle(style);
    }

    _scheduleStyle() {
        window.clearTimeout(this.styleTimer);
        this.styleTimer = window.setTimeout(() => this.refreshAppearance(), 50);
    }

    setNativeGlassVisible() { }

    getZoomState() {
        return { logicalZoom: this.snapshot?.logicalZoom, minZoom: this.zoomRange.min, maxZoom: this.zoomRange.max };
    }

    _snapshotFor(dataRevision) {
        if (!this.snapshot || dataRevision !== this.snapshot.dataRevision) {
            throw Object.assign(new Error('Map data changed'), { code: 'STALE_DATA' });
        }
        return this.snapshot;
    }

    async getClusterInfo(nodeKey, dataRevision = this.snapshot?.dataRevision) {
        this._snapshotFor(dataRevision);
        return this.client.request('clusterInfo', { nodeKey }, { dataRevision });
    }

    async getClusterMembers(nodeKey, dataRevision = this.snapshot?.dataRevision) {
        const snapshot = this._snapshotFor(dataRevision);
        const { keys } = await this.client.request('members', { nodeKey }, { dataRevision });
        return keys.map((key) => snapshot.byKey.get(key)).filter(Boolean);
    }

    async getPlaceRevealZoom(place, baseZoom, maxZoom, dataRevision = this.snapshot?.dataRevision) {
        if (!this.snapshot) return Math.min(baseZoom, maxZoom);
        this._snapshotFor(dataRevision);
        const { zoom } = await this.client.request('reveal', { place, baseZoom, maxZoom }, { dataRevision });
        return zoom;
    }

    getDataBounds() {
        return this.snapshot?.dataBounds || null;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.prepareAbort?.abort();
        this.scheduler.destroy();
        this.client?.destroy();
        window.clearTimeout(this.styleTimer);
        window.removeEventListener('themechange', this._onTheme);
        this.themeObserver?.disconnect();
        this.map.off('movestart', this._onMoveStart);
        this.map.off('mapmove', this._onMapMove);
        this.map.off('moveend', this._onMoveEnd);
        this.map.off('markerTap', this._onMarkerTap);
        this.map.off('clusterTap', this._onClusterTap);
        this.map.off('framechange', this._onFrameChange);
    }
}
