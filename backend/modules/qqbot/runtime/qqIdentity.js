const { db } = require('../../../infrastructure/database');
const { isBanActive, refreshBanState } = require('../../accounts/services/userAccess');
const { QQ_PATTERN } = require('./config');

// The website account for a QQ sender is found only through User.qq, using the
// sender id from the authenticated OneBot event — never text the user typed.
function normalizeQQ(value) {
    const text = String(value == null ? '' : value).trim();
    return QQ_PATTERN.test(text) ? text : '';
}

function findUsersByQQ(qq) {
    return db._raw.prepare(
        'SELECT id, username, is_banned, ban_reason, ban_expires FROM User WHERE qq = ? LIMIT 2'
    ).all(qq);
}

function classify(rows, { banCheck }) {
    if (rows.length === 0) return { status: 'unregistered' };
    // Never pick one of several accounts sharing a QQ; an admin has to fix the data.
    if (rows.length > 1) return { status: 'duplicate' };
    const user = rows[0];
    if (banCheck(user)) return { status: 'banned', user, reason: user.ban_reason || null };
    return { status: 'ok', user };
}

/** For conversation steps: lifts expired bans like website login does. */
function resolveQQUser(qqValue) {
    const qq = normalizeQQ(qqValue);
    if (!qq) return { status: 'invalid' };
    return classify(findUsersByQQ(qq), { banCheck: (user) => refreshBanState(user) });
}

/** Inside a write transaction: read-only check, an expired ban simply does not block. */
function resolveQQUserForWrite(qqValue) {
    const qq = normalizeQQ(qqValue);
    if (!qq) return { status: 'invalid' };
    return classify(findUsersByQQ(qq), { banCheck: (user) => isBanActive(user) });
}

function identityMessage(identity, registerUrl) {
    switch (identity.status) {
        case 'unregistered':
        case 'invalid':
            return `你的 QQ 还没有对应的网站账号。请先在网站注册并填写本人 QQ 号，再来添加地点${registerUrl ? `：${registerUrl}` : '。'}`;
        case 'duplicate':
            return '你的 QQ 对应了多个网站账号，暂时无法确定作者，请联系管理员处理。';
        case 'banned':
            return `你的网站账号目前处于受限状态，不能新增地点${identity.reason ? `（原因：${identity.reason}）` : ''}。`;
        default:
            return '';
    }
}

module.exports = { normalizeQQ, resolveQQUser, resolveQQUserForWrite, identityMessage };
