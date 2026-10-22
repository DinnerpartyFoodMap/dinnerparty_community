// 住民反馈：类型 + 文字 + 最多 4 张截图。图片是私有 BLOB，只有管理员能读；账号删除时一并删除。
function initFeedbackSchema(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS UserFeedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'web',
        app_version TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        handled_by TEXT REFERENCES User(id) ON DELETE SET NULL,
        handled_time DATETIME,
        created_time DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_userfeedback_status ON UserFeedback(status, id DESC);
      CREATE INDEX IF NOT EXISTS idx_userfeedback_user_time ON UserFeedback(user_id, created_time);
      CREATE TABLE IF NOT EXISTS UserFeedbackImage (
        id TEXT PRIMARY KEY,
        feedback_id INTEGER NOT NULL REFERENCES UserFeedback(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        data BLOB NOT NULL,
        width INTEGER,
        height INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_userfeedbackimage_feedback ON UserFeedbackImage(feedback_id, position);
    `);
}

module.exports = { initFeedbackSchema };
