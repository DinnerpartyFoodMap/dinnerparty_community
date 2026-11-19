// 聚类快照：某一时刻（数据代 + 逻辑缩放 + 覆盖范围）应当显示的完整节点集合。
// 快照一次性提交给标记层；动画只是在两份快照之间过渡，不会产生“半份”状态。

export const DEFAULT_HYSTERESIS = 0.15;

/**
 * 地图可以停在任意小数缩放，但聚类拓扑只按整数逻辑缩放切换。
 * 取最近整数，并在 ±0.5 的边界外再加一段滞回，避免停在 x.5 附近时来回切换；
 * 滞回只影响聚类层级，不改变底图缩放本身。
 */
export function computeLogicalZoom(zoom, previous, { hysteresis = DEFAULT_HYSTERESIS, minZoom = 0, maxZoom = 30 } = {}) {
    if (!Number.isFinite(zoom)) return Number.isFinite(previous) ? previous : minZoom;
    const clamp = (z) => Math.max(minZoom, Math.min(maxZoom, z));
    const nearest = clamp(Math.round(zoom));
    if (!Number.isFinite(previous)) return nearest;
    if (nearest === previous) return previous;
    return Math.abs(zoom - previous) > 0.5 + hysteresis ? nearest : previous;
}

/** 跨瓦片级别时保留上一份快照，等新级别的数据和缩放一起提交。 */
export function resolveMarkerZoom(zoom, previousZoom, range, markerBand, getViewZoom) {
    const logicalZoom = computeLogicalZoom(zoom, previousZoom, range);
    if (!markerBand) return logicalZoom;
    const min = markerBand.minZoom;
    const max = markerBand.maxZoom ?? Infinity;
    // 原生在手势中更新聚类，判断是否换瓦片时仍与数据源共用停下时的滞回基准。
    const viewZoom = getViewZoom ? getViewZoom(zoom) : logicalZoom;
    if (viewZoom < min || viewZoom > max) return null;
    return Math.max(min, Math.min(max, logicalZoom));
}

/** 按比例向四周扩展范围（经纬度），用于给可见节点留出缓冲区。 */
export function expandBounds(bounds, ratio) {
    const lngSpan = bounds.maxLng - bounds.minLng;
    const latSpan = bounds.maxLat - bounds.minLat;
    return {
        minLng: Math.max(-180, bounds.minLng - lngSpan * ratio),
        maxLng: Math.min(180, bounds.maxLng + lngSpan * ratio),
        minLat: Math.max(-85.0511, bounds.minLat - latSpan * ratio),
        maxLat: Math.min(85.0511, bounds.maxLat + latSpan * ratio)
    };
}

/**
 * 把地图视野换算成真实经纬度：经度 [-180, 180]、纬度不超过 ±85.0511。
 * 地图缩得很小时世界横向重复，AMap 的 getBounds 会给出超过 ±180 的经度（如 -26 ~ 256），
 * 而后端和范围缓存只认真实经纬度。先把整个视野平移到中心落在 [-180, 180]，仍跨越 ±180 经线时取整条经度带。
 */
export function normalizeViewBounds(bounds) {
    if (!bounds || ![bounds.minLng, bounds.maxLng, bounds.minLat, bounds.maxLat].every(Number.isFinite)) return null;
    const shift = Math.round((bounds.minLng + bounds.maxLng) / 720) * 360;
    let minLng = bounds.minLng - shift;
    let maxLng = bounds.maxLng - shift;
    if (minLng < -180 || maxLng > 180) {
        minLng = -180;
        maxLng = 180;
    }
    return {
        minLng,
        maxLng,
        minLat: Math.max(-85.0511, bounds.minLat),
        maxLat: Math.min(85.0511, bounds.maxLat)
    };
}

export function boundsContains(outer, inner) {
    return !!outer && !!inner
        && inner.minLng >= outer.minLng && inner.maxLng <= outer.maxLng
        && inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat;
}

export function boundsIntersect(a, b) {
    return !!a && !!b && a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

export function pointInBounds(bounds, lng, lat) {
    return !!bounds && lng >= bounds.minLng && lng <= bounds.maxLng && lat >= bounds.minLat && lat <= bounds.maxLat;
}

/**
 * @param {import('./engine.js').ClusterEngine | null} engine
 * @param {{ viewBounds: object, logicalZoom: number, queryMode: string, markerBand?: object|null, bufferRatio?: number, transitionVersion?: number }} input
 */
export function buildSnapshot(engine, { viewBounds, logicalZoom, queryMode, markerBand = null, bufferRatio = 0.35, transitionVersion = 0 }) {
    const coverageBounds = viewBounds ? expandBounds(viewBounds, bufferRatio) : null;
    const visibleNodes = engine && coverageBounds
        ? engine.query([coverageBounds.minLng, coverageBounds.minLat, coverageBounds.maxLng, coverageBounds.maxLat], logicalZoom)
        : [];
    const nodeByKey = new Map();
    for (const node of visibleNodes) nodeByKey.set(node.key, node);
    return {
        generation: engine ? engine.generation : 0,
        engine,
        queryMode,
        markerBand,
        logicalZoom,
        coverageBounds,
        visibleNodes,
        nodeByKey,
        transitionVersion
    };
}

function matchesCoordinate(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

export function shouldRefineMarkerAnchors(snapshot, zoom, startZoom) {
    return snapshot?.hasRefinableAnchors && zoom - startZoom >= DEFAULT_HYSTERESIS;
}

function markerPrecision(node, snapshot) {
    if (node.kind === 'place') return node.place?.aggregateCell?.[0] ?? Infinity;
    return snapshot.markerBand?.cell ?? Infinity;
}

/** 保留未拆合标记已显示的坐标。索引和地点数据仍使用瓦片原坐标。 */
export function stabilizeMarkerAnchors(prev, next, plan, { refining = false, selectedKey = null } = {}) {
    if (!prev || prev.queryMode !== next.queryMode) return;
    for (const [index, node] of next.visibleNodes.entries()) {
        const previous = prev.nodeByKey.get(plan.reuse.get(node.key));
        if (!previous) continue;
        const carried = previous.sourceCoordinate && matchesCoordinate(previous.sourceCoordinate, node.coordinate);
        if (!plan.keepAnchor.has(node.key) && !carried) continue;
        if (matchesCoordinate(previous.coordinate, node.coordinate)) continue;

        const anchorPrecision = previous.anchorPrecision ?? markerPrecision(previous, prev);
        const morePrecise = markerPrecision(node, next) > anchorPrecision;
        const detail = node.kind === 'place' && !node.place?.aggregate;
        // 后续继续放大时采用更细的坐标；选中地点时立即使用精确位置。
        if ((refining && morePrecise && carried && !plan.keepAnchor.has(node.key)) || (detail && selectedKey === node.key)) {
            plan.reanchor.add(node.key);
            continue;
        }
        const anchored = { ...node, coordinate: previous.coordinate, sourceCoordinate: node.coordinate, anchorPrecision };
        next.visibleNodes[index] = anchored;
        next.nodeByKey.set(node.key, anchored);
        if (morePrecise) next.hasRefinableAnchors = true;
    }
}

/** 构建 成员 key → 节点 key 的映射。只在需要跨代比对时按需构建，并受成员总数预算限制。 */
export function buildMemberToNode(snapshot, budget = 6000) {
    const map = new Map();
    let total = 0;
    for (const node of snapshot.visibleNodes) {
        total += node.count;
        if (total > budget) return null;
        const members = snapshot.engine ? snapshot.engine.memberKeys(node) : [node.key];
        for (const member of members) map.set(member, node.key);
    }
    return map;
}
