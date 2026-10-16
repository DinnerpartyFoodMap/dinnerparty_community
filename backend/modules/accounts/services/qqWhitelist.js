const { db } = require('../../../infrastructure/database');

// Registration whitelist writes shared by the admin page and the QQ Bot member
// sync. Both only ever add numbers; removal stays an explicit admin action.
const WHITELIST_QQ_PATTERN = /^\d{5,15}$/;

/** Inserts numbers that are not yet whitelisted. Call inside a transaction. */
function insertWhitelistNumbers(qqList) {
    const added = [];
    const skipped = [];
    const insert = db._raw.prepare('INSERT OR IGNORE INTO QQWhitelist (qq) VALUES (?)');
    for (const qqNum of qqList) {
        if (!WHITELIST_QQ_PATTERN.test(qqNum)) {
            skipped.push({ qq: qqNum, reason: '格式无效' });
            continue;
        }
        const info = insert.run(qqNum);
        if (info.changes === 1) added.push(qqNum);
        else skipped.push({ qq: qqNum, reason: '已存在' });
    }
    return { added, skipped };
}

/** Numbers from the list that are not whitelisted yet (read-only, for dry runs). */
function missingWhitelistNumbers(qqList) {
    const exists = db._raw.prepare('SELECT 1 FROM QQWhitelist WHERE qq = ?');
    return qqList.filter((qq) => WHITELIST_QQ_PATTERN.test(qq) && !exists.get(qq));
}

module.exports = { WHITELIST_QQ_PATTERN, insertWhitelistNumbers, missingWhitelistNumbers };
