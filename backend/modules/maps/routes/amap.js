'use strict';

/**
 * 服务端代调高德 Web 服务（REST）接口。
 *
 * 前端此前直接持有 Web 服务 key 调用 restapi.amap.com（逆地理编码、静态地图）。
 * 现在统一收口到这里，由服务端从环境变量 AMAP_WEB_SERVICE_KEY 读取 key；
 * JS API key + 安全密钥（AMAP_JS_CODE，经 /_AMapService 注入）仍由地图 SDK 使用，两者分开管理。
 */

const express = require('express');
const logger = require('../../../infrastructure/logger');

const router = express.Router();
// Search owns its validation, budget and errors; do not gate it through the
// unrelated regeo/staticmap rate limiter or hide missing configuration as no data.
router.use('/search', require('./amapSearch').createAmapSearchRouter());
const AMAP_REST_BASE = 'https://restapi.amap.com';
const REQUEST_TIMEOUT_MS = 8000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 90;
const rateBuckets = new Map();

function webServiceKey() {
    return String(process.env.AMAP_WEB_SERVICE_KEY || '').trim();
}

function rateLimited(req) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
        rateBuckets.set(key, { startedAt: now, count: 1 });
        if (rateBuckets.size > 5000) {
            for (const [k, v] of rateBuckets) if (now - v.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(k);
        }
        return false;
    }
    bucket.count += 1;
    return bucket.count > RATE_LIMIT;
}

function parseLocation(value) {
    const match = /^\s*(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,2}(?:\.\d+)?)\s*$/.exec(String(value || ''));
    if (!match) return null;
    const lng = Number(match[1]);
    const lat = Number(match[2]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

async function fetchAmap(path, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const query = new URLSearchParams({ ...params, key: webServiceKey() });
        return await fetch(`${AMAP_REST_BASE}${path}?${query}`, { signal: controller.signal, redirect: 'error' });
    } finally {
        clearTimeout(timer);
    }
}

// 地图 SDK 的 JS API key 是公开值，由后端下发，更换时只需改 backend/.env 并重启，
// 网页无需重新构建、App 无需发版。它与 AMAP_JS_CODE 属于同一个“Web端(JS API)”应用，须一起更换。
// 放在下方 Web 服务 key 检查之前：两者是不同的凭证。
router.get('/js-config', (req, res) => {
    const key = String(process.env.AMAP_JS_KEY || '').trim();
    if (!key) return res.status(503).json({ error: '地图服务未配置（AMAP_JS_KEY）' });
    // no-cache：浏览器每次用 ETag 重新校验，换 key 后下次打开页面即生效
    res.set('Cache-Control', 'no-cache');
    return res.json({ key });
});

router.use((req, res, next) => {
    if (!webServiceKey()) {
        return res.status(503).json({ error: '地图 Web 服务未配置（AMAP_WEB_SERVICE_KEY）' });
    }
    if (rateLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    return next();
});

// 逆地理编码：仅返回格式化地址，避免把高德原始响应（含 key 相关信息）透传给客户端。
router.get('/regeo', async (req, res) => {
    const location = parseLocation(req.query.location);
    if (!location) return res.status(400).json({ error: '无效的坐标' });
    try {
        const upstream = await fetchAmap('/v3/geocode/regeo', { location, extensions: 'base' });
        const data = await upstream.json().catch(() => null);
        if (!upstream.ok || !data || String(data.status) !== '1') {
            logger.warn('AMap regeo failed', { event: 'amap.regeo.failed', status: upstream.status, info: data && data.info });
            return res.status(502).json({ error: '逆地理编码失败' });
        }
        const address = data.regeocode && typeof data.regeocode.formatted_address === 'string'
            ? data.regeocode.formatted_address
            : '';
        res.set('Cache-Control', 'public, max-age=86400');
        return res.json({ formatted_address: address });
    } catch (error) {
        logger.warn('AMap regeo request error', { event: 'amap.regeo.error', error });
        return res.status(502).json({ error: '地图服务暂时不可用' });
    }
});

// 静态地图：供海报导出使用，参数白名单校验后转发图片。
router.get('/staticmap', async (req, res) => {
    const location = parseLocation(req.query.location);
    const zoom = Number(req.query.zoom);
    const size = String(req.query.size || '');
    const scale = String(req.query.scale || '1');
    if (!location || !Number.isInteger(zoom) || zoom < 1 || zoom > 17) return res.status(400).json({ error: '无效的地图参数' });
    if (!/^\d{2,4}\*\d{2,4}$/.test(size)) return res.status(400).json({ error: '无效的地图尺寸' });
    if (!/^[12]$/.test(scale)) return res.status(400).json({ error: '无效的缩放倍率' });
    try {
        const upstream = await fetchAmap('/v3/staticmap', {
            location,
            zoom: String(zoom),
            size,
            scale,
            traffic: req.query.traffic === '1' ? '1' : '0'
        });
        const contentType = upstream.headers.get('content-type') || '';
        if (!upstream.ok || !contentType.startsWith('image/')) {
            const body = await upstream.text().catch(() => '');
            logger.warn('AMap staticmap failed', { event: 'amap.staticmap.failed', status: upstream.status, body: body.slice(0, 200) });
            return res.status(502).json({ error: '静态地图生成失败' });
        }
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=3600');
        return res.send(buffer);
    } catch (error) {
        logger.warn('AMap staticmap request error', { event: 'amap.staticmap.error', error });
        return res.status(502).json({ error: '地图服务暂时不可用' });
    }
});

module.exports = router;
