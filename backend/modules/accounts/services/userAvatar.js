const { removeAvatarImage } = require('../../media/services/imageStorage');
const logger = require('../../../infrastructure/logger');

function avatarColumns(table = '') {
    const prefix = table ? `${table}.` : '';
    return `${prefix}avatar_url, (${prefix}avatar_blob IS NOT NULL) AS has_avatar`;
}

function avatarFields(row, userId = row.id) {
    const url = row.avatar_url || (row.has_avatar ? `/users/${encodeURIComponent(userId)}/avatar/legacy` : null);
    return { has_avatar: Boolean(url), avatar_url: url };
}

function withAvatarFields(row) {
    return row ? { ...row, ...avatarFields(row) } : row;
}

async function cleanupAvatarImage(url, userId) {
    if (!url) return;
    try {
        await removeAvatarImage(url);
    } catch (error) {
        logger.warn('Failed to delete avatar from OSS', { event: 'account.avatar.cleanup_failed', userId, url, error });
    }
}

module.exports = { avatarColumns, avatarFields, withAvatarFields, cleanupAvatarImage };
