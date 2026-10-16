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
 * @param {{ viewBounds: object, logicalZoom: number, queryMode: string, bufferRatio?: number, transitionVersion?: number }} input
 */
export function buildSnapshot(engine, { viewBounds, logicalZoom, queryMode, bufferRatio = 0.35, transitionVersion = 0 }) {
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
        logicalZoom,
        coverageBounds,
        visibleNodes,
        nodeByKey,
        transitionVersion
    };
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
