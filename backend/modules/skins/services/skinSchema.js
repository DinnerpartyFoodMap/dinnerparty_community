// 主题皮肤沿用旧的 InviteCode 表（code / max_uses / current_uses）作兑换码：skin_id 非空的行才是皮肤兑换码，
// 注册改用 QQ 验证码后留下的旧邀请码（skin_id 为空）永远不能兑换。
// UserSkin 是住民已解锁的皮肤（解锁后不随兑换码作废而收回），User.active_skin 是正在使用的一套，空表示默认样式。
function addMissingColumns(database, table, definitions) {
    const columns = database.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name);
    for (const definition of definitions) {
        if (!columns.includes(definition.split(' ')[0])) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
}

function initSkinSchema(database) {
    addMissingColumns(database, 'InviteCode', [
        'skin_id TEXT',
        'note TEXT',
        'created_by TEXT',
        'expires_time TEXT',
        'revoked INTEGER NOT NULL DEFAULT 0'
    ]);
    addMissingColumns(database, 'User', ['active_skin TEXT']);
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invitecode_skin_code ON InviteCode(code) WHERE skin_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_invitecode_skin_id ON InviteCode(skin_id, id DESC);
      CREATE TABLE IF NOT EXISTS UserSkin (
        user_id TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        skin_id TEXT NOT NULL,
        invite_code_id INTEGER REFERENCES InviteCode(id) ON DELETE SET NULL,
        unlocked_time TEXT NOT NULL,
        PRIMARY KEY (user_id, skin_id)
      );
    `);
}

module.exports = { initSkinSchema };
