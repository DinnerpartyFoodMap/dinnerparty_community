const express = require("express");
const router = express.Router();
const { db, isVectorSearchAvailable } = require("../../../infrastructure/database");
const { requireAuth } = require("../../accounts/middleware/auth");
const { hasPermission } = require("../../admin/services/adminPermissions");
const { queuePlaceVectorSync, deletePlaceVector } = require('../../preferences/services/placeVectorService');
const { normalizeImageUrls } = require('../../media/services/imageUrls');
const {
    PLACE_CATEGORY_MAX_LENGTH,
    normalizeCategoryList,
    normalizePlainTextField,
    normalizePlaceCoordinates,
    normalizePerPersonCost,
    syncCategoryRegistry,
    createPlace
} = require('../services/placeService');
const { createPlaceRequest } = require('../services/placeRequestService');
const { nearbyCandidates, drawRecommendation, personalizeCandidates } = require('../../discovery/services/randomRecommendation');
const { getUserPreference } = require('../../preferences/services/userPreferenceService');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');

// 列出所有地点（附带创建者和最后修改者姓名、评价人数与平均分）
router.get("/", (req, res) => {
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 ORDER BY p.created_time DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 按 bounds 查询范围内地点（附带创建者和最后修改者姓名、评价人数与平均分）
router.get("/nearby", (req, res) => {
    const { minLng, minLat, maxLng, maxLat } = req.query;
    if (![minLng, minLat, maxLng, maxLat].every(Boolean)) return res.status(400).json({ error: "缺少范围参数" });
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE p.longitude BETWEEN ? AND ? AND p.latitude BETWEEN ? AND ?`;
    db.all(sql, [minLng, maxLng, minLat, maxLat], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Random discovery queries the full 5 km circle, independently of map zoom.
router.get("/random", (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Public discovery remains available, but a supplied identity must pass the
    // same JWT/session checks as favorites. Never accept a user ID in the query.
    if (req.get('Authorization')) return requireAuth(req, res, next);
    next();
}, (req, res) => {
    const coordinate = (value, limit) => typeof value === 'string' && value.trim() !== ''
        && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit;
    if (!coordinate(req.query.lat, 90) || !coordinate(req.query.lng, 180)) {
        return res.status(400).json({ error: '地图中心坐标无效' });
    }
    const rawIds = req.query.excludeIds;
    if (rawIds !== undefined && (typeof rawIds !== 'string' || !/^\d+(,\d+)?$/.test(rawIds))) {
        return res.status(400).json({ error: '最近推荐地点参数无效' });
    }
    const excludedIds = rawIds ? rawIds.split(',').map(Number) : [];
    if (excludedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        return res.status(400).json({ error: '最近推荐地点参数无效' });
    }
    res.set('Cache-Control', 'no-store');
    try {
        const center = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
        const personalize = (candidates) => {
            if (req.user && isVectorSearchAvailable()) {
                try {
                    return personalizeCandidates(db._raw, candidates, getUserPreference(req.user.id));
                } catch (error) {
                    console.warn('随机推荐偏好暂不可用，使用基础权重:', error.message);
                }
            }
            return { candidates, personalized: false };
        };
        res.json(drawRecommendation(nearbyCandidates(db._raw, center), excludedIds, Math.random, personalize));
    } catch (error) {
        console.error('随机推荐失败', error);
        res.status(500).json({ error: '随机推荐加载失败，请稍后重试' });
    }
});

// 地点相关的公开日记片段（按日记去重计数、游标分页；只读取仍处于公开状态的快照）
router.get("/:id/diaries", (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(require('../../journeys/services/journeyPublication').placeDiaries(req.params.id, { cursor: req.query.cursor, limit: req.query.limit }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        res.locals.unhandledError = error;
        res.status(500).json({ error: '相关日记加载失败，请稍后重试' });
    }
});

// 获取单个地点
router.get("/:id", (req, res) => {
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE p.id = ?`;
    db.get(sql, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "地点不存在" });
        res.json(row);
    });
});

// 添加地点（网页/App；校验、分类同步、创建者评价与新地点通知在 placeService 的同一事务内完成）
router.post("/", requireAuth, (req, res) => {
    const { name, description, latitude, longitude, category, exterior_images, menu_images, per_person_cost, address, rating } = req.body || {};
    try {
        const row = createPlace({
            name, description, latitude, longitude, category, exterior_images, menu_images, per_person_cost, address, rating
        }, req.user.id, { source: 'web' });
        res.json(row);
    } catch (error) {
        if (error && error.publicMessage) return res.status(error.status || 400).json({ error: error.publicMessage });
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '地点保存失败，请稍后重试' });
    }
});

// 在 places 路由下兼容的：为 place 提交修改申请（兼容前端或旧接口 POST /places/:id/requests）
router.post("/:id/requests", requireAuth, (req, res) => {
    const place_id = req.params.id;
    const { proposed, note } = req.body;
    const requester_id = req.user && req.user.id;
    if (!place_id || !proposed || typeof proposed !== "object") return res.status(400).json({ error: "缺少参数或 proposed 格式错误" });

    try {
        const row = createPlaceRequest({ placeId: place_id, requesterId: requester_id, proposed, note });
        return res.status(201).json(row);
    } catch (error) {
        if (error && error.publicMessage) {
            return res.status(error.status || 400).json({ error: error.publicMessage, code: error.code });
        }
        res.locals.unhandledError = error;
        return res.status(500).json({ error: '修改申请提交失败，请稍后重试' });
    }
});

// 更新地点（创建者或管理员）
router.put("/:id", requireAuth, (req, res) => {
    const id = req.params.id;
    const { name, description, category, latitude, longitude, exterior_images, menu_images, per_person_cost } = req.body;
    const selPlaceSql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name
                        FROM Place p
                        LEFT JOIN User u ON p.creator_id = u.id
                        LEFT JOIN User uu ON p.updated_by = uu.id
                        WHERE p.id = ?`;
    db.get(selPlaceSql, [id], (err, place) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!place) return res.status(404).json({ error: "地点不存在" });
        const isCreator = String(place.creator_id) === String(req.user.id);
        const canManagePlaces = hasPermission(req.user, "manage_places");
        if (!isCreator && !canManagePlaces) return res.status(403).json({ error: "没有权限编辑" });

        const fields = [];
        const values = [];
        if (name != null) { fields.push("name = ?"); values.push(name); }
        if (description != null) { fields.push("description = ?"); values.push(description); }
        let normalizedCategoryNames = null;
        if (category != null) {
            const normalizedCategory = normalizePlainTextField(category, {
                fieldLabel: "分类",
                maxLength: PLACE_CATEGORY_MAX_LENGTH
            });
            if (normalizedCategory.error) return res.status(400).json({ error: normalizedCategory.error });
            const normalizedCategoryList = normalizeCategoryList(normalizedCategory.value);
            if (normalizedCategoryList.error) return res.status(400).json({ error: normalizedCategoryList.error });
            normalizedCategoryNames = normalizedCategoryList.names;
            fields.push("category = ?");
            values.push(normalizedCategoryList.value);
        }
        const coordinates = normalizePlaceCoordinates({
            latitude: latitude ?? undefined,
            longitude: longitude ?? undefined
        });
        if (coordinates.error) return res.status(400).json({ error: coordinates.error });
        for (const [key, value] of Object.entries(coordinates.value)) { fields.push(`${key} = ?`); values.push(value); }
        if (exterior_images !== undefined) { fields.push("exterior_images = ?"); values.push(exterior_images ? JSON.stringify(normalizeImageUrls(exterior_images)) : null); }
        if (menu_images !== undefined) { fields.push("menu_images = ?"); values.push(menu_images ? JSON.stringify(normalizeImageUrls(menu_images)) : null); }
        if (per_person_cost !== undefined) {
            if (per_person_cost === null || per_person_cost === '') {
                fields.push("per_person_cost = ?"); values.push(null);
            } else {
                const cost = normalizePerPersonCost(per_person_cost);
                if (cost.error) return res.status(400).json({ error: cost.error });
                fields.push("per_person_cost = ?"); values.push(cost.value);
            }
        }
        const semanticChanged = [name, description, category, per_person_cost]
            .some((value) => value !== undefined);
        if (semanticChanged) fields.push('has_vector = 0');
        if (fields.length === 0) return res.status(400).json({ error: "没有提供要更新的字段" });

        // 更新 updated_time 和 updated_by
        const sql = `UPDATE Place SET ${fields.join(', ')}, updated_time = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`;
        values.push(req.user.id);
        values.push(id);
        try {
            syncCategoryRegistry(normalizedCategoryNames, req.user.id);
        } catch (categoryError) {
            return res.status(500).json({ error: `分类目录同步失败：${categoryError.message}` });
        }
        db.run(sql, values, function (e) {
            if (e) return res.status(500).json({ error: e.message });
            const sel = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                         FROM Place p
                         LEFT JOIN User u ON p.creator_id = u.id
                         LEFT JOIN User uu ON p.updated_by = uu.id
                         WHERE p.id = ?`;
            db.get(sel, [id], (e2, row) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json(row);
                if (semanticChanged) setImmediate(() => queuePlaceVectorSync(id));
            });
        });
    });
});

// 删除地点（仅创建者或管理员）
router.delete("/:id", requireAuth, (req, res) => {
    const id = req.params.id;
    const selPlaceSql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name
                        FROM Place p
                        LEFT JOIN User u ON p.creator_id = u.id
                        LEFT JOIN User uu ON p.updated_by = uu.id
                        WHERE p.id = ?`;
    db.get(selPlaceSql, [id], (err, place) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!place) return res.status(404).json({ error: "地点不存在" });
        const isCreator = String(place.creator_id) === String(req.user.id);
        const canManagePlaces = hasPermission(req.user, "manage_places");
        if (!isCreator && !canManagePlaces) {
            return res.status(403).json({ error: "没有权限删除" });
        }
        db.run("DELETE FROM Place WHERE id = ?", [id], function (e) {
            if (e) return res.status(500).json({ error: e.message });
            try { deletePlaceVector(id); } catch (vectorError) {
                console.warn(`Failed to delete vector for place ${id}:`, vectorError.message);
            }
            res.json({ success: true });
        });
    });
});

module.exports = router;
