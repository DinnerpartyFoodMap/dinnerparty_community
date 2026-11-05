const express = require("express");
const router = express.Router();
const { db } = require("../../../infrastructure/database");
const { requireAuth } = require("../../accounts/middleware/auth");

// 获取某地点的评论
router.get("/place/:placeId", (req, res) => {
    const { placeId } = req.params;
    db.all("SELECT c.*,u.username AS username FROM Comment c JOIN Place p ON p.id=c.place_id LEFT JOIN User u ON u.id=c.user_id WHERE c.place_id = ? AND p.moderation_status='visible'"+(req.query.kind==='edit'?" AND c.place_revision_id IS NOT NULL":"")+" ORDER BY c.time DESC,c.id DESC", [placeId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 添加评论
router.post("/", requireAuth, (req, res) => {
    const { place_id, content, rating } = req.body;
    if (!place_id || typeof content!=='string' || !content.trim() || content.length>5000) return res.status(400).json({ error: "请填写5000字以内的评论" });
    db.get("SELECT id FROM Place WHERE id = ? AND (moderation_status = 'visible' OR creator_id = ?)", [place_id, req.user.id], (placeErr, place) => {
        if (placeErr) return res.status(500).json({ error: placeErr.message });
        if (!place) return res.status(404).json({ error: "地点不存在" });

        db.run("INSERT INTO Comment (place_id, user_id, content, rating) VALUES (?, ?, ?, ?)",
            [place_id, req.user.id, content, rating || null],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                try{require('../../ratings/services/ratingTextEvidence').queueComment({commentId:this.lastID,userId:req.user.id,placeId:Number(place_id),text:content});}catch{/* The comment remains saved if evidence collection is unavailable. */}
                db.get("SELECT * FROM Comment WHERE id = ?", [this.lastID], (e, row) => {
                    if (e) return res.status(500).json({ error: e.message });
                    res.json(row);
                });
            });
    });
});

module.exports = router;
