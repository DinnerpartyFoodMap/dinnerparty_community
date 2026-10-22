const { randomUUID } = require('crypto');
const sharp = require('sharp');
const { db } = require('../../../infrastructure/database');

// 反馈类型：取值与前端 src/feedback/feedbackTypes.js 一致（显示文字在前端 i18n）
const FEEDBACK_TYPES = Object.freeze(['bug', 'suggestion', 'report', 'account', 'other']);
const FEEDBACK_STATUSES = Object.freeze(['open', 'resolved']);
const PLATFORMS = new Set(['web', 'android', 'ios']);
const LIMITS = Object.freeze({
    contentLength: 2000,
    images: 4,
    imageBytes: 10 * 1024 * 1024,
    perDay: 10
});

class FeedbackError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// 截图可能含个人信息，只存在库里、仅管理员可读：统一摆正方向、缩到 2048 内并转 WebP（同时去掉拍摄位置等元数据）
async function encodeImage(buffer) {
    try {
        const { data, info } = await sharp(buffer, { limitInputPixels: 40000000, animated: false })
            .rotate()
            .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
    } catch {
        throw new FeedbackError('图片无法读取或像素过大');
    }
}

function clean(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

const insertFeedback = db._raw.transaction(({ userId, type, content, platform, appVersion, userAgent, images }) => {
    const recent = db._raw.prepare("SELECT COUNT(*) AS n FROM UserFeedback WHERE user_id = ? AND created_time >= datetime('now', '-1 day')").get(userId).n;
    if (recent >= LIMITS.perDay) throw new FeedbackError(`24 小时内最多提交 ${LIMITS.perDay} 条反馈，请稍后再试`, 429);
    const id = Number(db._raw.prepare(`INSERT INTO UserFeedback (user_id, type, content, platform, app_version, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, type, content, platform, appVersion, userAgent).lastInsertRowid);
    const addImage = db._raw.prepare('INSERT INTO UserFeedbackImage (id, feedback_id, position, data, width, height) VALUES (?, ?, ?, ?, ?, ?)');
    images.forEach((image, position) => addImage.run(randomUUID(), id, position, image.data, image.width, image.height));
    return id;
});

/** 提交一条反馈：先校验文字，再逐张转码图片，最后在一个事务里写入（限流计数也在事务里） */
async function submitFeedback({ userId, body = {}, files = [], userAgent = '' }) {
    const type = clean(body.type, 32);
    if (!FEEDBACK_TYPES.includes(type)) throw new FeedbackError('请选择反馈类型');
    // multipart 表单会把换行规范成 CRLF，统一成 \n 再计长度
    const content = typeof body.content === 'string' ? body.content.replace(/\r\n?/g, '\n').trim() : '';
    if (!content) throw new FeedbackError('请填写反馈内容');
    if (content.length > LIMITS.contentLength) throw new FeedbackError(`反馈内容最多 ${LIMITS.contentLength} 字`);
    if (files.length > LIMITS.images) throw new FeedbackError(`最多上传 ${LIMITS.images} 张图片`);
    const platform = PLATFORMS.has(body.platform) ? body.platform : 'web';
    const images = [];
    for (const file of files) images.push(await encodeImage(file.buffer));
    return insertFeedback.immediate({
        userId, type, content, platform,
        appVersion: clean(body.app_version, 32),
        userAgent: clean(userAgent, 300),
        images
    });
}

/** 管理端列表：按状态 / 类型筛选，新的在前 */
function listFeedback({ status = 'open', type = '', page = 1, pageSize = 20 } = {}) {
    const where = [], params = [];
    if (FEEDBACK_STATUSES.includes(status)) { where.push('f.status = ?'); params.push(status); }
    if (FEEDBACK_TYPES.includes(type)) { where.push('f.type = ?'); params.push(type); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.min(Math.max(Number.parseInt(pageSize, 10) || 20, 1), 50);
    const current = Math.max(Number.parseInt(page, 10) || 1, 1);
    const total = db._raw.prepare(`SELECT COUNT(*) AS n FROM UserFeedback f ${clause}`).get(...params).n;
    const rows = db._raw.prepare(`SELECT f.id, f.user_id, f.type, f.content, f.platform, f.app_version, f.user_agent, f.status,
            f.created_time, f.handled_time, u.username, u.qq, h.username AS handler_username
        FROM UserFeedback f
        LEFT JOIN User u ON u.id = f.user_id
        LEFT JOIN User h ON h.id = f.handled_by
        ${clause} ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(...params, size, (current - 1) * size);
    const imagesOf = db._raw.prepare('SELECT id, width, height FROM UserFeedbackImage WHERE feedback_id = ? ORDER BY position');
    const counts = Object.fromEntries(FEEDBACK_STATUSES.map((value) => [value, 0]));
    for (const row of db._raw.prepare('SELECT status, COUNT(*) AS n FROM UserFeedback GROUP BY status').all()) counts[row.status] = row.n;
    return {
        items: rows.map((row) => ({ ...row, images: imagesOf.all(row.id) })),
        total, page: current, pageSize: size, counts
    };
}

function getImage(imageId) {
    return db._raw.prepare('SELECT data FROM UserFeedbackImage WHERE id = ?').get(String(imageId || ''));
}

function getFeedback(id) {
    return db._raw.prepare('SELECT id, user_id, type, status FROM UserFeedback WHERE id = ?').get(Number(id));
}

module.exports = { FEEDBACK_TYPES, FEEDBACK_STATUSES, LIMITS, FeedbackError, submitFeedback, listFeedback, getImage, getFeedback };
