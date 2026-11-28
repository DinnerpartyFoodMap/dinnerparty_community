'use strict';

// 相同或相近的地点标签合并表（modules/places/categoryMerges.json）：写入、筛选与新建标签时换成保留的标签。
// 已有数据由 scripts/places/merge_categories.js 一次性合并。

const { merges } = require('../categoryMerges.json');
const PLACE_CATEGORY_MAX_LENGTH = 240;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

function parseCategoryNames(value) {
    return [...new Set(String(value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean))];
}

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

function getCategoryNameLength(value) {
    return Array.from(value).reduce((length, character) => (
        length + (character.codePointAt(0) > 0x7f ? 2 : 1)
    ), 0);
}

function normalizeCategoryList(value) {
    const names = canonicalCategoryNames(parseCategoryNames(value));
    const invalidName = names.find((name) => /[,，]/.test(name) || HTML_TAG_PATTERN.test(name) || getCategoryNameLength(name) > 16);
    if (invalidName) {
        return { error: `分类“${invalidName}”不能超过8个汉字或16个英文字符，且仅支持纯文本` };
    }
    return { value: names.join(', '), names };
}

function syncCategoryRegistry(names, creatorId, database = require('../../../infrastructure/database').db._raw) {
    if (!Array.isArray(names) || names.length === 0) return;
    const insert = database.prepare(
        `INSERT OR IGNORE INTO Category (name, is_common, sort_order, created_by)
         VALUES (?, 0, 1000, ?)`
    );
    database.transaction((items) => {
        items.forEach((name) => insert.run(name, creatorId || null));
    })(names);
}

/** 合并表：[{ source, target }]（脚本与测试用） */
function categoryMergeEntries() {
    return Object.entries(merges || {}).map(([source, target]) => ({ source: String(source).trim(), target: String(target).trim() }));
}

module.exports = { parseCategoryNames, canonicalCategoryName, canonicalCategoryNames, categoryMergeEntries,
    normalizeCategoryList, syncCategoryRegistry, getCategoryNameLength, PLACE_CATEGORY_MAX_LENGTH, HTML_TAG_PATTERN };
