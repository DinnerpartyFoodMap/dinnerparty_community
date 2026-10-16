#!/usr/bin/env node
// CI 专用：只把 App 目标的 Release 配置改为手动签名（不影响 SPM 依赖包目标）。
// 用法：node scripts/ci/ios-manual-signing.mjs <TEAM_ID> <PROVISIONING_PROFILE_NAME>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [teamId, profileName] = process.argv.slice(2);
if (!teamId || !profileName) {
    console.error('用法：node scripts/ci/ios-manual-signing.mjs <TEAM_ID> <PROVISIONING_PROFILE_NAME>');
    process.exit(1);
}
const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../ios/App/App.xcodeproj/project.pbxproj');
const text = readFileSync(file, 'utf8');
let patched = 0;
const result = text.replace(/(\/\* Release \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n(?:\t\t\tbaseConfigurationReference = [^\n]*\n)?\t\t\tbuildSettings = \{\n)([\s\S]*?)(\n\t\t\t\};\n\t\t\tname = Release;)/g, (match, head, body, tail) => {
    if (!body.includes('INFOPLIST_FILE = App/Info.plist;')) return match;
    patched += 1;
    const cleaned = body
        .replace(/\n\t\t\t\tCODE_SIGN_STYLE = [^;]+;/, '')
        .replace(/\n\t\t\t\tDEVELOPMENT_TEAM = [^;]+;/, '')
        .replace(/\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = [^;]+;/, '')
        .replace(/\n\t\t\t\t"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = [^;]+;/, '');
    const settings = [
        'CODE_SIGN_STYLE = Manual;',
        `DEVELOPMENT_TEAM = ${teamId};`,
        `PROVISIONING_PROFILE_SPECIFIER = "${profileName.replace(/"/g, '\\"')}";`,
        '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";'
    ].map((line) => `\t\t\t\t${line}`).join('\n');
    return `${head}${settings}\n${cleaned.replace(/^\n/, '')}${tail}`;
});
if (patched !== 1) {
    console.error(`未找到唯一的 App 目标 Release 配置（匹配 ${patched} 处），请检查 Xcode 工程`);
    process.exit(1);
}
writeFileSync(file, result);
console.log('App 目标 Release 已切换为手动签名');
