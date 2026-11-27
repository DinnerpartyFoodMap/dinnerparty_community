// 快照差分：决定两份聚类快照之间每个节点的去向。纯数据逻辑，不涉及 DOM 与动画时序。
//
// 同一索引代内使用真实树关系，跨代优先使用 key 和成员交集。
// 附近地图换瓦片档时，剩余节点可以按匿名粗格的覆盖范围过渡。

import { buildMemberToNode, budgetedMemberKeys, reserveMembers } from './snapshot.js';
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
        keepAnchor: new Set(),   // nextKey：换档时仍代表同一组地点，保留已显示的坐标
        reanchor: new Set(),     // nextKey：补齐明细坐标时跳过独立的滑动动画
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
    // Walk upward from visible nodes. A parent's population says nothing about
    // how many visible children a zoom exposes (50k members can be 100 glyphs).
    const budget = { remaining: options.descendantBudget };
    const refining = next.logicalZoom > prev.logicalZoom;
    const coarse = refining ? prev : next, fine = refining ? next : prev;
    const parents = new Set(coarse.visibleNodes.filter(node=>node.kind === 'cluster'
        && !(refining ? usedPrev.has(node.key) : plan.reuse.has(node.key))).map(node=>node.key));
    const byParent = new Map(), cache = new Map();
    for (const child of fine.visibleNodes) {
        if (refining ? plan.reuse.has(child.key) : usedPrev.has(child.key)) continue;
        const parent = engine.visibleAncestor(child,parents,budget,cache);
        if (!parent) continue;
        if (!byParent.has(parent)) byParent.set(parent,[]);
        byParent.get(parent).push(child);
    }
    for (const [parentKey,children] of byParent) {
        const parent = coarse.nodeByKey.get(parentKey);
        if (children.length === 1 && children[0].count === parent.count) {
            plan.reuse.set(refining ? children[0].key : parentKey,refining ? parentKey : children[0].key);
        } else if (refining) {
            plan.splitSources.add(parentKey);
            for (const child of children) plan.splitFrom.set(child.key,parentKey);
        } else {
            plan.mergeTargets.add(parentKey);
            for (const child of children) plan.mergeInto.set(child.key,parentKey);
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

// 匿名点与明细换档时按哪一级格子对应：带格内小格的一级（sub）按小格（z14 + 4 = z18），其余按格子本身。
function bandMatchZoom(band) {
    const bits = Number.isInteger(band?.sub) && band.sub > 1 ? Math.log2(band.sub) : 0;
    return band.cell + (Number.isInteger(bits) ? bits : 0);
}

function coarseCellKey(place, zoom) {
    if (!place) return null;
    if (place.aggregateCell) {
        const [cellZoom, x, y, subZoom] = place.aggregateCell;
        // 带小格的匿名点坐标就是小格中心，到小格这一级为止都按坐标取格子
        if (subZoom >= zoom) return tileOf(Number(place.longitude), Number(place.latitude), zoom).join('/');
        if (cellZoom < zoom) return null;
        const scale = 2 ** (cellZoom - zoom);
        return `${Math.floor(x / scale)}/${Math.floor(y / scale)}`;
    }
    return tileOf(Number(place.longitude), Number(place.latitude), zoom).join('/');
}

function missingFallbackCells(prev, next, previousMembers) {
    if (prev.markerBand?.kind !== 'leaf' || next.markerBand?.kind !== 'leaf' || next.queryMode !== 'nearby') return null;
    const parents = new Map();
    let zoom;
    for (const [member, nodeKey] of previousMembers) {
        const place = prev.engine.placeByKey.get(member);
        const cell = place?.aggregateCell;
        if (!cell || next.engine.placeByKey.has(member)) continue;
        zoom = cell[3] ?? cell[0]; // 明细档只用同一级城市瓦片补位；带小格时按小格对应。
        parents.set(coarseCellKey(place, zoom), nodeKey);
    }
    return parents.size ? { zoom, parents } : null;
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
    const rawCost = coarseNodes.reduce((sum,node)=>sum+node.count*3,0)
        + fineNodes.reduce((sum,node)=>sum+node.count*2,0);
    if (rawCost > memberBudget.remaining) {
        planMarkerCells(plan,coarse,fine,coarseNodes,fineNodes,refining,memberBudget);
        return;
    }
    const parentByMember = buildMemberToNode({ ...coarse, visibleNodes: coarseNodes }, memberBudget);
    if (!parentByMember) return;

    const zoom = bandMatchZoom(coarse.markerBand);
    const parentByCell = new Map();
    if (!reserveMembers(memberBudget,parentByMember.size)) return;
    for (const [member, parent] of parentByMember) {
        const place = coarse.engine.placeByKey.get(member);
        // 同一个匿名格（带小格时是同一个小格）的行坐标相同，必定属于同一个可见节点。
        if (place?.aggregateCell?.[0] === coarse.markerBand.cell) parentByCell.set(coarseCellKey(place, zoom), parent);
    }

    const nextToPrev = new Map();
    const prevToNext = new Map();
    const stableCandidates = new Set();
    for (const node of fineNodes) {
        const members = budgetedMemberKeys(fine.engine, node, memberBudget);
        if (!members) break;
        const votes = new Map();
        for (const member of members) {
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
            const coarseNode = coarse.nodeByKey.get(parent);
            const distance = markerDistanceSquared(node.sourceCoordinate ?? node.coordinate, coarseNode.sourceCoordinate ?? coarseNode.coordinate);
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
        if (bestCount === node.count && bestCount === coarse.nodeByKey.get(bestParent).count) stableCandidates.add(nextKey);
    }
    planRelations(plan, nextToPrev, prevToNext);
    for (const key of stableCandidates) {
        if (plan.reuse.has(key)) plan.keepAnchor.add(key);
    }
}

// Large tile bands contain many anonymous rows per cell. Their compact index
// groups let visible glyphs retain motion within the same visit budget, without
// materializing thousands of anonymous member keys. This path stays at cell
// level even when rows carry sub-cells: descending to sub-cells would exhaust
// the budget for city-wide clusters. A cell split across two coarse nodes
// matches neither, and those fine nodes fade in.
function planMarkerCells(plan, coarse, fine, coarseNodes, fineNodes, refining, budget) {
    const cellOf = (lng,lat)=>tileOf(lng,lat,coarse.markerBand.cell).join('/');
    const parentByCell = new Map();
    for (const node of coarseNodes) {
        const cells = coarse.engine.cellGroups(node,cellOf,budget,{anonymousOnly:true});
        if (!cells) return;
        for (const cell of cells.keys()) {
            if (parentByCell.has(cell) && parentByCell.get(cell) !== node.key) parentByCell.set(cell,null);
            else if (!parentByCell.has(cell)) parentByCell.set(cell,node.key);
        }
    }
    const nextToPrev = new Map(), prevToNext = new Map(), stable = new Set();
    for (const node of fineNodes) {
        const cells = fine.engine.cellGroups(node,cellOf,budget);
        if (!cells) break;
        const votes = new Map();
        for (const [cell,count] of cells) {
            const parent = parentByCell.get(cell);
            if (parent) votes.set(parent,(votes.get(parent) || 0)+count);
        }
        let best = null, bestCount = 0, bestDistance = Infinity;
        for (const [key,count] of votes) {
            const parent = coarse.nodeByKey.get(key);
            const distance = markerDistanceSquared(node.sourceCoordinate ?? node.coordinate,parent.sourceCoordinate ?? parent.coordinate);
            if (count > bestCount || count === bestCount && (distance < bestDistance || distance === bestDistance && key < best)) {
                best = key; bestCount = count; bestDistance = distance;
            }
        }
        if (!best) continue;
        const nextKey = refining ? node.key : best, prevKey = refining ? best : node.key;
        linkNodes(nextToPrev,prevToNext,nextKey,prevKey);
        if (bestCount === node.count && bestCount === coarse.nodeByKey.get(best).count) stable.add(nextKey);
    }
    planRelations(plan,nextToPrev,prevToNext);
    for (const key of stable) if (plan.reuse.has(key)) plan.keepAnchor.add(key);
}

function planData(plan, prev, next, options) {
    const budget = { remaining: Math.max(0, options.memberBudget) };
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
        const nextMembers = budgetedMemberKeys(next.engine, node, budget);
        if (!nextMembers) continue;
        let match;
        for (const candidate of candidates) {
            if (usedPrev.has(candidate.key)) continue;
            const previousMembers = budgetedMemberKeys(prev.engine, candidate, budget);
            if (!previousMembers || !reserveMembers(budget, nextMembers.length)) break;
            if (sameMembers(previousMembers, nextMembers)) { match = candidate; break; }
        }
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
        planMarkerBand(plan, prev, next, remainingPrev, remainingNext, direction, budget);
        return;
    }
    // 2. 普通数据变化按成员交集分类。明细档补块时，新增的真实地点也可匹配被替换的匿名格。
    const prevMemberMap = buildMemberToNode({ ...prev, visibleNodes: remainingPrev }, budget);
    if (!prevMemberMap) return;

    if (!reserveMembers(budget, prevMemberMap.size)) return;
    const fallback = missingFallbackCells(prev, next, prevMemberMap);
    const nextToPrev = new Map();
    const prevToNext = new Map();
    const stableCandidates = new Set();
    for (const node of remainingNext) {
        const members = budgetedMemberKeys(next.engine, node, budget);
        if (!members) break;
        const hits = new Map();
        let replacesFallback = false;
        for (const member of members) {
            let prevKey = prevMemberMap.get(member);
            if (!prevKey && fallback && !prev.engine.placeByKey.has(member)) {
                const place = next.engine.placeByKey.get(member);
                if (place && !place.aggregateCell) {
                    prevKey = fallback.parents.get(coarseCellKey(place, fallback.zoom));
                    if (prevKey) replacesFallback = true;
                }
            }
            if (prevKey) hits.set(prevKey, (hits.get(prevKey) || 0) + 1);
        }
        for (const [prevKey, count] of hits) {
            linkNodes(nextToPrev, prevToNext, node.key, prevKey);
            if (replacesFallback && count === node.count && count === prev.nodeByKey.get(prevKey).count) {
                stableCandidates.add(node.key);
            }
        }
    }
    planRelations(plan, nextToPrev, prevToNext);
    for (const key of stableCandidates) {
        if (plan.reuse.has(key)) plan.keepAnchor.add(key);
    }
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

/**
 * 被打断的调和会在屏幕上留下没确认的快照里的节点（previous 里没有的 key），主计划不知道它们。
 * 按这些快照（最新在前）到 next 的转场补一份关系，只收录 previous 里没有、更新的快照也没有的 key：
 * reuse / splitFrom 为 nextKey -> [旧 key]（按新旧顺序），mergeInto 为旧 key -> nextKey。都没有时返回 null。
 * @param {object|null} previous 主计划的基准快照
 * @param {object[]} shown 可能部分显示的未确认快照，最新在前
 * @param {object} next 新快照
 */
export function planOrphans(previous, shown, next, options = {}) {
    const covered = new Set(previous ? previous.nodeByKey.keys() : []);
    const result = { reuse: new Map(), mergeInto: new Map(), splitFrom: new Map(), mergeTargets: new Set(), splitSources: new Set() };
    const append = (map, key, value) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
    };
    for (const snapshot of shown) {
        if (!snapshot?.visibleNodes.length) continue;
        const plan = planTransition(snapshot, next, options);
        for (const [nextKey, from] of plan.reuse) if (!covered.has(from)) append(result.reuse, nextKey, from);
        for (const [from, nextKey] of plan.mergeInto) {
            if (covered.has(from)) continue;
            result.mergeInto.set(from, nextKey);
            result.mergeTargets.add(nextKey);
        }
        for (const [nextKey, from] of plan.splitFrom) {
            if (covered.has(from)) continue;
            append(result.splitFrom, nextKey, from);
            result.splitSources.add(from);
        }
        for (const key of snapshot.nodeByKey.keys()) covered.add(key);
    }
    return result.reuse.size || result.mergeInto.size || result.splitFrom.size ? result : null;
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
