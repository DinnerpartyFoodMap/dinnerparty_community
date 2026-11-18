// 聚合相关的缩放决定（纯函数，测试见 tests/unit/map/test-cluster-zoom.mjs）：
// - standaloneZoom / revealZoom：列表、随机等处打开一个地点时放大到它不再被聚合、能单独显示的层级；
// - clusterZoomOutcome：点聚合后的放大结束时，聚合拆开了没有、要不要再放大一次、还是相机已放不大（打开成员列表）。
import { createEngine, placeKey } from './cluster/engine.js';

// 相机停下的缩放与目标相差不到这么多算到了；两次放大之间超过这么多算有进展
export const CLUSTER_ZOOM_EPSILON = 0.05;
// 点聚合的放大最多补几次（动画被打断时）
export const CLUSTER_ZOOM_MAX_RETRIES = 2;

// 地点坐标附近的查询范围（度，约 1 米）：只用来找地点自己的单点节点
const REVEAL_EPSILON = 1e-5;

/**
 * 地点从哪一级起单独显示（不在任何聚合里），从 fromZoom 往上找；到引擎的最大层级仍被聚合（坐标重合或过近）时返回 null。
 * engine 里没有这个地点时返回 null。
 */
export function standaloneZoom(engine, place, fromZoom = 0) {
    const key = placeKey(place);
    if (!engine || !key || !engine.placeByKey.has(key)) return null;
    const lng = Number(place.longitude);
    const lat = Number(place.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const bbox = [lng - REVEAL_EPSILON, lat - REVEAL_EPSILON, lng + REVEAL_EPSILON, lat + REVEAL_EPSILON];
    const start = Math.max(engine.minZoom, Math.ceil(Number.isFinite(fromZoom) ? fromZoom : 0));
    for (let zoom = start; zoom <= engine.maxZoom; zoom++) {
        if (engine.query(bbox, zoom).some((node) => node.key === key)) return zoom;
    }
    return null;
}

/**
 * 打开地点时的缩放：至少 baseZoom，地点在 baseZoom 仍被聚合时放大到它单独显示的层级（取整数，与聚合层级一致），
 * 不超过 maxZoom。地点还不在标记层的数据里（筛选掉了、标记快照还没有它）时，按“现有地点 + 它”算——
 * 选中的地点总会加进标记层。到最大缩放仍分不开（坐标重合）时保持 baseZoom，放大也没有用。
 */
export function revealZoom({ engine, place, baseZoom, maxZoom }) {
    const base = Number.isFinite(baseZoom) ? baseZoom : 16;
    const max = Number.isFinite(maxZoom) ? maxZoom : 20;
    const key = placeKey(place);
    if (!key) return Math.min(base, max);
    let index = engine;
    if (!index || !index.placeByKey.has(key)) {
        const others = index ? Array.from(index.placeByKey.values()) : [];
        index = createEngine([...others, place], index ? index.options : undefined);
    }
    const zoom = standaloneZoom(index, place, base);
    if (zoom == null) return Math.min(base, max);
    return Math.min(max, Math.max(base, zoom));
}

/**
 * 点聚合后的一次放大结束（或一直没动）时怎么做：
 * - 'done'：聚合已拆开（聚合层级到了展开层级），或相机到了目标缩放；
 * - 'retry'：相机动了但没到（动画被浏览器补发的事件、底图收尾打断）：第一次总是再放大，之后要有进展才再放大；
 * - 'members'：相机已放不大（原生底图在部分地区到不了目标层级，放大请求没让相机动起来，或补了几次都没进展），
 *   聚合仍在：打开成员列表。
 * logicalZoom 是标记层按这次停下的缩放会用的聚合层级（computeLogicalZoom，含滞回）；moved 为这次放大期间相机是否动过。
 */
export function clusterZoomOutcome({ zoom, logicalZoom, expansion, targetZoom, previousZoom, attempts, moved = true, maxRetries = CLUSTER_ZOOM_MAX_RETRIES }) {
    if (!Number.isFinite(zoom)) return 'done';
    if (Number.isFinite(logicalZoom) && Number.isFinite(expansion) && logicalZoom >= expansion) return 'done';
    if (zoom >= targetZoom - CLUSTER_ZOOM_EPSILON) return 'done';
    if (!moved) return 'members';
    const progressed = Number.isFinite(previousZoom) && zoom > previousZoom + CLUSTER_ZOOM_EPSILON;
    if (attempts < maxRetries && (attempts === 0 || progressed)) return 'retry';
    return 'members';
}
