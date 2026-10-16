// 快照差分：决定两份聚类快照之间每个节点的去向。纯数据逻辑，不涉及 DOM 与动画时序。
//
// 同一索引代内用真实树关系处理一层或跨多层缩放；跨代（数据变化）不冒充缩放拆分：
// 先按 key / 成员签名复用图形，只有明确的一对多、多对一才按成员交集连接，其余短渐变。

import { buildMemberToNode } from './snapshot.js';

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

    // 2. 其余节点按成员交集分类；成员总数超出预算时不展开，全部短渐变
    const remainingNext = next.visibleNodes.filter((n) => !plan.reuse.has(n.key));
    const remainingPrev = prev.visibleNodes.filter((n) => !usedPrev.has(n.key));
    if (!remainingNext.length || !remainingPrev.length) return;
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
        nextToPrev.set(node.key, hits);
        for (const prevKey of hits) {
            if (!prevToNext.has(prevKey)) prevToNext.set(prevKey, new Set());
            prevToNext.get(prevKey).add(node.key);
        }
    }

    for (const node of remainingNext) {
        const hits = nextToPrev.get(node.key);
        if (!hits || !hits.size) continue;
        const exclusive = [...hits].every((prevKey) => prevToNext.get(prevKey)?.size === 1);
        if (!exclusive) continue; // 多对多：交给渐变
        if (hits.size === 1) {
            // 一一对应（例如聚合多了或少了几个成员）：沿用图形，只更新数量与位置
            const [prevKey] = hits;
            if (!usedPrev.has(prevKey)) {
                plan.reuse.set(node.key, prevKey);
                usedPrev.add(prevKey);
            }
        } else {
            plan.mergeTargets.add(node.key);
            for (const prevKey of hits) {
                plan.mergeInto.set(prevKey, node.key);
                usedPrev.add(prevKey);
            }
        }
    }
    // 一对多：一个旧节点只连到若干个只来自它的新节点
    for (const [prevKey, nextKeys] of prevToNext) {
        if (usedPrev.has(prevKey) || nextKeys.size < 2) continue;
        const exclusive = [...nextKeys].every((nextKey) => nextToPrev.get(nextKey)?.size === 1 && !plan.reuse.has(nextKey));
        if (!exclusive) continue;
        plan.splitSources.add(prevKey);
        usedPrev.add(prevKey);
        for (const nextKey of nextKeys) plan.splitFrom.set(nextKey, prevKey);
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
