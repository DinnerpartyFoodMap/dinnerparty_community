// 由 src/styles/tokens.json 生成网页的 CSS 变量与 iOS 原生的 Swift 常量（规格见 frontend/doc/DESIGN_SYSTEM.md）。
// 用法：npm run tokens。tests/unit/styles/test-design-tokens.mjs 会检查生成文件与 tokens.json 同步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const TOKENS_PATH = path.join(root, 'src/styles/tokens.json');
export const CSS_PATH = path.join(root, 'src/styles/tokens.generated.css');
export const SYSTEM_CSS_PATH = path.join(root, 'src/styles/tokens.system.css');
export const SWIFT_PATH = path.join(root, 'ios/App/App/DesignTokens.swift');

// 原生页面的主色 / 辅色以网页下发的住民设置为准，这些品牌色只以 theme* 默认值出现在 Swift 里
const SWIFT_SKIP_COLORS = new Set(['primary', 'primary-hover', 'primary-active', 'secondary', 'glow']);
const SWIFT_SKIP_THEME = /^(icon|.*-0-\d+)$/;

export function loadTokens() {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

const entries = (group) => Object.entries(group || {}).filter(([key]) => !key.startsWith('$'));
const modes = (value) => (typeof value === 'string' ? { light: value, dark: value } : value);

function cssBlock(selector, lines) {
    return `${selector} {\n${lines.map((line) => (line.startsWith('/*') || !line ? `    ${line}` : `    ${line};`)).join('\n').replace(/ +$/gm, '')}\n}\n`;
}

export function renderCss(tokens) {
    const light = ['/* 字体 */'];
    light.push(`--font-sans: ${tokens.font.sans}`, `--font-mono: ${tokens.font.mono}`, '');
    light.push('/* 颜色 */');
    for (const [key, value] of entries(tokens.color)) light.push(`--color-${key}: ${modes(value).light}`);
    light.push('', '/* 主题色默认值：theme.js 按住民设置覆盖 */');
    for (const [key, value] of entries(tokens.theme)) light.push(`--theme-${key}: ${modes(value).light}`);
    light.push('', '/* 阴影 */');
    for (const [key, value] of entries(tokens.shadow)) light.push(`--shadow-${key}: ${modes(value).light}`);
    light.push('', '/* 圆角 */');
    for (const [key, value] of entries(tokens.radius)) light.push(`--radius-${key}: ${value}px`);
    light.push('', '/* 间距 */');
    for (const [key, value] of entries(tokens.space)) light.push(`--space-${key}: ${value}px`);
    light.push('', '/* 字号阶梯：--text-<名> 是 font 简写，另有 -size / -line / -weight 单项 */');
    for (const [key, { size, line, weight }] of entries(tokens.text)) {
        light.push(`--text-${key}: ${weight} ${size}px/${line}px var(--font-sans)`,
            `--text-${key}-size: ${size}px`, `--text-${key}-line: ${line}px`, `--text-${key}-weight: ${weight}`);
    }
    light.push('', '/* 字重 */');
    for (const [key, value] of entries(tokens.weight)) light.push(`--weight-${key}: ${value}`);
    light.push('', '/* 层级 */');
    for (const [key, value] of entries(tokens.z)) light.push(`--z-${key}: ${value}`);

    // .fm-theme-system：还没读到住民深浅设置的界面（隐私同意页）跟随系统
    const systemScope = cssBlock('.fm-theme-system', darkLines(tokens)).trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
    return '/* 由 src/styles/tokens.json 生成（npm run tokens），不要手改。规格见 frontend/doc/DESIGN_SYSTEM.md */\n\n'
        + cssBlock(':root', light) + '\n' + cssBlock(":root[data-theme='dark']", darkLines(tokens))
        + `\n@media (prefers-color-scheme: dark) {\n${systemScope}\n}\n`;
}

function darkLines(tokens) {
    const dark = [];
    for (const [prefix, group] of [['color', tokens.color], ['theme', tokens.theme], ['shadow', tokens.shadow]]) {
        for (const [key, value] of entries(group)) {
            const { light: lightValue, dark: darkValue } = modes(value);
            if (darkValue !== lightValue) dark.push(`--${prefix}-${key}: ${darkValue}`);
        }
    }
    return dark;
}

// 没有住民深色开关的静态页（下载页、协议、隐私、技术支持）：同一组变量，深浅跟随系统
export function renderSystemCss(tokens) {
    const dark = cssBlock(':root', darkLines(tokens)).trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
    return '/* 由 src/styles/tokens.json 生成（npm run tokens），不要手改。静态页用：深浅跟随系统，不看 data-theme */\n'
        + "@import './tokens.generated.css';\n\n"
        + `@media (prefers-color-scheme: dark) {\n${dark}\n}\n`;
}

function parseColor(value) {
    const hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (hex) return { rgb: hex[1].toUpperCase(), alpha: 1 };
    const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(value);
    if (rgba) {
        const rgb = rgba.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase();
        return { rgb, alpha: Number(rgba[4]) };
    }
    throw new Error(`无法解析颜色：${value}`);
}

function swiftName(key, prefix = '') {
    const camel = key.split('-').map((part, index) => (index === 0 && !prefix ? part : part[0].toUpperCase() + part.slice(1))).join('');
    return prefix + camel;
}

export function renderSwift(tokens) {
    const colors = [];
    for (const [key, value] of entries(tokens.color)) {
        if (!SWIFT_SKIP_COLORS.has(key)) colors.push([swiftName(key), modes(value)]);
    }
    for (const [key, value] of entries(tokens.theme)) {
        if (!SWIFT_SKIP_THEME.test(key)) colors.push([swiftName(key, 'theme'), modes(value)]);
    }
    const uiLines = colors.map(([name, { light, dark }]) => {
        const l = parseColor(light);
        const d = parseColor(dark);
        return `        static let ${name} = fmDynamicColor(0x${l.rgb}, ${l.alpha}, 0x${d.rgb}, ${d.alpha})`;
    });
    const colorLines = colors.map(([name]) => `    static let ${name} = Color(uiColor: UI.${name})`);
    const radiusLines = entries(tokens.radius).map(([key, value]) => `        static let ${swiftName(key)}: CGFloat = ${value}`);
    const spaceLines = entries(tokens.space).map(([key, value]) => `        static let s${key.replace(/-/g, '_')}: CGFloat = ${value}`);
    return `// 由 src/styles/tokens.json 生成（npm run tokens），不要手改。规格见 frontend/doc/DESIGN_SYSTEM.md
import SwiftUI
import UIKit

/// 设计令牌，与网页的 tokens.generated.css 同源：颜色随浅色 / 深色界面切换。
/// 主色 / 辅色以网页下发的住民设置为准，theme* 只是缺省值；字号用系统 Dynamic Type 样式，不在这里定义。
enum FM {
    /// UIKit 用的同一组颜色（UIView.backgroundColor 等）
    enum UI {
${uiLines.join('\n')}
    }

${colorLines.join('\n')}

    enum Radius {
${radiusLines.join('\n')}
    }

    enum Space {
${spaceLines.join('\n')}
    }
}

private func fmDynamicColor(_ light: UInt32, _ lightAlpha: CGFloat, _ dark: UInt32, _ darkAlpha: CGFloat) -> UIColor {
    UIColor { traits in
        traits.userInterfaceStyle == .dark ? fmColor(dark, darkAlpha) : fmColor(light, lightAlpha)
    }
}

private func fmColor(_ value: UInt32, _ alpha: CGFloat) -> UIColor {
    UIColor(red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: alpha)
}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const tokens = loadTokens();
    fs.writeFileSync(CSS_PATH, renderCss(tokens));
    fs.writeFileSync(SYSTEM_CSS_PATH, renderSystemCss(tokens));
    fs.writeFileSync(SWIFT_PATH, renderSwift(tokens));
    console.log(`已生成 ${[CSS_PATH, SYSTEM_CSS_PATH, SWIFT_PATH].map((file) => path.relative(root, file)).join('、')}`);
}
