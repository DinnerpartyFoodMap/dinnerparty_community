// 设计规范扫描（frontend/doc/DESIGN_SYSTEM.md）：
// - 组件里不写十六进制颜色（用 tokens.json 生成的 CSS 变量）。白名单是 Canvas 出图、theme.js 的默认值与公告颜色给原生的色值；
//   单行确实需要时在同一行写 design-token-ignore 并说明原因。
// - 字号不在阶梯里、圆角不是令牌的写法只减不增：数量按文件记在 design-lint-baseline.json，比基线多就失败。
//   改小了以后运行 node tests/unit/styles/test-design-lint.mjs --update 更新基线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const srcRoot = path.join(root, 'src');
const baselinePath = fileURLToPath(new URL('./design-lint-baseline.json', import.meta.url));

const SKIP_DIRS = ['i18n', path.join('skins', 'packs'), path.join('poster', 'rendering')];
const SKIP_FILES = new Set(['styles/tokens.generated.css', 'styles/tokens.system.css']);
// 画布与原生需要具体色值的文件
const HEX_ALLOWED = new Set(['journey/cover.js', 'places/shareCard.js', 'theme/theme.js', 'components/feedback/noticeColors.js']);
// 字号阶梯（设计参考 2.2）加上输入框 16 与图标常用的 18 / 24
const FONT_SIZES = new Set([11, 12, 13, 15, 16, 17, 18, 20, 22, 24, 28]);
const RADIUS_PLAIN = /^(0|0px|50%|100%|999|999px|9999|inherit)$/;

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        const rel = path.relative(srcRoot, file);
        if (entry.isDirectory()) return SKIP_DIRS.includes(rel) ? [] : walk(file);
        return /\.(jsx?|css)$/.test(entry.name) ? [file] : [];
    });
}

function radiusOk(raw) {
    const value = raw.trim().replace(/!important$/, '').trim().replace(/^['"`]|['"`]$/g, '');
    if (/var\(--(radius|skin)/.test(value)) return true;
    return value.split(/\s+/).every((part) => RADIUS_PLAIN.test(part));
}

const hexHits = [];
const counts = { fontSize: {}, radius: {} };
for (const file of walk(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
        if (line.includes('design-token-ignore')) return;
        if (!HEX_ALLOWED.has(rel)) {
            for (const match of line.matchAll(/(?<![\w&$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) {
                hexHits.push(`${rel}:${index + 1} ${match[0]}`);
            }
        }
        for (const match of line.matchAll(/font-size\s*:\s*([\d.]+)px|fontSize\s*:\s*['"]?([\d.]+)(?:px)?['"]?/g)) {
            const size = Number(match[1] ?? match[2]);
            if (!FONT_SIZES.has(size)) counts.fontSize[rel] = (counts.fontSize[rel] || 0) + 1;
        }
        for (const match of line.matchAll(/border-radius\s*:\s*([^;}]+)|borderRadius\s*:\s*([^,}\n]+)/g)) {
            if (!radiusOk(match[1] ?? match[2])) counts.radius[rel] = (counts.radius[rel] || 0) + 1;
        }
    });
}

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes('--update')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify({ fontSize: sorted(counts.fontSize), radius: sorted(counts.radius) }, null, 4)}\n`);
    console.log('design lint baseline updated');
    process.exit(0);
}

assert.deepEqual(hexHits, [], `组件里出现十六进制颜色，改用设计令牌（或同一行写 design-token-ignore 说明原因）：\n${hexHits.join('\n')}`);

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const grew = [];
const shrank = [];
for (const kind of ['fontSize', 'radius']) {
    const files = new Set([...Object.keys(counts[kind]), ...Object.keys(baseline[kind] || {})]);
    for (const rel of files) {
        const now = counts[kind][rel] || 0;
        const before = (baseline[kind] || {})[rel] || 0;
        if (now > before) grew.push(`${kind} ${rel}: ${before} → ${now}`);
        else if (now < before) shrank.push(`${kind} ${rel}: ${before} → ${now}`);
    }
}
const label = { fontSize: '阶梯外字号', radius: '令牌外圆角' };
assert.deepEqual(grew, [], `新增了${grew.map((line) => label[line.split(' ')[0]]).filter((v, i, a) => a.indexOf(v) === i).join('、')}（见设计参考第 2、3 节）：\n${grew.join('\n')}`);
if (shrank.length) console.log(`提示：以下文件已减少，运行 node tests/unit/styles/test-design-lint.mjs --update 收紧基线：\n${shrank.join('\n')}`);

const total = (kind) => Object.values(counts[kind]).reduce((sum, n) => sum + n, 0);
console.log(`design lint ok (hex 0, off-scale font sizes ${total('fontSize')}, off-token radii ${total('radius')})`);
