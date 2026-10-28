const router = require('express').Router();
const { getReleases, androidApk } = require('../services/appRelease');

// 两端最新的构建号、版本号与更新说明（App 启动时检查更新、/home 下载页）
router.get('/release', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(getReleases());
});

// 安卓安装包（存在服务器本地的发版目录）
router.get('/android/latest.apk', (req, res) => {
    const apk = androidApk();
    if (!apk) return res.status(404).json({ error: '安装包暂未上传' });
    res.set('Cache-Control', 'no-cache');
    res.type('application/vnd.android.package-archive');
    res.download(apk.path, apk.name, (error) => {
        if (error && !res.headersSent) res.status(500).json({ error: '安装包下载失败' });
    });
});

module.exports = router;
