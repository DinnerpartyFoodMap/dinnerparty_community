'use strict';

// 跳转解析（公开只读，无鉴权）：Micro 带 ?venue=<key> 过来，前端问「这个场馆落点了吗」。
// 只回状态与坐标；label / address / city 一律不出，避免把对端数据变成公开接口。
const express = require('express');
const router = express.Router();
const venues = require('../services/venues');

router.get('/:key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = String(req.params.key || '').trim();
    if (!venues.EXTERNAL_KEY.test(key)) return res.status(400).json({ error: 'key 格式错误' });
    try {
        return res.json(venues.resolve(key));
    } catch (error) {
        res.locals.unhandledError = error;
        return res.status(503).json({ error: '场馆信息暂时不可用', requestId: res.locals.requestId });
    }
});

module.exports = router;
