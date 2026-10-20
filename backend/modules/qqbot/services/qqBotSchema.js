// QQ Bot tables. Additive only: existing users, places and whitelist rows are untouched.
// Timestamps are ISO-8601 UTC strings so they compare correctly as text.
function initQQBotSchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS QQBotDraft (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        bot_id TEXT NOT NULL, chat_type TEXT NOT NULL, chat_id TEXT NOT NULL, sender_qq TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        step TEXT NOT NULL,
        fields TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        preview_version INTEGER, preview_code TEXT, preview_request_id TEXT, preview_message_id TEXT,
        preview_duplicates TEXT, preview_expires_at TEXT,
        bot_message_ids TEXT NOT NULL DEFAULT '[]',
        place_id INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_qqbot_draft_active ON QQBotDraft(conversation_key) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_qqbot_draft_status_expiry ON QQBotDraft(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_qqbot_draft_conversation ON QQBotDraft(conversation_key, updated_at);

      CREATE TABLE IF NOT EXISTS QQBotSubmission (
        request_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE,
        draft_version INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        place_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS QQBotNotification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        place_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        message_id TEXT,
        last_error TEXT,
        source TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(place_id, group_id, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_qqbot_notification_due ON QQBotNotification(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS QQBotSyncState (
        group_id TEXT PRIMARY KEY,
        mode TEXT,
        status TEXT,
        member_count INTEGER,
        added_count INTEGER,
        missing_count INTEGER,
        missing_sample TEXT,
        last_error TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS QQBotInboundMessage (
        dedupe_key TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qqbot_inbound_received ON QQBotInboundMessage(received_at);

      -- Codes the bot sends by private message for registration and password reset.
      -- status: sending -> sent -> used, or failed; only the newest sent row per qq+purpose is valid.
      CREATE TABLE IF NOT EXISTS QQVerificationCode (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        qq TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sending',
        attempts INTEGER NOT NULL DEFAULT 0,
        ip TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_qq_verification_qq ON QQVerificationCode(qq, created_at);
      CREATE INDEX IF NOT EXISTS idx_qq_verification_ip ON QQVerificationCode(ip, created_at);
      CREATE INDEX IF NOT EXISTS idx_qq_verification_created ON QQVerificationCode(created_at);

      -- !随机 centre per group, set in the group with !随机中心 or through the admin API.
      -- Groups without a row use the sender's last position, then QQ_BOT_RANDOM_CENTER.
      CREATE TABLE IF NOT EXISTS QQBotGroupRandomCenter (
        group_id TEXT PRIMARY KEY,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        label TEXT NOT NULL,
        source TEXT NOT NULL,
        place_id INTEGER,
        set_by TEXT,
        updated_at TEXT NOT NULL
      );
    `);
}

module.exports = { initQQBotSchema };
