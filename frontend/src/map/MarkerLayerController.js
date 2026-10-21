// 地图标记层控制器：所有数据入口（附近、搜索、沿途、增删改、外观更新）都收敛到 update()，
// 由这里决定索引、快照、持久覆盖物和转场时序。React 只提交目标数据，不逐帧参与标记定位。
//
// 时序规则：
// - 缩放结束后立即基于已缓存数据提交完整目标快照并播放吸附；捏合过程中既有节点正常跟随地图。
// - zoomstart / movestart / 页面隐藏 / 销毁时终止转场并收敛到目标快照，手势始终优先。
// - 每个转场有版本号，过期的完成回调不会回收新节点。
// - 单点标记的名称总是显示（不做碰撞避让）；转场期间先隐藏，相机静止、转场结束后统一显示。

import { ClusterEngine, normalizePlaces, dataSignature, CLUSTER_DEFAULTS } from './cluster/engine.js';
import { buildSnapshot, computeLogicalZoom } from './cluster/snapshot.js';
import { planTransition } from './cluster/transitions.js';
import {
    createMarkerParts, applyNodeAppearance, glyphSize
} from './markerContent.js';
import { readViewBounds, getMapZoomRange, projectToContainer } from './viewport.js';
import { getMotionPolicy, startFrameProbe } from '../motion/policy.js';

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
// AMap 每添加或移动一个 DOM 标记都有同步布局开销（中端设备约 1ms/个）：
// 可见范围内的节点同步挂载，缓冲区内的节点按每帧预算分批挂载，避免一次提交形成长任务。
const ATTACH_BUDGET_MS = 6;
const Z_INDEX = Object.freeze({ ghost: 100, place: 110, cluster: 120, selected: 400 });
const EASE_OUT = 'cubic-bezier(0.22, 0.8, 0.25, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';
const ONSCREEN_MARGIN = 80;
// 双指手势结束后这段时间内的标记点按不生效
const MULTI_TOUCH_TAP_GUARD_MS = 350;

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

export class MarkerLayerController {
    /**
     * @param {object} map AMap.Map
     * @param {{
     *   onPlaceClick?: (place: object, node: object) => void,
     *   onClusterClick?: (node: object, engine: ClusterEngine) => void,
     *   clusterRadiusPx?: number
     * }} options
     */
    constructor(map, options = {}) {
        this.map = map;
        this.AMap = window.AMap;
        this.options = options;
        this.zoomRange = getMapZoomRange(map);
        this.engine = null;
        this.queryMode = 'nearby';
        this.snapshot = null;
        this.logicalZoom = undefined;
        this.entries = new Map();
        this.selectedKey = null;
        this.version = 0;
        this.txns = new Set();
        this.cameraMoving = false;
        this.destroyed = false;
        this.commitRaf = 0;
        this.labelRaf = 0;
        this.labelVisible = new Set();
        this.pendingAttach = new Set();
        this.attachHandle = 0;
        this.metrics = { indexBuilds: [], commits: [], frames: [], domCount: 0 };
        // 双指缩放时一根手指可能落在标记上：松手时不能当作点按（否则会展开聚合或打开地点卡片，地图跳到别处）
        this.multiTouch = false;
        this.multiTouchEndedAt = -Infinity;
        this._onTouch = (event) => {
            const count = event.touches ? event.touches.length : 0;
            if (count > 1) {
                this.multiTouch = true;
            } else if (count === 0 && this.multiTouch) {
                this.multiTouch = false;
                this.multiTouchEndedAt = performance.now();
            }
        };
        this.touchTarget = map.getContainer?.() || null;
        if (this.touchTarget) {
            // 捕获阶段：先于高德在同一次 touchend 里判定点按
            for (const type of ['touchstart', 'touchend', 'touchcancel']) {
                this.touchTarget.addEventListener(type, this._onTouch, { capture: true, passive: true });
            }
        }

        this._onMoveStart = () => {
            this.cameraMoving = true;
            this._finishAll();
        };
        this._onMoveEnd = () => {
            this.cameraMoving = false;
            this._scheduleCommit('camera');
        };
        this._onResize = () => this._scheduleCommit('resize');
        this._onVisibility = () => {
            if (document.visibilityState === 'hidden') this._finishAll();
            else this._scheduleCommit('resume');
        };
        for (const type of ['movestart', 'zoomstart', 'dragstart']) map.on(type, this._onMoveStart);
        for (const type of ['moveend', 'zoomend']) map.on(type, this._onMoveEnd);
        map.on('resize', this._onResize);
        document.addEventListener('visibilitychange', this._onVisibility);
        // 开发环境，或在设备上设置 localStorage['debug.mapMetrics'] = '1' 时暴露控制器，便于记录性能数据
        if (typeof window !== 'undefined' && (import.meta.env?.DEV || readDebugFlag())) window.__foodMapMarkers = this;
    }

    // ---------------- 数据入口 ----------------

    /**
     * 单一更新入口。places 为当前模式下应参与聚合的完整列表。
     * 只有 key、坐标或参与聚类的集合变化才重建索引；名称、分类等变化只刷新外观。
     */
    update({ places = [], queryMode = 'nearby' } = {}) {
        if (this.destroyed) return;
        const normalized = normalizePlaces(places);
        const signature = dataSignature(normalized);
        if (!this.engine || this.engine.signature !== signature) {
            const started = performance.now();
            this.engine = new ClusterEngine(normalized, {
                maxZoom: Math.min(30, Math.ceil(this.zoomRange.max)),
                minZoom: Math.max(0, Math.floor(this.zoomRange.min)),
                radiusPx: this.options.clusterRadiusPx || CLUSTER_DEFAULTS.radiusPx
            });
            this._pushMetric('indexBuilds', { size: normalized.length, ms: performance.now() - started });
        } else {
            this.engine.updatePlaces(normalized);
        }
        this.queryMode = queryMode;
        this._commit('data');
    }

    setSelectedKey(key) {
        if (this.selectedKey === key) return;
        const previous = this.selectedKey;
        this.selectedKey = key || null;
        for (const k of [previous, this.selectedKey]) {
            const entry = k ? this.entries.get(k) : null;
            if (entry && !entry.ghost) this._refreshAppearance(entry);
        }
        this._scheduleLabels();
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
        return this.engine;
    }

    /** 搜索结果自动适配视野时使用。 */
    getDataBounds() {
        if (!this.engine || !this.engine.size) return null;
        let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
        for (const place of this.engine.placeByKey.values()) {
            const lng = Number(place.longitude);
            const lat = Number(place.latitude);
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        return { minLng, minLat, maxLng, maxLat };
    }

    destroy() {
        if (this.destroyed) return;
        this._finishAll();
        this.destroyed = true;
        if (this.commitRaf) cancelAnimationFrame(this.commitRaf);
        if (this.labelRaf) cancelAnimationFrame(this.labelRaf);
        const map = this.map;
        try {
            for (const type of ['movestart', 'zoomstart', 'dragstart']) map.off(type, this._onMoveStart);
            for (const type of ['moveend', 'zoomend']) map.off(type, this._onMoveEnd);
            map.off('resize', this._onResize);
        } catch (e) { /* ignore */ }
        document.removeEventListener('visibilitychange', this._onVisibility);
        if (this.touchTarget) {
            for (const type of ['touchstart', 'touchend', 'touchcancel']) {
                this.touchTarget.removeEventListener(type, this._onTouch, { capture: true });
            }
            this.touchTarget = null;
        }
        this._cancelAttach();
        const markers = Array.from(this.entries.values()).filter((entry) => entry.attached).map((entry) => entry.marker);
        this._removeMarkers(markers);
        this.entries.clear();
        this.pendingAttach.clear();
        if (typeof window !== 'undefined' && window.__foodMapMarkers === this) delete window.__foodMapMarkers;
    }

    // ---------------- 快照提交 ----------------

    _scheduleCommit(reason) {
        if (this.destroyed || this.commitRaf) return;
        this.commitRaf = requestAnimationFrame(() => {
            this.commitRaf = 0;
            if (!this.cameraMoving) this._commit(reason);
        });
    }

    _commit(reason) {
        if (this.destroyed || !this.engine) return;
        const viewBounds = readViewBounds(this.map);
        if (!viewBounds) return;
        const started = performance.now();
        const zoom = Number(this.map.getZoom());
        this.logicalZoom = computeLogicalZoom(zoom, this.logicalZoom, {
            minZoom: this.engine.minZoom,
            maxZoom: this.engine.maxZoom
        });
        const next = buildSnapshot(this.engine, {
            viewBounds,
            logicalZoom: this.logicalZoom,
            queryMode: this.queryMode,
            transitionVersion: this.version + 1
        });
        const plan = planTransition(this.snapshot, next);
        this._apply(plan, next, reason);
        this._pushMetric('commits', { reason, kind: plan.kind, nodes: next.visibleNodes.length, ms: performance.now() - started });
    }

    _pushMetric(kind, value) {
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
        const entry = { key: node.key, node, marker, parts, ghost: false, size: null };
        marker.on('click', () => this._handleActivate(entry));
        parts.hit.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this._handleActivate(entry);
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
        setMarkerZ(entry.marker, selected ? Z_INDEX.selected : base);
    }

    _handleActivate(entry) {
        if (this.destroyed || entry.ghost) return;
        if (this.multiTouch || performance.now() - this.multiTouchEndedAt < MULTI_TOUCH_TAP_GUARD_MS) return;
        const node = entry.node;
        if (node.kind === 'place') this.options.onPlaceClick?.(node.place, node);
        else this.options.onClusterClick?.(node, this.engine);
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
    _takeOver(entry) {
        if (!entry.anims || !entry.anims.size) return null;
        const visual = { travel: this._readVisual(entry.parts.travel), glyph: this._readVisual(entry.parts.glyph) };
        for (const anim of Array.from(entry.anims)) {
            try { anim.cancel(); } catch (e) { /* ignore */ }
        }
        entry.anims.clear();
        return visual;
    }

    _apply(plan, next, reason) {
        const policy = getMotionPolicy();
        // 相机驱动的提交发生在手势结束后，旧转场已在 movestart/zoomstart 时收敛；
        // 数据驱动的提交（相机静止时）不打断仍在进行的转场，变化的节点从当前可视位置接续。
        if (reason === 'camera' || reason === 'resize' || reason === 'resume' || !policy.clusterMotion || !policy.pageVisible) {
            this._finishAll();
        }
        const version = ++this.version;
        const animate = policy.clusterMotion && policy.pageVisible && !this.cameraMoving
            && plan.kind !== 'initial' && reason !== 'resume';
        const reduced = policy.reducedMotion;
        const degraded = policy.degradeLevel > 0;
        const size = this._containerSize();
        const projCache = new Map();
        const project = (coordinate) => {
            const id = `${coordinate[0]},${coordinate[1]}`;
            if (!projCache.has(id)) projCache.set(id, projectToContainer(this.map, coordinate));
            return projCache.get(id);
        };
        const onscreen = (p) => !!p && p.x > -ONSCREEN_MARGIN && p.y > -ONSCREEN_MARGIN
            && p.x < size.width + ONSCREEN_MARGIN && p.y < size.height + ONSCREEN_MARGIN;

        const oldEntries = this.entries;
        const nextEntries = new Map();
        const prevEntryByKey = new Map(oldEntries);
        const animations = [];
        const created = [];
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
        for (const node of next.visibleNodes) {
            const fromKey = plan.reuse.get(node.key);
            let entry = fromKey ? oldEntries.get(fromKey) : null;
            if (entry) {
                oldEntries.delete(fromKey);
                const previousNode = entry.node;
                entry.key = node.key;
                entry.node = node;
                const moved = !sameCoordinate(previousNode.coordinate, node.coordinate);
                const recounted = previousNode.count !== node.count;
                if (moved || recounted) {
                    const visual = this._takeOver(entry);
                    let offset = { x: 0, y: 0 };
                    if (moved) {
                        const from = animate ? project(previousNode.coordinate) : null;
                        entry.marker.setPosition(node.coordinate);
                        const to = animate ? project(node.coordinate) : null;
                        if (from && to && (onscreen(from) || onscreen(to)) && !reduced) offset = { x: from.x - to.x, y: from.y - to.y };
                    }
                    if (animate) settle(entry, visual, offset);
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
                        this.pendingAttach.delete(entry);
                        entry.attached = true;
                        created.push(entry.marker);
                    }
                }
                continue;
            }

            entry = this._createEntry(node);
            nextEntries.set(node.key, entry);
            const own = project(node.coordinate);
            if (own && onscreen(own)) {
                entry.attached = true;
                created.push(entry.marker);
            } else {
                // 缓冲区内的节点稍后分批挂载
                entry.attached = false;
                this.pendingAttach.add(entry);
                continue;
            }
            if (!animate) continue;
            const parentKey = plan.splitFrom.get(node.key);
            const parentEntry = parentKey ? prevEntryByKey.get(parentKey) : null;
            const parentNode = parentEntry ? parentEntry.node : null;
            let parentPoint = parentNode ? project(parentNode.coordinate) : null;
            if (parentPoint && parentEntry.anims && parentEntry.anims.size) {
                // 父节点仍在移动：从它当前的可视位置出发
                const v = this._readVisual(parentEntry.parts.travel);
                parentPoint = { x: parentPoint.x + v.tx, y: parentPoint.y + v.ty };
            }

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
            } else if (plan.mergeTargets.has(node.key) && !reduced && onscreen(own)) {
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
        }

        // ---- 退出节点：残影只做视觉过渡，不可点击 ----
        const ghosts = [];
        const toRemove = [];
        const ghostLimit = degraded ? LIMITS.degradedGhosts : LIMITS.ghosts;
        const existingGhosts = this._ghostCount();
        for (const [key, entry] of oldEntries) {
            const own = animate ? project(entry.node.coordinate) : null;
            const visual = this._takeOver(entry);
            if (!entry.attached) {
                this.pendingAttach.delete(entry);
                continue;
            }
            if (!animate || !own || !onscreen(own) || ghosts.length + existingGhosts >= ghostLimit) {
                toRemove.push(entry.marker);
                continue;
            }
            const startTravel = visual ? visual.travel : { tx: 0, ty: 0, opacity: 1 };
            const startGlyph = visual ? visual.glyph : { scale: 1, opacity: 1 };
            entry.ghost = true;
            entry.parts.root.dataset.ghost = '';
            entry.parts.label.dataset.hidden = '';
            setMarkerZ(entry.marker, Z_INDEX.ghost);
            ghosts.push(entry);
            const targetKey = plan.mergeInto.get(key);
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
            } else if (plan.splitSources.has(key) && !reduced) {
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
        }

        this._removeMarkers(toRemove);
        this._addMarkers(created);
        this._scheduleAttach();
        this.entries = nextEntries;
        this.snapshot = next;
        this.metrics.domCount = nextEntries.size + ghosts.length + existingGhosts;

        // 新增的单点在转场后段才显示名称：先隐藏，转场结束时统一布局
        if (animations.length) {
            for (const entry of nextEntries.values()) {
                if (!this.labelVisible.has(entry.key)) entry.parts.label.dataset.hidden = '';
            }
        }

        const txn = { version, animations, ghosts, done: false, probe: animations.length ? startFrameProbe() : null };
        this.txns.add(txn);
        if (!animations.length) {
            this._completeTransaction(txn);
            return;
        }
        Promise.all(animations.map((anim) => anim.finished.catch(() => null))).then(() => this._completeTransaction(txn));
    }

    _scheduleAttach() {
        if (this.destroyed || this.attachHandle || !this.pendingAttach.size) return;
        const run = (deadline) => {
            this.attachHandle = 0;
            this._flushAttach(deadline);
        };
        if (typeof window.requestIdleCallback === 'function') {
            this.attachHandle = { idle: window.requestIdleCallback(run, { timeout: 250 }) };
        } else {
            this.attachHandle = { timer: setTimeout(() => run(null), 32) };
        }
    }

    _cancelAttach() {
        const handle = this.attachHandle;
        this.attachHandle = 0;
        if (!handle) return;
        if (handle.idle && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle.idle);
        if (handle.timer) clearTimeout(handle.timer);
    }

    _flushAttach(deadline) {
        if (this.destroyed) return;
        // 转场进行中或相机移动时让出主线程
        if (this.txns.size || this.cameraMoving) {
            this._scheduleAttach();
            return;
        }
        const started = performance.now();
        const budget = deadline && typeof deadline.timeRemaining === 'function'
            ? Math.min(ATTACH_BUDGET_MS, Math.max(1, deadline.timeRemaining()))
            : ATTACH_BUDGET_MS;
        let attachedAny = false;
        let batch = [];
        const flush = () => {
            if (!batch.length) return;
            this._addMarkers(batch.map((entry) => entry.marker));
            batch.forEach((entry) => { entry.attached = true; });
            batch = [];
            attachedAny = true;
        };
        for (const entry of Array.from(this.pendingAttach)) {
            this.pendingAttach.delete(entry);
            if (this.entries.get(entry.key) !== entry || entry.attached) continue;
            batch.push(entry);
            // 每次 add 有固定开销，小批量提交；超出本帧预算后让出
            if (batch.length >= 4) {
                flush();
                if (performance.now() - started > budget) break;
            }
        }
        flush();
        if (this.pendingAttach.size) this._scheduleAttach();
        else if (attachedAny) this._scheduleLabels();
    }

    _ghostCount() {
        let count = 0;
        for (const txn of this.txns) if (!txn.done) count += txn.ghosts.length;
        return count;
    }

    _completeTransaction(txn) {
        if (txn.done) return;
        txn.done = true;
        this.txns.delete(txn);
        if (txn.probe) this._pushMetric('frames', txn.probe());
        if (txn.ghosts.length) this._removeMarkers(txn.ghosts.map((entry) => entry.marker));
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
            if (entry.anims) entry.anims.clear();
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
