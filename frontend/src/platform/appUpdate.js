// App 更新检查的比较规则（app/components/AppUpdatePrompt.jsx）：本机构建号（Android versionCode、iOS CFBundleVersion）
// 与服务器 GET /api/app/release 里这一端的 build 比较。

/** 服务器上的构建号比本机大时需要更新（构建号是正整数；读不出来时不提示） */
export function needsUpdate(localBuild, release) {
    const local = Number.parseInt(String(localBuild ?? ''), 10);
    const latest = Number(release && release.build);
    return Number.isSafeInteger(local) && local > 0 && Number.isSafeInteger(latest) && latest > local;
}
