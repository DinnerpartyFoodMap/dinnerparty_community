const path = require('node:path');
const router = require('express').Router();
const { getReleases, androidApk, apkPath } = require('../services/appRelease');

// 带版本号的安装包内容永远不变：CDN（ESA）与浏览器缓存一年，发新版换文件名，不用刷新 CDN
const IMMUTABLE = 'public, max-age=31536000, immutable';

// 两端最新的构建号、版本号与更新说明（App 启动时检查更新、/home 下载页）
router.get('/release', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(getReleases());
});

// 安卓安装包的固定入口：跳到当前版本自己的地址。跳转本身不缓存，发版后立即指向新包
router.get('/android/latest.apk', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const apk = androidApk();
    if (!apk) return res.status(404).json({ error: '安装包暂未上传' });
    // 相对地址：经反向代理加了 /backend 前缀时也落在同一目录
    return res.redirect(302, apk.name);
});

// 发版目录里的安装包（只能是文件名，见 services/appRelease.js 的 apkPath），支持断点续传
router.get('/android/:file', (req, res) => {
    const full = apkPath(req.params.file);
    if (!full) return res.status(404).json({ error: '安装包不存在' });
    res.set('Cache-Control', IMMUTABLE);
    res.type('application/vnd.android.package-archive');
    res.download(full, path.basename(full), (error) => {
        if (error && !res.headersSent) {
            res.set('Cache-Control', 'no-store');
            res.status(500).json({ error: '安装包下载失败' });
        }
    });
});

module.exports = router;
