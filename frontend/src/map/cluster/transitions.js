// 快照差分：决定两份聚类快照之间每个节点的去向。纯数据逻辑，不涉及 DOM 与动画时序。
//
// 同一索引代内使用真实树关系，跨代优先使用 key 和成员交集。
// 附近地图换瓦片档时，剩余节点可以按匿名粗格的覆盖范围过渡。

import { buildMemberToNode } from './snapshot.js';
import { tileOf, worldX, worldY } from '../markerTiles.js';

const DEFAULT_OPTIONS = { descendantBudget: 4000, memberBudget: 6000 };

function sameMembers(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function emptyPlan(kind) {
    return {
        kind,
        reuse: new Map(),        // nextKey -> prevKey：沿用同一图形（key 相同，或成员一致/一一对应的跨代节点）
        reanchor: new Set(),     // nextKey：换档只校正位置，直接落在新坐标
        splitFrom: new Map(),    // nextKey -> prevKey：从父聚合的位置出发，移动到自己的位置
        mergeInto: new Map(),    // prevKey -> nextKey：旧节点朝父聚合移动并收拢
        splitSources: new Set(), // prevKey：被拆开的父聚合，原地淡出
        mergeTargets: new Set(), // nextKey：汇合后出现的父聚合，接续出现并轻微回弹
        enter: [],               // nextKey：无对应来源，短渐变出现
        exit: []                 // prevKey：无对应去向，短渐变消失
    };
}

function finalize(plan, prev, next) {
    const usedPrev = new Set(plan.reuse.values());
    for (const key of plan.mergeInto.keys()) usedPrev.add(key);
    for (const key of plan.splitSources) usedPrev.add(key);
    for (const node of next.visibleNodes) {
        if (!plan.reuse.has(node.key) && !plan.splitFrom.has(node.key) && !plan.mergeTargets.has(node.key)) {
            plan.enter.push(node.key);
        }
    }
    if (prev) {
        for (const node of prev.visibleNodes) {
            if (!usedPrev.has(node.key)) plan.exit.push(node.key);
        }
    }
    return plan;
}

function reuseSameKeys(plan, prev, next) {
    for (const node of next.visibleNodes) {
        if (prev.nodeByKey.has(node.key)) plan.reuse.set(node.key, node.key);
    }
}

function planZoom(plan, prev, next, options) {
    const engine = next.engine;
    const usedPrev = new Set(plan.reuse.values());
    // 所有父节点共享一个访问预算；超出后其余节点短渐变
    const budget = { remaining: options.descendantBudget };
    if (next.logicalZoom > prev.logicalZoom) {
        // 放大：旧的父聚合拆开，子节点从父节点位置出发
        for (const parent of prev.visibleNodes) {
            if (parent.kind !== 'cluster' || usedPrev.has(parent.key)) continue;
            if (budget.remaining <= 0) break;
            const descendants = engine.descendantsAt(parent, next.logicalZoom, budget);
            if (!descendants) continue;
            const visible = descendants.filter((d) => next.nodeByKey.has(d.key) && !plan.reuse.has(d.key));
            if (!visible.length) continue;
            if (visible.length === 1 && visible[0].count === parent.count) {
                plan.reuse.set(visible[0].key, parent.key);
                usedPrev.add(parent.key);
                continue;
            }
            plan.splitSources.add(parent.key);
            for (const child of visible) plan.splitFrom.set(child.key, parent.key);
        }
    } else if (next.logicalZoom < prev.logicalZoom) {
        // 缩小：子节点朝真实父聚合移动，父聚合在汇合阶段出现
        for (const parent of next.visibleNodes) {
            if (parent.kind !== 'cluster' || plan.reuse.has(parent.key)) continue;
            if (budget.remaining <= 0) break;
            const descendants = engine.descendantsAt(parent, prev.logicalZoom, budget);
            if (!descendants) continue;
            const visible = descendants.filter((d) => prev.nodeByKey.has(d.key) && !usedPrev.has(d.key));
            if (!visible.length) continue;
            if (visible.length === 1 && visible[0].count === parent.count) {
                plan.reuse.set(parent.key, visible[0].key);
                usedPrev.add(visible[0].key);
                continue;
            }
            plan.mergeTargets.add(parent.key);
            for (const child of visible) {
                plan.mergeInto.set(child.key, parent.key);
                usedPrev.add(child.key);
            }
        }
    }
}

function linkNodes(nextToPrev, prevToNext, nextKey, prevKey) {
    if (!nextToPrev.has(nextKey)) nextToPrev.set(nextKey, new Set());
    if (!prevToNext.has(prevKey)) prevToNext.set(prevKey, new Set());
    nextToPrev.get(nextKey).add(prevKey);
    prevToNext.get(prevKey).add(nextKey);
}

function planRelations(plan, nextToPrev, prevToNext) {
    // 只过渡互斥的一一、一对多和多对一关系。
    for (const [nextKey, prevKeys] of nextToPrev) {
        const exclusive = [...prevKeys].every((prevKey) => prevToNext.get(prevKey).size === 1);
        if (!exclusive) continue;
        if (prevKeys.size === 1) {
            const [prevKey] = prevKeys;
            plan.reuse.set(nextKey, prevKey);
        } else {
            plan.mergeTargets.add(nextKey);
            for (const prevKey of prevKeys) plan.mergeInto.set(prevKey, nextKey);
        }
    }
    for (const [prevKey, nextKeys] of prevToNext) {
        if (nextKeys.size < 2) continue;
        const exclusive = [...nextKeys].every((nextKey) => nextToPrev.get(nextKey).size === 1);
        if (!exclusive) continue;
        plan.splitSources.add(prevKey);
        for (const nextKey of nextKeys) plan.splitFrom.set(nextKey, prevKey);
    }
}

function markerBandDirection(prev, next) {
    const a = prev.markerBand;
    const b = next.markerBand;
    if (next.queryMode !== 'nearby' || !a || !b) return null;
    if (a.kind === 'aggregate' && (b.kind === 'leaf' || a.cell < b.cell)) return 'zoom-in';
    if (b.kind === 'aggregate' && (a.kind === 'leaf' || b.cell < a.cell)) return 'zoom-out';
    return null;
}

function coarseCellKey(place, zoom) {
    if (!place) return null;
    if (place.aggregateCell) {
        const [cellZoom, x, y] = place.aggregateCell;
        if (cellZoom < zoom) return null;
        const scale = 2 ** (cellZoom - zoom);
        return `${Math.floor(x / scale)}/${Math.floor(y / scale)}`;
    }
    return tileOf(Number(place.longitude), Number(place.latitude), zoom).join('/');
}

function markerDistanceSquared(a, b) {
    const dx = Math.abs(worldX(a[0], 0) - worldX(b[0], 0));
    const dy = worldY(a[1], 0) - worldY(b[1], 0);
    return Math.min(dx, 1 - dx) ** 2 + dy ** 2;
}

function planMarkerBand(plan, prev, next, remainingPrev, remainingNext, direction, memberBudget) {
    const refining = direction === 'zoom-in';
    const coarse = refining ? prev : next;
    const fine = refining ? next : prev;
    const coarseNodes = refining ? remainingPrev : remainingNext;
    const fineNodes = refining ? remainingNext : remainingPrev;
    const parentByMember = buildMemberToNode({ ...coarse, visibleNodes: coarseNodes }, memberBudget);
    if (!parentByMember) return;

    const zoom = coarse.markerBand.cell;
    const parentByCell = new Map();
    for (const [member, parent] of parentByMember) {
        const place = coarse.engine.placeByKey.get(member);
        // 同一个匿名格的行坐标相同，必定属于同一个可见节点。
        if (place?.aggregateCell?.[0] === zoom) parentByCell.set(coarseCellKey(place, zoom), parent);
    }

    const nextToPrev = new Map();
    const prevToNext = new Map();
    const reanchorCandidates = new Set();
    let total = 0;
    for (const node of fineNodes) {
        total += node.count;
        if (total > memberBudget) return;
        const votes = new Map();
        for (const member of fine.engine.memberKeys(node)) {
            const parent = parentByMember.get(member)
                ?? parentByCell.get(coarseCellKey(fine.engine.placeByKey.get(member), zoom));
            if (parent) votes.set(parent, (votes.get(parent) || 0) + 1);
        }
        // 跨格的细节点只从一个粗节点出发，优先选重叠成员最多的节点。
        let bestParent = null;
        let bestCount = 0;
        let bestDistance = Infinity;
        for (const [parent, count] of votes) {
            if (count < bestCount) continue;
            const distance = markerDistanceSquared(node.coordinate, coarse.nodeByKey.get(parent).coordinate);
            if (count > bestCount || distance < bestDistance || (distance === bestDistance && parent < bestParent)) {
                bestParent = parent;
                bestCount = count;
                bestDistance = distance;
            }
        }
        if (!bestParent) continue;
        const nextKey = refining ? node.key : bestParent;
        const prevKey = refining ? bestParent : node.key;
        linkNodes(nextToPrev, prevToNext, nextKey, prevKey);
        if (bestCount === node.count && bestCount === coarse.nodeByKey.get(bestParent).count) reanchorCandidates.add(nextKey);
    }
    planRelations(plan, nextToPrev, prevToNext);
    for (const key of reanchorCandidates) {
        if (plan.reuse.has(key)) plan.reanchor.add(key);
    }
}

function planData(plan, prev, next, options) {
    const usedPrev = new Set(plan.reuse.values());
    // 1. 成员签名相同且核对成员一致：直接沿用图形
    const prevBySignature = new Map();
    for (const node of prev.visibleNodes) {
        if (node.kind !== 'cluster' || usedPrev.has(node.key)) continue;
        if (!prevBySignature.has(node.memberSignature)) prevBySignature.set(node.memberSignature, []);
        prevBySignature.get(node.memberSignature).push(node);
    }
    for (const node of next.visibleNodes) {
        if (node.kind !== 'cluster' || plan.reuse.has(node.key)) continue;
        const candidates = prevBySignature.get(node.memberSignature);
        if (!candidates) continue;
        const nextMembers = next.engine.memberKeys(node);
        const match = candidates.find((candidate) => !usedPrev.has(candidate.key)
            && sameMembers(prev.engine.memberKeys(candidate), nextMembers));
        if (match) {
            plan.reuse.set(node.key, match.key);
            usedPrev.add(match.key);
        }
    }

    const remainingNext = next.visibleNodes.filter((n) => !plan.reuse.has(n.key));
    const remainingPrev = prev.visibleNodes.filter((n) => !usedPrev.has(n.key));
    if (!remainingNext.length || !remainingPrev.length) return;
    // 换档时把共同成员和匿名格一起用于查找来源，避免共同成员先占用整个粗节点。
    const direction = markerBandDirection(prev, next);
    if (direction) {
        planMarkerBand(plan, prev, next, remainingPrev, remainingNext, direction, options.memberBudget);
        return;
    }
    // 2. 普通数据变化按成员交集分类，超出预算时退回渐变。
    const prevMemberMap = buildMemberToNode({ ...prev, visibleNodes: remainingPrev }, options.memberBudget);
    if (!prevMemberMap) return;

    const nextToPrev = new Map();
    const prevToNext = new Map();
    let total = 0;
    for (const node of remainingNext) {
        total += node.count;
        if (total > options.memberBudget) return;
        const hits = new Set();
        for (const member of next.engine.memberKeys(node)) {
            const prevKey = prevMemberMap.get(member);
            if (prevKey) hits.add(prevKey);
        }
        for (const prevKey of hits) linkNodes(nextToPrev, prevToNext, node.key, prevKey);
    }
    planRelations(plan, nextToPrev, prevToNext);

}

/**
 * @param {object|null} prev 上一份快照
 * @param {object} next 新快照
 */
export function planTransition(prev, next, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    if (!prev || !prev.visibleNodes.length) return finalize(emptyPlan('initial'), prev, next);
    if (prev.queryMode !== next.queryMode) {
        // 进入/退出搜索、沿途等模式属于大幅筛选：只沿用两边都有的单点，其余短渐变
        const plan = emptyPlan('mode');
        reuseSameKeys(plan, prev, next);
        return finalize(plan, prev, next);
    }
    if (prev.generation === next.generation) {
        const kind = next.logicalZoom > prev.logicalZoom ? 'zoom-in' : next.logicalZoom < prev.logicalZoom ? 'zoom-out' : 'pan';
        const plan = emptyPlan(kind);
        reuseSameKeys(plan, prev, next);
        if (kind !== 'pan' && next.engine) planZoom(plan, prev, next, opts);
        return finalize(plan, prev, next);
    }
    const plan = emptyPlan('data');
    reuseSameKeys(plan, prev, next);
    if (prev.engine && next.engine) planData(plan, prev, next, opts);
    return finalize(plan, prev, next);
}

/** 校验：快照中每个成员恰好属于一个节点，且计数守恒。返回问题描述数组（空数组表示通过）。 */
export function verifySnapshotMembers(snapshot) {
    const problems = [];
    const seen = new Map();
    for (const node of snapshot.visibleNodes) {
        const members = snapshot.engine.memberKeys(node);
        if (members.length !== node.count) problems.push(`${node.key} count ${node.count} != members ${members.length}`);
        for (const member of members) {
            if (seen.has(member)) problems.push(`${member} in ${seen.get(member)} and ${node.key}`);
            seen.set(member, node.key);
        }
    }
    return problems;
}
