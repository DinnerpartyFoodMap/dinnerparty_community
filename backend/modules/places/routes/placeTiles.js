'use strict';

// 地图标记分层瓦片（services/placeTiles.js，说明见 ../doc/README.md#分层瓦片）：
//   GET /places/tiles/manifest              清单：每块瓦片的内容哈希。公共缓存 30 / 60 秒
//   GET /places/tiles/ticket                登录住民的明细瓦片票据（no-store）
//   GET /places/tiles/<哈希>/dict           标签名、地区名字典。公共缓存，永不过期
//   GET /places/tiles/<哈希>/<z>/<x>/<y>    z 为 2 / 5 / 8：聚合瓦片，公共缓存，永不过期；
//                                           z 为 12：明细瓦片，按 IP / 账号限流（tiles 策略），只在浏览器缓存
// 公共缓存头由 http/middleware/publicCache.js 统一设置，这里只给明细瓦片设 private。
// 哈希和当前内容对不上（清单旧了）时 302 到当前哈希；瓦片已经没有了回 404。

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../accounts/middleware/auth');
const { consume, sendLimited } = require('../../../http/middleware/rateLimit');
const tiles = require('../services/placeTiles');
const logger = require('../../../infrastructure/logger');

const HASH = /^[0-9a-f]{12}$/;
const AGGREGATE_TILE_ZOOMS = new Set(tiles.AGGREGATE_LEVELS.map((level) => level.tile));

router.use((req, res, next) => (req.method === 'GET' && req.path !== '/ticket'
    ? require('../../ratings/services/ratingSummaryAdapter').ratingsReadMiddleware(req, res, next)
    : next()));

function sendFile(req, res, file, etagPrefix) {
    const encoding = req.acceptsEncodings('br') ? 'br' : (req.acceptsEncodings('gzip') ? 'gzip' : 'identity');
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('ETag', `W/"${etagPrefix}-${file.hash}"`);
    res.vary('Accept-Encoding');
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    // ETag 已设：If-None-Match 对得上时 res.send 回 304
    return res.send(tiles.compressed(file, encoding));
}

function fail(res, error) {
    res.locals.unhandledError = error;
    res.removeHeader('Content-Encoding');
    res.set('Cache-Control', 'no-store');
    return res.status(500).json({ error: '地点加载失败，请稍后重试' });
}

router.get('/manifest', (req, res) => {
    try {
        const snapshot = tiles.tileSnapshot();
        return sendFile(req, res, snapshot.manifestFile, 'tm');
    } catch (error) {
        return fail(res, error);
    }
});

router.get('/ticket', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(tiles.signTicket(req.user));
});

router.get('/:hash/dict', (req, res) => {
    if (!HASH.test(req.params.hash)) return res.status(404).json({ error: '不存在' });
    try {
        const file = tiles.tileSnapshot().files.get('dict');
        if (file.hash !== req.params.hash) {
            res.set('Cache-Control', 'no-store');
            return res.redirect(302, `../${file.hash}/dict`);
        }
        return sendFile(req, res, file, 'td');
    } catch (error) {
        return fail(res, error);
    }
});

router.get('/:hash/:z/:x/:y', async (req, res) => {
    const { hash } = req.params;
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const isLeaf = z === tiles.LEAF_LEVEL.tile;
    if (!HASH.test(hash) || !(isLeaf || AGGREGATE_TILE_ZOOMS.has(z)) || ![x, y].every((v) => Number.isSafeInteger(v) && v >= 0 && v < 2 ** z)) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: '不存在' });
    }
    let file;
    try {
        file = tiles.tileSnapshot().files.get(`${z}/${x}/${y}`);
    } catch (error) {
        return fail(res, error);
    }
    if (!file) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: '不存在' });
    }
    if (file.hash !== hash) {
        // 清单旧了：转到当前内容（保留票据参数）；不计额度，跳转后的请求再计
        res.set('Cache-Control', 'no-store');
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(302, `../../../${file.hash}/${z}/${x}/${y}${query}`);
    }
    if (isLeaf) {
        const viewer = tiles.verifyTicket(req.query.t);
        if (viewer) {
            req.rateSubject = viewer;
            logger.addContext({ userId: viewer.id });
        }
        const result = await consume('tiles', req, `${x}/${y}`);
        if (result.limited) return sendLimited(res, result);
        // 内容哈希在 URL 里：同一台设备同一版本只回源一次；不进 CDN，源站才数得到每个 IP / 账号拿了多少块
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
    }
    return sendFile(req, res, file, 'tt');
});

module.exports = router;
