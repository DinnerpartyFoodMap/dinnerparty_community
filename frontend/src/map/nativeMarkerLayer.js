// iOS 原生底图的标记层：与 MarkerLayerController 同一个入口（update / setSelectedKey / refreshAppearance / destroy），
// 同一套聚合与转场规则，只是不在网页里画东西。
//
// - 聚合：网页的聚合引擎（cluster/engine.js，Supercluster）与快照、转场计划（snapshot.js、transitions.js）原样复用；
//   按当前缩放取一份快照，与上一份比出计划，连同节点一起交给原生（setNodes）。相机移动中（捏合、松手后的减速、动画）
//   每次 mapmove 都检查：聚合层级变了或视野出了缓冲区就立即提交，不等 MapKit 在减速结束后才发的 moveend。
// - 显示：节点（单点或聚合）是 MapKit 的标注视图，拖动缩放时与底图同帧移动；合并 / 拆分动画由原生按计划用 Core Animation
//   播放，节奏与网页的 MARKER_TIMING 相同。网页只在聚合层级变化、视野出缓冲区、数据变化时发一次，不逐帧参与。
// - 点按：单点回传 markerTap（打开卡片），聚合回传 clusterTap，交给 MapView 的 handleClusterClick（与网页相同的展开逻辑）。
import { ClusterEngine, normalizePlaces, dataSignature, CLUSTER_DEFAULTS } from './cluster/engine.js';
import { buildSnapshot, resolveMarkerZoom, boundsContains, shouldRefineMarkerAnchors, stabilizeMarkerAnchors } from './cluster/snapshot.js';
import { planTransition } from './cluster/transitions.js';
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

export class NativeMarkerLayer {
    /**
     * @param {import('./nativeMapView.js').NativeMapView} map
     * @param {{ getMarkerViewZoom?: (zoom: number) => number,
     *           onPlaceClick?: (place: object, node: object) => void,
     *           onClusterClick?: (node: object, engine: ClusterEngine) => void,
     *           clusterRadiusPx?: number }} options
     */
    constructor(map, options = {}) {
        this.map = map;
        this.options = options;
        this.zoomRange = getMapZoomRange(map);
        this.engine = null;
        this.snapshot = null;
        this.logicalZoom = undefined;
        this.queryMode = 'nearby';
        this.markerBand = null;
        this.selectedKey = null;
        this.sentKeys = new Set();
        this.sentSignature = '';
        this.version = 0;
        this.cameraMoving = false;
        this.pendingData = false;
        this.styleKey = '';
        this.styleTimer = 0;
        this.destroyed = false;

        this._onMoveStart = () => {
            if (!this.cameraMoving) this.cameraStartZoom = Number(this.map.getZoom());
            this.cameraMoving = true;
        };
        // 移动中：聚合层级变了（捏合、减速、点聚合后的放大动画）或视野出了缓冲区，立即换节点
        this._onMapMove = () => {
            if (this.destroyed || !this.engine || !this.snapshot) return;
            const zoom = Number(this.map.getZoom());
            const logical = this._resolveZoom(zoom);
            if (logical === null) return;
            const viewBounds = readViewBounds(this.map);
            const refining = this.cameraMoving && this.snapshot.engine === this.engine
                && shouldRefineMarkerAnchors(this.snapshot, zoom, this.cameraStartZoom);
            if (refining || logical !== this.logicalZoom || (viewBounds && !boundsContains(this.snapshot.coverageBounds, viewBounds))) {
                this._commit('live', refining);
            }
        };
        this._onMoveEnd = () => {
            this.cameraMoving = false;
            this.pendingData = false;
            this._commit('camera');
        };
        this._onMarkerTap = ({ id }) => {
            const node = this.snapshot?.nodeByKey.get(id);
            const place = this.snapshot?.engine?.placeByKey.get(id);
            if (place) this.options.onPlaceClick?.(place, node);
        };
        this._onClusterTap = ({ id }) => {
            const node = this.snapshot?.nodeByKey.get(id);
            if (node?.kind === 'cluster') this.options.onClusterClick?.(node, this.snapshot.engine);
        };
        // 校准结果变了：同一份节点按新坐标重发（不播放转场）
        this._onFrameChange = () => this._commit('frames');
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
        const normalized = normalizePlaces(places);
        const signature = dataSignature(normalized);
        if (!this.engine || this.engine.signature !== signature) {
            this.engine = new ClusterEngine(normalized, {
                maxZoom: Math.min(30, Math.ceil(this.zoomRange.max)),
                minZoom: Math.max(0, Math.floor(this.zoomRange.min)),
                radiusPx: this.options.clusterRadiusPx || CLUSTER_DEFAULTS.radiusPx
            });
        } else {
            this.engine.updatePlaces(normalized);
        }
        this.queryMode = queryMode;
        this.markerBand = markerBand;
        this._commit('data');
    }

    _commit(reason, refining = false) {
        if (this.destroyed || !this.engine) return;
        // 数据变化等相机静止后一起提交；移动中只按聚合层级与缓冲区换节点（live）
        if (this.cameraMoving && reason === 'data') {
            this.pendingData = true;
            return;
        }
        const viewBounds = readViewBounds(this.map);
        if (!viewBounds) return;
        const zoom = Number(this.map.getZoom());
        const logicalZoom = this._resolveZoom(zoom);
        if (logicalZoom === null) return;
        this.logicalZoom = logicalZoom;
        const next = buildSnapshot(this.engine, {
            viewBounds,
            logicalZoom,
            queryMode: this.queryMode,
            markerBand: this.markerBand,
            bufferRatio: NATIVE_BUFFER_RATIO,
            transitionVersion: ++this.version
        });
        const plan = planTransition(this.snapshot, next);
        stabilizeMarkerAnchors(this.snapshot, next, plan, { zoom, refining, selectedKey: this.selectedKey });
        this.snapshot = next;
        const nodes = next.visibleNodes.map(nativeNode);
        const signature = nodesSignature(nodes);
        // 平移后节点没变（仍在缓冲区内）：不用再发
        if (signature === this.sentSignature && reason !== 'frames') return;
        const policy = getMotionPolicy();
        const animate = policy.clusterMotion && policy.pageVisible && plan.kind !== 'initial' && reason !== 'frames';
        const prevKeys = this.sentKeys;
        this.sentKeys = new Set(nodes.map((node) => node.id));
        this.sentSignature = signature;
        this.map.setNodes(nodes, plan, { prevKeys, animate, selected: this.selectedKey });
    }

    _resolveZoom(zoom) {
        return resolveMarkerZoom(zoom, this.logicalZoom, { minZoom: this.engine.minZoom, maxZoom: this.engine.maxZoom },
            this.markerBand, this.options.getMarkerViewZoom);
    }

    setSelectedKey(key) {
        const next = key || null;
        if (next === this.selectedKey) return;
        this.selectedKey = next;
        if (this.snapshot?.nodeByKey.get(next)?.sourceCoordinate) {
            this._commit('selection');
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

    getEngine() {
        return this.engine;
    }

    /** 搜索结果自动适配视野时使用（同 MarkerLayerController） */
    getDataBounds() {
        if (!this.engine || !this.engine.size) return null;
        let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
        for (const place of this.engine.placeByKey.values()) {
            const lng = Number(place.longitude), lat = Number(place.latitude);
            minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
        return { minLng, minLat, maxLng, maxLat };
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
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
