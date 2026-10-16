// QQ Bot settings, read from backend/.env. Each feature has its own switch so
// commands, whitelist writes and group pushes can be enabled independently.
const QQ_PATTERN = /^[1-9]\d{4,14}$/;
const WHITELIST_MODES = new Set(['off', 'dry-run', 'on']);
// !随机 for people without a recorded position (and for unregistered QQ users).
const DEFAULT_RANDOM_CENTER = { lat: 23.016488, lng: 113.394404 };
const DEFAULT_RANDOM_CENTER_NAME = 'B记鱼粥';
// Place cards: tuwen = QQ's 图文 link card (OIDB 0xdc2_34 via send_packet, opens the map),
// miniapp = NapCat get_mini_app_ark (opens the template mini app), link = the /p/<id>
// share link on its own (QQ desktop unfurls it from the share page's tags), off = none.
const CARD_MODES = new Set(['tuwen', 'miniapp', 'link', 'off']);
const MINIAPP_TEMPLATES = new Set(['bili', 'weibo']);

let override = null;
let cached = null;

function parseBoolean(value, fallback) {
    if (value == null || String(value).trim() === '') return fallback;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseIdList(value) {
    return [...new Set(String(value || '')
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter((item) => QQ_PATTERN.test(item)))];
}

function parseInterval(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

// "lat,lng" in GCJ-02, as stored on places.
function parseCenter(value) {
    const parts = String(value || '').split(/[\s,，]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const [lat, lng] = parts.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
}

// Group links must point at the public site; a Windows-local or app-local
// origin would be useless (or misleading) to everyone else in the group.
function normalizePublicWebUrl(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return { url: '', error: '未配置 QQ_BOT_PUBLIC_WEB_URL' };
    let parsed;
    try { parsed = new URL(text); } catch (_) { return { url: '', error: 'QQ_BOT_PUBLIC_WEB_URL 不是有效网址' }; }
    const host = parsed.hostname.toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
        || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '[::1]';
    if (parsed.protocol !== 'https:' || local) {
        return { url: '', error: 'QQ_BOT_PUBLIC_WEB_URL 必须是公网 HTTPS 地址' };
    }
    return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
}

function load(env = process.env) {
    const notifyGroupIds = parseIdList(env.QQ_BOT_NOTIFY_GROUP_IDS);
    const commandGroupIds = env.QQ_BOT_COMMAND_GROUP_IDS == null
        ? notifyGroupIds
        : parseIdList(env.QQ_BOT_COMMAND_GROUP_IDS);
    const whitelistMode = String(env.QQ_BOT_WHITELIST_MODE || 'dry-run').trim().toLowerCase();
    const publicWeb = normalizePublicWebUrl(env.QQ_BOT_PUBLIC_WEB_URL || env.FRONTEND_BASE_URL);
    const randomCenter = parseCenter(env.QQ_BOT_RANDOM_CENTER);
    const cardMode = String(env.QQ_BOT_CARD_MODE || 'tuwen').trim().toLowerCase();
    const miniappTemplate = String(env.QQ_BOT_CARD_MINIAPP || 'bili').trim().toLowerCase();
    return {
        enabled: parseBoolean(env.QQ_BOT_ENABLED, false),
        wsUrl: String(env.QQ_BOT_WS_URL || 'ws://127.0.0.1:3001').trim(),
        accessToken: String(env.QQ_BOT_ACCESS_TOKEN || '').trim(),
        selfId: QQ_PATTERN.test(String(env.QQ_BOT_SELF_ID || '').trim()) ? String(env.QQ_BOT_SELF_ID).trim() : '',
        publicWebUrl: publicWeb.url,
        publicWebUrlError: publicWeb.error || null,
        commands: {
            enabled: parseBoolean(env.QQ_BOT_COMMANDS_ENABLED, true),
            privateEnabled: parseBoolean(env.QQ_BOT_PRIVATE_ENABLED, true),
            groupIds: commandGroupIds
        },
        whitelist: {
            mode: WHITELIST_MODES.has(whitelistMode) ? whitelistMode : 'dry-run',
            groupIds: parseIdList(env.QQ_BOT_SYNC_GROUP_IDS),
            intervalMs: parseInterval(env.QQ_BOT_SYNC_INTERVAL_MS, 2 * 60 * 60 * 1000, 10 * 60 * 1000, 24 * 60 * 60 * 1000)
        },
        notify: {
            enabled: parseBoolean(env.QQ_BOT_NOTIFY_ENABLED, false),
            groupIds: notifyGroupIds
        },
        // Fuzzy "!" commands and add-place extraction through DeepSeek (needs DEEPSEEK_API_KEY).
        ai: { enabled: parseBoolean(env.QQ_BOT_AI_ENABLED, true) },
        random: {
            center: randomCenter || DEFAULT_RANDOM_CENTER,
            centerName: String(env.QQ_BOT_RANDOM_CENTER_NAME || '').trim().slice(0, 40)
                || (randomCenter ? '默认中心' : DEFAULT_RANDOM_CENTER_NAME)
        },
        card: {
            mode: CARD_MODES.has(cardMode) ? cardMode : 'tuwen',
            miniappTemplate: MINIAPP_TEMPLATES.has(miniappTemplate) ? miniappTemplate : 'bili'
        }
    };
}

function get() {
    if (override) return override;
    if (!cached) cached = load();
    return cached;
}

function setForTesting(value) {
    override = value ? { ...load({}), ...value } : null;
}

// Links shown in QQ: the map opens the place from `/?place=<id>`.
function placeUrl(placeId) {
    const base = get().publicWebUrl;
    return base ? `${base}/?place=${encodeURIComponent(placeId)}` : '';
}

// The share page: link-card tags for QQ, then a redirect to the map.
function placeShareUrl(placeId) {
    const base = get().publicWebUrl;
    return base ? `${base}/p/${encodeURIComponent(placeId)}` : '';
}

function siteUrl() {
    return get().publicWebUrl ? `${get().publicWebUrl}/` : '';
}

module.exports = { QQ_PATTERN, DEFAULT_RANDOM_CENTER, load, get, setForTesting, placeUrl, placeShareUrl, siteUrl, parseIdList, parseCenter, normalizePublicWebUrl };
