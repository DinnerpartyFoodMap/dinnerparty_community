const express = require("express");
const router = express.Router();
const { db, isVectorSearchAvailable } = require("../../../infrastructure/database");
const { requireAuth, attachViewer } = require("../../accounts/middleware/auth");
const { hasPermission } = require("../../admin/services/adminPermissions");
const { queuePlaceVectorSync, deletePlaceVector } = require('../../preferences/services/placeVectorService');
const { normalizeImageUrls } = require('../../media/services/imageUrls');
const {
    PLACE_CATEGORY_MAX_LENGTH,
    normalizeCategoryList,
    normalizePlainTextField,
    normalizePlaceDescription,
    normalizePlaceCoordinates,
    normalizePerPersonCost,
    syncCategoryRegistry,
    createPlace
} = require('../services/placeService');
const { createPlaceRequest } = require('../services/placeRequestService');
const { nearbyCandidates, drawRecommendation, personalizeCandidates } = require('../../discovery/services/randomRecommendation');
const { getUserPreference } = require('../../preferences/services/userPreferenceService');
const { RATING_COLUMNS_SQL } = require('../../ratings/services/placeRatings');
const { viewerPlaceSql, canViewPlace } = require('../services/placeVisibility');
const { notBlockedSql } = require('../../accounts/services/userRelations');
const { afterOwnerEdit, checkOwnerEdit, reviewNote, withdrawCreationRequests } = require('../services/placeModeration');
const { listPlaces } = require('../services/placeList');
router.use((req,res,next)=>req.method==='GET'&&!req.path.endsWith('/diaries')?require('../../ratings/services/ratingSummaryAdapter').ratingsReadMiddleware(req,res,next):next());

// 列出所有地点（附带创建者和最后修改者姓名、评价人数与平均分）。
// 初筛中 / 待复核的地点只给创建者本人（见 doc/placeModeration.md），所以这几个读取接口用 attachViewer 识别观看者；
// 观看者屏蔽了的住民创建的地点也不返回（accounts/services/userRelations.js）
router.get("/", attachViewer, (req, res) => {
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE ${viewerPlaceSql('p')} AND ${notBlockedSql('p.creator_id')}
                 ORDER BY p.created_time DESC`;
    db.all(sql, [req.viewer?.id ?? null, req.viewer?.id ?? null], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 按 bounds 查询范围内地点（附带创建者和最后修改者姓名、评价人数与平均分）
router.get("/nearby", attachViewer, (req, res) => {
    const { minLng, minLat, maxLng, maxLat } = req.query;
    if (![minLng, minLat, maxLng, maxLat].every(Boolean)) return res.status(400).json({ error: "缺少范围参数" });
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE p.longitude BETWEEN ? AND ? AND p.latitude BETWEEN ? AND ? AND ${viewerPlaceSql('p')}
                   AND ${notBlockedSql('p.creator_id')}`;
    db.all(sql, [minLng, maxLng, minLat, maxLat, req.viewer?.id ?? null, req.viewer?.id ?? null], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 地点列表页（services/placeList.js）：可按标签、人均筛选，按综合评价与口味加权评价排序；不返回经纬度和地址
router.get("/list", attachViewer, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(await listPlaces(req.query, req.viewer?.id ?? null));
    } catch (error) {
        res.locals.unhandledError = error;
        res.status(500).json({ error: '地点列表加载失败，请稍后重试' });
    }
});

// Random discovery queries the full 5 km circle, independently of map zoom.
router.get("/random", (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Public discovery remains available, but a supplied identity must pass the
    // same JWT/session checks as favorites. Never accept a user ID in the query.
    if (req.get('Authorization')) return requireAuth(req, res, next);
    next();
}, async (req, res) => {
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
        let preference=null;try{if(req.user&&isVectorSearchAvailable())preference=await getUserPreference(req.user.id);}catch{}
        const personalize = (candidates) => {
            if (req.user && isVectorSearchAvailable()) {
                try {
                    return personalizeCandidates(db._raw, candidates, preference);
                } catch (error) {
                    console.warn('随机推荐偏好暂不可用，使用基础权重:', error.message);
                }
            }
            return { candidates, personalized: false };
        };
        res.json(drawRecommendation(await nearbyCandidates(db._raw, center), excludedIds, Math.random, personalize));
    } catch (error) {
        console.error('随机推荐失败', error);
        res.status(500).json({ error: '随机推荐加载失败，请稍后重试' });
    }
});

// 地点相关的公开日记片段（按日记去重计数、游标分页；只读取仍处于公开状态的快照）
router.get("/:id/diaries", attachViewer, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const place = db._raw.prepare('SELECT id, creator_id, moderation_status FROM Place WHERE id = ?').get(req.params.id);
    if (place && !canViewPlace(place, req.viewer)) return res.status(404).json({ error: '地点不存在' });
    try {
        res.json(require('../../journeys/services/journeyPublication').placeDiaries(req.params.id,
            { cursor: req.query.cursor, limit: req.query.limit, viewerId: req.viewer?.id ?? null }));
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        res.locals.unhandledError = error;
        res.status(500).json({ error: '相关日记加载失败，请稍后重试' });
    }
});

// 获取单个地点（隐藏中的地点只给创建者和管理员）
router.get("/:id", attachViewer, (req, res) => {
    const sql = `SELECT p.*, u.username AS creator_name, uu.username AS updated_by_name,${RATING_COLUMNS_SQL}
                 FROM Place p
                 LEFT JOIN User u ON p.creator_id = u.id
                 LEFT JOIN User uu ON p.updated_by = uu.id
                 WHERE p.id = ?`;
    db.get(sql, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !canViewPlace(row, req.viewer)) return res.status(404).json({ error: "地点不存在" });
        res.json(row);
    });
});

// 添加地点（网页/App；校验、分类同步、创建者评价与新地点通知在 placeService 的同一事务内完成）
router.post("/", requireAuth, async (req, res) => {
    const { name, description, latitude, longitude, category, exterior_images, menu_images, per_person_cost, address, rating } = req.body || {};
    try {
        const row = await createPlace({
            name, description, latitude, longitude, category, exterior_images, menu_images, per_person_cost, address, rating,rating_input_kind:req.body?.rating_input_kind
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
    db.get(selPlaceSql, [id], async (err, place) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!place || !canViewPlace(place, req.user)) return res.status(404).json({ error: "地点不存在" });
        const isCreator = String(place.creator_id) === String(req.user.id);
        const canManagePlaces = hasPermission(req.user, "manage_places");
        if (!isCreator && !canManagePlaces) return res.status(403).json({ error: "没有权限编辑" });
        const checkCurrentEditor=()=>{
            const editor=require('../../accounts/services/userAccess').requireWritableUser(req.user.id);
            const current=db._raw.prepare('SELECT * FROM Place WHERE id=?').get(id);
            if(!current||!canViewPlace(current,editor))throw Object.assign(new Error('地点不存在'),{status:404});
            if((String(current.creator_id)!==String(editor.id)||canManagePlaces)&&!hasPermission(editor,'manage_places'))throw Object.assign(new Error('没有权限编辑'),{status:403});
            return current;
        };

        // 要写入 Place 的列值（图片为 JSON 字符串）
        const updates = {};
        if (name != null) updates.name = name;
        if (description != null) {
            // 与新增相同：最多 1000 字，接受 HTML
            const normalizedDescription = normalizePlaceDescription(description);
            if (normalizedDescription.error) return res.status(400).json({ error: normalizedDescription.error });
            updates.description = normalizedDescription.value;
        }
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
            updates.category = normalizedCategoryList.value;
        }
        const coordinates = normalizePlaceCoordinates({
            latitude: latitude ?? undefined,
            longitude: longitude ?? undefined
        });
        if (coordinates.error) return res.status(400).json({ error: coordinates.error });
        Object.assign(updates, coordinates.value);
        if (exterior_images !== undefined) updates.exterior_images = exterior_images ? JSON.stringify(normalizeImageUrls(exterior_images)) : null;
        if (menu_images !== undefined) updates.menu_images = menu_images ? JSON.stringify(normalizeImageUrls(menu_images)) : null;
        if (per_person_cost !== undefined) {
            if (per_person_cost === null || per_person_cost === '') {
                updates.per_person_cost = null;
            } else {
                const cost = normalizePerPersonCost(per_person_cost);
                if (cost.error) return res.status(400).json({ error: cost.error });
                updates.per_person_cost = cost.value;
            }
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "没有提供要更新的字段" });

        // 创建者（非管理员）改自己已公开的地点：先过 AI 初筛（doc/placeModeration.md）。改出明显不合规的内容时
        // 这次修改不生效，转成修改申请交管理员审核，地点对所有人保持原样
        if (isCreator && !canManagePlaces && place.moderation_status === 'visible') {
            let verdict = { flagged: false };
            try {
                verdict = await checkOwnerEdit(place, updates);
            } catch (moderationError) {
                res.locals.unhandledError = moderationError;
            }
            if (verdict.flagged) {
                const proposed = Object.fromEntries(Object.entries(updates).map(([key, value]) => (
                    ['exterior_images', 'menu_images'].includes(key) ? [key, value ? JSON.parse(value) : []] : [key, value]
                )));
                try {
                    checkCurrentEditor();
                    const request = createPlaceRequest({
                        placeId: place.id, requesterId: req.user.id, proposed,
                        note: `创建者的修改未通过 AI 初筛：${reviewNote(verdict.report)}`, moderation: verdict.report
                    });
                    return res.status(202).json({
                        pending_review: true, request_id: request.id, reasons: verdict.report.decision.reasons,
                        message: '修改含有需要管理员审核的内容，已提交审核，通过后生效'
                    });
                } catch (requestError) {
                    if (requestError && requestError.publicMessage) return res.status(requestError.status || 400).json({ error: requestError.publicMessage });
                    res.locals.unhandledError = requestError;
                    return res.status(500).json({ error: '更新失败，请稍后重试' });
                }
            }
        }

        const fields = Object.keys(updates).map((key) => `${key} = ?`);
        const values = Object.values(updates);
        const semanticChanged = [name, description, category, per_person_cost]
            .some((value) => value !== undefined);
        if (semanticChanged) fields.push('has_vector = 0');

        // 更新 updated_time 和 updated_by
        const sql = `UPDATE Place SET ${fields.join(', ')}, updated_time = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`;
        values.push(req.user.id);
        values.push(id);
        try {
            await require('../../ratings/services/ratingSummaryAdapter').ensureRatingSummaries();
            db._raw.transaction(()=>{
                const current=checkCurrentEditor();
                if(['name','description','category','per_person_cost'].some(key=>current[key]!==place[key]))throw Object.assign(new Error('地点已被修改，请重新打开'),{status:409});
                syncCategoryRegistry(normalizedCategoryNames,req.user.id);
                db._raw.prepare(sql).run(...values);
                require('../services/placeRevisions').recordPlaceRevision({placeId:Number(id),authorId:req.user.id,path:isCreator?'owner_edit':'admin_edit',before:current});
            }).immediate();
        }catch(e){return res.status(e.status||500).json({error:e.publicMessage||e.message});}
        {
            // 创建者改了复核中的地点：重新初筛；改了被驳回的地点：重新提交人工复核
            if (isCreator && place.moderation_status !== 'visible') {
                try { afterOwnerEdit(id); } catch (moderationError) { res.locals.unhandledError = moderationError; }
            }
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
        }
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
        if (!place || !canViewPlace(place, req.user)) return res.status(404).json({ error: "地点不存在" });
        const isCreator = String(place.creator_id) === String(req.user.id);
        const canManagePlaces = hasPermission(req.user, "manage_places");
        if (!isCreator && !canManagePlaces) {
            return res.status(403).json({ error: "没有权限删除" });
        }
        db.run("DELETE FROM Place WHERE id = ?", [id], function (e) {
            if (e) return res.status(500).json({ error: e.message });
            if (place.moderation_status !== 'visible') withdrawCreationRequests(id);
            try { deletePlaceVector(id); } catch (vectorError) {
                console.warn(`Failed to delete vector for place ${id}:`, vectorError.message);
            }
            res.json({ success: true });
        });
    });
});

module.exports = router;
