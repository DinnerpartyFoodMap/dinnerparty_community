// Turns OneBot 11 message segments into what the bot acts on: plain text,
// whether the bot was @-mentioned, the quoted message id and a native location.

// QQ's location share arrives as a `json` segment from the Tencent Map app, e.g.
// {"app":"com.tencent.map","view":"LocationShare","meta":{"Location.Search":
//   {"name":"…","address":"…","lat":"23.050701","lng":"113.401693"}}}
// Tencent Map coordinates are GCJ-02, the same system the website stores.
function parseCoordinate(value, bound) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) > bound) return null;
    return n;
}

function locationFrom(name, address, lat, lng, source) {
    const latitude = parseCoordinate(lat, 90);
    const longitude = parseCoordinate(lng, 180);
    // 0,0 is what an empty card would decode to; never accept it as a shop location.
    if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return { invalid: true, source };
    return {
        lat: latitude,
        lng: longitude,
        name: String(name || '').trim().slice(0, 120),
        address: String(address || '').trim().slice(0, 250),
        source
    };
}

function findLocationObject(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    const hasLat = node.lat !== undefined || node.latitude !== undefined;
    const hasLng = node.lng !== undefined || node.lon !== undefined || node.longitude !== undefined;
    if (hasLat && hasLng) return node;
    for (const value of Object.values(node)) {
        const found = findLocationObject(value, depth + 1);
        if (found) return found;
    }
    return null;
}

function parseLocationCard(raw) {
    let card;
    try {
        card = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return null;
    }
    if (!card || typeof card !== 'object') return null;
    const isLocationCard = card.app === 'com.tencent.map' || card.view === 'LocationShare'
        || !!(card.meta && card.meta['Location.Search']);
    if (!isLocationCard) return null;
    const data = (card.meta && card.meta['Location.Search']) || findLocationObject(card.meta) || {};
    return locationFrom(
        data.name || data.title,
        data.address || data.desc,
        data.lat ?? data.latitude,
        data.lng ?? data.lon ?? data.longitude,
        'qq_location_card'
    );
}

function parseMessage(event, selfId) {
    const segments = Array.isArray(event && event.message) ? event.message : [];
    const textParts = [];
    let atSelf = false;
    let replyId = null;
    let location = null;
    let hasMedia = false;
    for (const segment of segments) {
        const data = (segment && segment.data) || {};
        switch (segment && segment.type) {
            case 'text':
                textParts.push(String(data.text || ''));
                break;
            case 'at':
                if (selfId && String(data.qq) === String(selfId)) atSelf = true;
                break;
            case 'reply':
                if (data.id != null) replyId = String(data.id);
                break;
            case 'json': {
                const parsed = parseLocationCard(data.data);
                if (parsed) location = parsed;
                break;
            }
            case 'location':
                location = locationFrom(data.title, data.content, data.lat, data.lon ?? data.lng, 'onebot_location');
                break;
            default:
                hasMedia = true;
        }
    }
    if (!segments.length && typeof event?.raw_message === 'string') textParts.push(event.raw_message);
    return {
        text: textParts.join('').replace(/\s+/g, ' ').trim(),
        rawText: textParts.join('').trim(),
        atSelf,
        replyId,
        location,
        hasMedia
    };
}

const COMMAND_PREFIX = /^[!！]\s*/;
const COMMAND_ALIASES = {
    帮助: 'help', help: 'help', 指令: 'help',
    添加地点: 'add', 添加: 'add', 创建地点: 'add', 创建: 'add', 新建地点: 'add', 新建: 'add', add: 'add',
    店名: 'name',
    描述: 'description',
    定位: 'location', 位置: 'location',
    人均: 'cost',
    tag: 'tags', tags: 'tags', 标签: 'tags',
    标签列表: 'tag_list', 分类: 'tag_list',
    跳过: 'skip',
    草稿: 'draft', 继续: 'resume',
    提交: 'submit',
    确认提交: 'confirm', 确认: 'confirm',
    取消: 'cancel',
    查询: 'search', 搜索: 'search', search: 'search', find: 'search',
    随机中心: 'random_center', 设置随机中心: 'random_center',
    随机: 'random', 随机地点: 'random', 随机推荐: 'random', 随机美食: 'random', 吃什么: 'random', 今天吃什么: 'random',
    roll: 'random', rand: 'random', random: 'random'
};
// Longest first so "标签列表" wins over "标签" and "确认提交" over "确认".
const COMMAND_WORDS = Object.keys(COMMAND_ALIASES).sort((a, b) => b.length - a.length);
// Whole-message phrases accepted without a prefix (private chat, or group with @bot).
const BARE_PHRASES = { 帮助: 'help' };

/**
 * Returns { name, args, word } for a command, { name: 'unknown', word } for an
 * unrecognised "!" message, or null for ordinary text.
 */
function parseCommand(text, { allowBare = false } = {}) {
    const value = String(text || '').trim();
    if (!value) return null;
    if (COMMAND_PREFIX.test(value)) {
        const rest = value.replace(COMMAND_PREFIX, '');
        const lower = rest.toLowerCase();
        for (const word of COMMAND_WORDS) {
            if (!lower.startsWith(word.toLowerCase())) continue;
            const tail = rest.slice(word.length);
            // ASCII words need a boundary ("!tagx" is not "!tag"); Chinese words may be glued to their argument.
            if (/^[a-z]+$/i.test(word) && tail && !/^\s/.test(tail)) continue;
            return { name: COMMAND_ALIASES[word], args: tail.trim(), word };
        }
        return { name: 'unknown', args: '', word: rest.split(/\s+/)[0] || '' };
    }
    if (allowBare && BARE_PHRASES[value]) return { name: BARE_PHRASES[value], args: '', word: value };
    return null;
}

module.exports = { parseMessage, parseLocationCard, parseCommand, COMMAND_ALIASES, COMMAND_PREFIX };
