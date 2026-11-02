// 设计令牌：生成文件与 tokens.json 同步、主题色默认值与 theme.js 一致、关键文字配色达到对比度要求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS_PATH, SWIFT_PATH, loadTokens, renderCss, renderSwift } from '../../../scripts/build-design-tokens.mjs';
import {
    DEFAULT_DARK_PRIMARY, DEFAULT_DARK_SECONDARY, DEFAULT_PRIMARY, DEFAULT_SECONDARY,
    contrastRatio, pickContrastTextColor, readableTextColor
} from '../../../src/theme/theme.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tokens = loadTokens();

assert.equal(fs.readFileSync(CSS_PATH, 'utf8'), renderCss(tokens), 'tokens.generated.css 与 tokens.json 不同步：运行 npm run tokens');
assert.equal(fs.readFileSync(SWIFT_PATH, 'utf8'), renderSwift(tokens), 'DesignTokens.swift 与 tokens.json 不同步：运行 npm run tokens');

// 令牌只有一份来源：index.html 不再自带颜色变量，入口经 tokens.css 引入生成文件
assert.ok(!/--color-bg-base\s*:/.test(read('index.html')), 'index.html 不应再定义颜色令牌');
assert.match(read('index.html'), /font-family:\s*var\(--font-sans\)/);
assert.match(read('src/main.jsx'), /import ["']\.\/styles\/tokens\.css["']/);
assert.match(read('src/styles/tokens.css'), /@import '\.\/tokens\.generated\.css';/);

// Swift 文件加入了 Xcode 工程，重新生成工程时补丁脚本也会补上
const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj');
assert.ok(pbxproj.includes('/* DesignTokens.swift in Sources */,'), 'DesignTokens.swift 要加入 Xcode 工程的 Sources');
assert.ok(read('scripts/patch-native-projects.mjs').includes("['DesignTokens.swift',"), 'patch-native-projects.mjs 要登记 DesignTokens.swift');

const value = (group, key, mode) => {
    const entry = tokens[group][key];
    return typeof entry === 'string' ? entry : entry[mode];
};

for (const mode of ['light', 'dark']) {
    const color = (key) => value('color', key, mode);
    const theme = (key) => value('theme', key, mode);
    const backgrounds = ['bg-base', 'bg-surface', 'bg-overlay'].map(color);
    const atLeast = (foreground, bgs, min, label) => {
        for (const bg of bgs) {
            const ratio = contrastRatio(foreground, bg);
            assert.ok(ratio >= min, `${mode} ${label} ${foreground} 在 ${bg} 上只有 ${ratio.toFixed(2)}:1（至少 ${min}）`);
        }
    };

    // 主题色默认值与 theme.js 一致，派生值与 theme.js 的计算一致
    assert.equal(theme('primary'), mode === 'light' ? DEFAULT_PRIMARY : DEFAULT_DARK_PRIMARY);
    assert.equal(theme('secondary'), mode === 'light' ? DEFAULT_SECONDARY : DEFAULT_DARK_SECONDARY);
    assert.equal(theme('primary'), color('primary'));
    assert.equal(theme('secondary'), color('secondary'));
    assert.equal(theme('on-primary'), pickContrastTextColor(theme('primary')));
    assert.equal(theme('primary-text').toUpperCase(),
        readableTextColor(theme('primary'), [color('bg-surface'), color('bg-overlay')]).toUpperCase());

    atLeast(color('text-primary'), backgrounds, 4.5, 'text-primary');
    atLeast(color('text-secondary'), backgrounds, 4.5, 'text-secondary');
    atLeast(color('text-muted'), backgrounds, 3, 'text-muted（只用于占位符与禁用态）');
    for (const tone of ['success', 'warning', 'danger', 'info']) {
        atLeast(color(`${tone}-text`), [color('bg-surface'), color('bg-overlay')], 4.5, `${tone}-text`);
    }
    atLeast(theme('primary-text'), [color('bg-surface'), color('bg-overlay')], 4.5, 'theme primary-text');
    atLeast(theme('on-primary'), [theme('primary')], 4.5, 'theme on-primary');
}

// 自定义主题色：很浅或很深的颜色也能得到可读的文字色
for (const [primary, bgs] of [['#FFE066', ['#FFFFFF', '#F2EEF5']], ['#1E2A78', ['#1A1625', '#251F34']]]) {
    const text = readableTextColor(primary, bgs);
    for (const bg of bgs) assert.ok(contrastRatio(text, bg) >= 4.5, `${primary} → ${text} 在 ${bg} 上不达标`);
}
assert.equal(readableTextColor('#2B2533', ['#FFFFFF']), '#2B2533', '本来就达标的颜色原样返回');

console.log('design tokens ok');
