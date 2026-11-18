'use strict';
// AI 搜索的推荐语（见 ../doc/README.md 的“推荐语模板”）：只由 ../recommendationTemplates.json 里的固定模板、
// 地点字段、用户原话和逐字核对过的店铺介绍摘录拼成，不含模型写的文字。模型只判断相关性并摘原文。
const templates = require('../recommendationTemplates.json');
const { descriptionForReview } = require('../../../infrastructure/aiClients');
const { EXPLORE_TAG } = require('../../ratings/services/ratingWarning');

const SLOTS = ['name', 'query', 'excerpt', 'category', 'distance', 'price'];
// 可能没有值的占位符，只能写在 [...] 可省略片段里
const OPTIONAL_SLOTS = ['category', 'distance', 'price'];
// 每组里必须写在方括号外的占位符。卡片标题就是店名，有摘录的句子可以用“这家”指代；
// 没有摘录的句子除了店名没有别的具体内容，所以必须提店名
const REQUIRED_SLOTS = { withExcerpt: ['excerpt'], withoutExcerpt: ['name'] };
const GROUPS = Object.keys(REQUIRED_SLOTS);
const EXCERPT_MIN_LENGTH = 4;
const EXCERPT_MAX_LENGTH = 60;
const QUERY_MAX_LENGTH = 36;
const CATEGORY_MAX_LENGTH = 30;
const CATEGORY_MAX_TAGS = 3;
// 说明不了这是家什么店的标签，不放进句子
const CATEGORY_SKIP = new Set(['其他', '避雷', EXPLORE_TAG]);

const SLOT_PATTERN = /\{([A-Za-z]+)\}/g;
const SEGMENT_PATTERN = /\[([^[\]]*)\]/g;
// 摘录首尾可以去掉的引号、空白和标点；去掉之后仍是原文的连续子串
const EXCERPT_EDGE = /^[\s"'“”‘’「」『』，,。.、；;：:！!？?…~～]+|[\s"'“”‘’「」『』，,。.、；;：:！!？?…~～]+$/g;

const chars = (text) => Array.from(String(text));
const clip = (text, max) => chars(text).slice(0, max).join('');
const hasValue = (slots, name) => slots[name] !== undefined && slots[name] !== null && String(slots[name]) !== '';

// 先在模板上处理可省略片段，再一次性填入占位符：店名或原话里本身带 {} 或 [] 时原样输出，不会被再次替换
function renderTemplate(template, slots = {}) {
    const kept = String(template).replace(SEGMENT_PATTERN, (_, segment) => {
        const names = [...segment.matchAll(SLOT_PATTERN)].map((match) => match[1]);
        return names.every((name) => hasValue(slots, name)) ? segment : '';
    });
    return kept.replace(SLOT_PATTERN, (_, name) => (hasValue(slots, name) ? String(slots[name]) : ''));
}

// 模型给的依据只有在原样出现在它看到的店铺介绍里时才保留，否则丢弃
function verifiedEvidence(evidence, place) {
    const text = String(evidence || '').replace(/\s+/g, ' ').replace(EXCERPT_EDGE, '');
    const length = chars(text).length;
    if (length < EXCERPT_MIN_LENGTH || length > EXCERPT_MAX_LENGTH) return '';
    if (text === String(place?.name || '').trim()) return '';
    return descriptionForReview(place).includes(text) ? text : '';
}

function formatDistance(km) {
    return km < 1 ? `${Math.round(km * 1000)} 米` : `${km.toFixed(1)} 公里`;
}

// Place.category 是“快餐, 餐厅, 潮州菜, 面馆”这样的标签串，可能只有“其他”。放进句子前去掉 CATEGORY_SKIP 和重复的，
// 最多取三个、用顿号连起来；超长就少取一个，不截在标签中间；一个不剩就当没有分类
function categoryText(category) {
    const tags = [...new Set(String(category || '').split(/[,，/、|]/).map((tag) => tag.trim()))]
        .filter((tag) => tag && !CATEGORY_SKIP.has(tag));
    const kept = [];
    for (const tag of tags.slice(0, CATEGORY_MAX_TAGS)) {
        if (chars([...kept, tag].join('、')).length > CATEGORY_MAX_LENGTH) break;
        kept.push(tag);
    }
    return kept.join('、');
}

function reasonSlots(query, match, excerpt) {
    const place = match?.place || {};
    const price = Number(place.per_person_cost);
    const distance = match?.distance_km;
    return {
        name: String(place.name || '').trim(),
        query: clip(String(query || '').replace(/\s+/g, ' ').trim(), QUERY_MAX_LENGTH),
        excerpt: excerpt || '',
        category: categoryText(place.category),
        // 正好在地图中心（四舍五入是 0 米）时当作没有距离，免得说出“离地图中心 0 米”
        distance: typeof distance === 'number' && Number.isFinite(distance) && Math.round(distance * 1000) > 0 ? formatDistance(distance) : '',
        price: Number.isFinite(price) && price > 0 ? String(Math.round(price)) : ''
    };
}

function hashText(text) {
    let hash = 0;
    for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash;
}

// 组内按“卡片序号 + 原话哈希”轮换：同一次搜索的几张卡句式不同，同样的原话每次结果一样
function pickTemplate(group, query, index, source = templates) {
    const list = Array.isArray(source[group]) && source[group].length ? source[group] : source.withoutExcerpt;
    if (!Array.isArray(list) || !list.length) return '「{name}」';
    return list[(hashText(String(query || '').trim()) + Math.max(0, index | 0)) % list.length];
}

function recommendationReason(query, match, excerpt = '', index = 0) {
    const group = excerpt ? 'withExcerpt' : 'withoutExcerpt';
    return renderTemplate(pickTemplate(group, query, index), reasonSlots(query, match, excerpt));
}

// 模板文件的格式检查（测试用）：返回问题列表，空数组表示通过
function validateTemplates(source = templates) {
    const problems = [];
    const sample = { name: '示例小馆', query: '想吃点热乎的', excerpt: '招牌是砂锅粥', category: '粥铺', distance: '800 米', price: '45' };
    const sparse = { ...sample, ...Object.fromEntries(OPTIONAL_SLOTS.map((name) => [name, ''])) };
    const BROKEN = /[{}[\]]|[，、：；][，。！？～、：；]|～[，。、：；]|[（「“『][）」”』]|^[，。！？、：；～]/;
    for (const group of GROUPS) {
        const list = source[group];
        if (!Array.isArray(list) || !list.length) {
            problems.push(`${group}：至少要有一条模板`);
            continue;
        }
        list.forEach((template, index) => {
            const where = `${group}[${index}]`;
            if (typeof template !== 'string' || !template.trim()) {
                problems.push(`${where}：模板必须是非空字符串`);
                return;
            }
            let depth = 0;
            for (const char of template) {
                if (char === '[') depth += 1;
                if (char === ']') depth -= 1;
                if (depth < 0 || depth > 1) break;
            }
            if (depth !== 0) {
                problems.push(`${where}：方括号必须成对且不能嵌套`);
                return;
            }
            const used = [...template.matchAll(SLOT_PATTERN)].map((match) => match[1]);
            for (const name of used) {
                if (!SLOTS.includes(name)) problems.push(`${where}：未知占位符 {${name}}`);
            }
            if (group === 'withoutExcerpt' && used.includes('excerpt')) problems.push(`${where}：没有摘录的模板不能用 {excerpt}`);
            for (const [, segment] of template.matchAll(SEGMENT_PATTERN)) {
                if (!/\{[A-Za-z]+\}/.test(segment)) problems.push(`${where}：方括号片段里至少要有一个占位符`);
            }
            const outside = [...template.replace(SEGMENT_PATTERN, '').matchAll(SLOT_PATTERN)].map((match) => match[1]);
            for (const name of REQUIRED_SLOTS[group]) {
                if (!outside.includes(name)) problems.push(`${where}：{${name}} 必须写在方括号外`);
            }
            for (const name of OPTIONAL_SLOTS) {
                if (outside.includes(name)) problems.push(`${where}：{${name}} 可能没有值，必须写在方括号里`);
            }
            for (const [label, slots] of [['全部有值', sample], ['可选全空', sparse]]) {
                const text = renderTemplate(template, slots);
                if (BROKEN.test(text)) problems.push(`${where}：${label}时渲染结果有残留符号或断句：${text}`);
            }
        });
    }
    return problems;
}

module.exports = {
    SLOTS,
    OPTIONAL_SLOTS,
    REQUIRED_SLOTS,
    EXCERPT_MIN_LENGTH,
    EXCERPT_MAX_LENGTH,
    renderTemplate,
    verifiedEvidence,
    reasonSlots,
    pickTemplate,
    recommendationReason,
    validateTemplates
};
