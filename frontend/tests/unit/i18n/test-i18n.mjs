// 文案检查：npm run test:i18n
// 1. 代码里的 t('命名空间:键') / tx(...) 必须在 zh-CN 文案里存在，文案用到的插值参数都要传；
// 2. 代码里不应再出现硬编码中文（console 输出和下面登记的数据值除外）；
// 3. 其他语言缺少的键只提示，不算失败。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, 'src');
const LOCALES = join(SRC, 'i18n', 'locales');
const BASE_LANGUAGE = 'zh-CN';
const HAN = /[㐀-鿿]/;

// 这些中文是数据而不是界面文案：提交给后端或与后端、高德约定的取值，按原样保留
const DATA_STRINGS = {
    "src/admin/AdminDashboard.jsx": ['用户管理', '操作日志', '标记点管理', '评论管理', 'QQ白名单管理', '公告发布', '普通用户管理', '皮肤兑换码'],
    // 后端未登录报错的匹配词
    'src/admin/AdminComments.jsx': ['未登录'],
    'src/admin/AdminGeneralUsers.jsx': ['未登录'],
    'src/admin/AdminPlaces.jsx': ['未登录'],
    'src/admin/AdminUsers.jsx': ['未登录'],
    // 首图风格、分享平台与文风的取值（会提交给日记 AI）
    'src/journey/cover.js': ['主站'],
    'src/journey/JourneyShare.jsx': ['小红书', '朋友圈', '手账', '日记', '自然', '活泼', '简洁', '文艺', '主站', '奶油', '薄荷', '夜色'],
    // 未选店站点的占位名，存在草稿数据里
    'src/journey/JourneyStopCard.jsx': ['待选店'],
    'src/journey/reviewUtils.js': ['待选店'],
    // 高德接口参数与 POI 分类
    "src/discovery/alongRoute.js": ['全国'],
    'src/journey/maps.jsx': ['全国'],
    'src/map/utils.js': ['中餐厅', '外国餐厅'],
    // 分类名（“避雷”标签：没人评价的地点按它显示避雷图标，添加地点时据此预选评价）
    "src/places/rating.js": ['避雷']
};

function flatten(object, prefix, out) {
    for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') flatten(value, path, out);
        else out.set(path, value);
    }
    return out;
}

function loadLanguage(language) {
    const dir = join(LOCALES, language);
    const messages = new Map();
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const ns = file.replace(/\.json$/, '');
        for (const [key, value] of flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')), '', new Map())) {
            messages.set(`${ns}:${key}`, value);
        }
    }
    return messages;
}

function listSources(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path !== join(SRC, 'i18n')) files.push(...listSources(path));
        } else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(path);
    }
    return files;
}

const placeholders = (message) => [...String(message).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1].split('.')[0]);

const base = loadLanguage(BASE_LANGUAGE);
const usedKeys = new Set();
const errors = [];
let callSites = 0;

for (const abs of listSources(SRC)) {
    const file = relative(ROOT, abs).split(sep).join('/');
    const code = readFileSync(abs, 'utf8');
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
    const translators = new Set();
    for (const node of ast.program.body) {
        if (node.type === 'ImportDeclaration' && /\/i18n\/index\.js$/.test(node.source.value)) {
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier' && ['t', 'tx'].includes(spec.imported.name)) translators.add(spec.local.name);
            }
        }
    }
    const allowed = new Set(DATA_STRINGS[file] || []);
    const report = (node, text) => {
        if (allowed.has(text)) return;
        errors.push(`${file}:${node.loc.start.line} 硬编码中文：${JSON.stringify(text.trim().slice(0, 60))}`);
    };

    (function walk(node, inConsole) {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'CallExpression') {
            const callee = node.callee;
            if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'console') {
                inConsole = true;
            } else if (callee.type === 'Identifier' && translators.has(callee.name)) {
                callSites++;
                const [keyArg, valuesArg] = node.arguments;
                if (!keyArg || keyArg.type !== 'StringLiteral') {
                    errors.push(`${file}:${node.loc.start.line} ${callee.name}() 的键必须是字符串字面量，检查才能覆盖`);
                } else if (!base.has(keyArg.value)) {
                    errors.push(`${file}:${node.loc.start.line} 缺少文案：${keyArg.value}`);
                } else {
                    usedKeys.add(keyArg.value);
                    if (!valuesArg || valuesArg.type === 'ObjectExpression') {
                        const given = new Set((valuesArg?.properties || []).map((p) => p.key?.name ?? p.key?.value));
                        for (const name of placeholders(base.get(keyArg.value))) {
                            if (!given.has(name)) errors.push(`${file}:${node.loc.start.line} ${keyArg.value} 缺少插值参数 ${name}`);
                        }
                    }
                }
            }
        }
        if (!inConsole) {
            if (node.type === 'StringLiteral' && HAN.test(node.value)) report(node, node.value);
            else if (node.type === 'TemplateElement' && HAN.test(node.value.cooked)) report(node, node.value.cooked);
            else if (node.type === 'JSXText' && HAN.test(node.value)) report(node, node.value);
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach((child) => walk(child, inConsole));
            else if (value && typeof value.type === 'string') walk(value, inConsole);
        }
    })(ast.program, false);
}

const unused = [...base.keys()].filter((key) => !usedKeys.has(key));
if (unused.length) console.log(`提示：${unused.length} 条文案没有被代码引用：${unused.slice(0, 10).join('、')}${unused.length > 10 ? ' …' : ''}`);

for (const language of readdirSync(LOCALES).filter((name) => name !== BASE_LANGUAGE)) {
    const messages = loadLanguage(language);
    const missing = [...base.keys()].filter((key) => !messages.has(key));
    if (missing.length) console.log(`提示：${language} 还缺 ${missing.length} 条文案（会显示 ${BASE_LANGUAGE} 原文）`);
}

if (errors.length) {
    console.error(errors.join('\n'));
    console.error(`i18n check failed: ${errors.length} problem(s)`);
    process.exit(1);
}
console.log(`i18n tests passed (${base.size} keys, ${callSites} call sites)`);
