const fs = require('node:fs');
const path = require('node:path');
const { backendPath } = require('../../../infrastructure/paths');

// App 更新检查与安卓安装包下载（见 ../doc/README.md）。发版信息是服务器本地的 JSON（默认 backend/app-release/release.json，
// 可用 APP_RELEASE_DIR 改目录），改了即时生效、不用重启：
//   { "android": { "build": 24, "version": "2.2.4", "notes": "更新说明", "file": "dinnerparty-2.2.4.apk" },
//     "ios":     { "build": 24, "version": "2.2.4", "notes": "更新说明", "url": "https://testflight.apple.com/join/..." } }
// 客户端拿自己的构建号（Android versionCode / iOS CFBundleVersion）与 build 比较，小于它就提示更新。
const PLATFORMS = Object.freeze(['android', 'ios']);
const DEFAULT_IOS_URL = 'https://testflight.apple.com/join/9wshzYCG';
const MAX_NOTES = 2000;

function releaseDir() {
    const configured = String(process.env.APP_RELEASE_DIR || '').trim();
    return configured ? path.resolve(configured) : backendPath('app-release');
}

let cache = null;

function readReleaseFile() {
    const file = path.join(releaseDir(), 'release.json');
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return {}; }
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.value;
    let value = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') value = parsed;
    } catch (error) {
        console.warn('app-release/release.json is not valid JSON:', error.message);
    }
    cache = { file, mtimeMs: stat.mtimeMs, value };
    return value;
}

/** 安装包只能是发版目录里的 .apk 文件名（不能带路径） */
function apkPath(fileName) {
    const name = String(fileName || '');
    if (!/^[\w.-]+\.apk$/i.test(name)) return null;
    const full = path.join(releaseDir(), name);
    try {
        return fs.statSync(full).isFile() ? full : null;
    } catch (_) {
        return null;
    }
}

function platformRelease(platform, raw) {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const build = Number.isSafeInteger(entry.build) && entry.build > 0 ? entry.build : null;
    const result = {
        build,
        version: typeof entry.version === 'string' ? entry.version.slice(0, 40) : null,
        notes: typeof entry.notes === 'string' ? entry.notes.slice(0, MAX_NOTES) : ''
    };
    if (platform === 'android') {
        result.available = !!apkPath(entry.file);
    } else {
        const url = typeof entry.url === 'string' && /^https:\/\//.test(entry.url) ? entry.url : DEFAULT_IOS_URL;
        result.url = url;
        result.available = true;
    }
    return result;
}

function getReleases() {
    const raw = readReleaseFile();
    return Object.fromEntries(PLATFORMS.map((platform) => [platform, platformRelease(platform, raw[platform])]));
}

function androidApk() {
    const raw = readReleaseFile();
    const entry = raw.android && typeof raw.android === 'object' ? raw.android : {};
    const full = apkPath(entry.file);
    return full ? { path: full, name: path.basename(full) } : null;
}

module.exports = { PLATFORMS, DEFAULT_IOS_URL, releaseDir, getReleases, androidApk, platformRelease };
