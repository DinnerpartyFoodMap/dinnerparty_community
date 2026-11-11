'use strict';

// 相同或相近的地点标签合并表（modules/places/categoryMerges.json）：写入、筛选与新建标签时换成保留的标签。
// 已有数据由 scripts/places/merge_categories.js 一次性合并。

const { merges } = require('../categoryMerges.json');

const TARGETS = new Map();
for (const [source, target] of Object.entries(merges || {})) {
    const from = String(source || '').trim();
    const to = String(target || '').trim();
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    TARGETS.set(from.toLowerCase(), to);
}

/** 标签的保留名：在合并表里时返回保留的标签，否则原样返回（已去掉首尾空白） */
function canonicalCategoryName(name) {
    const value = String(name || '').trim();
    if (!value) return value;
    return TARGETS.get(value.toLowerCase()) || value;
}

/** 一组标签换成保留名并去重，保持原来的顺序 */
function canonicalCategoryNames(names) {
    const seen = new Set();
    const result = [];
    for (const name of names || []) {
        const value = canonicalCategoryName(name);
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        result.push(value);
    }
    return result;
}

/** 合并表：[{ source, target }]（脚本与测试用） */
function categoryMergeEntries() {
    return Object.entries(merges || {}).map(([source, target]) => ({ source: String(source).trim(), target: String(target).trim() }));
}

module.exports = { canonicalCategoryName, canonicalCategoryNames, categoryMergeEntries };
