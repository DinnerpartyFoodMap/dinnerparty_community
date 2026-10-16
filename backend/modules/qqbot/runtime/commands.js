const { db } = require('../../../infrastructure/database');
const logger = require('../../../infrastructure/logger');
const botConfig = require('./config');
const { parseCommand, COMMAND_PREFIX } = require('./messageParser');
const conversation = require('./placeConversation');
const interpreter = require('./commandInterpreter');
const { pickRandomPlace } = require('./randomPick');
const { fastSearch } = require('../../discovery/services/placeSearch');
const { EMPTY_MESSAGE } = require('../../discovery/services/randomRecommendation');

// Routes one incoming message to a reply list. Commands always win over free
// text, so help/query/cancel are never stored as a shop name or description.
// A reply is { text, ... } or { card: { placeId } } (a place card sent as its own message).
const SEARCH_LIMIT = 5;
const SEARCH_QUERY_MAX_LENGTH = 50;
const SENDER_SEARCH_INTERVAL_MS = 3000;
const GROUP_SEARCH_WINDOW_MS = 60 * 1000;
const GROUP_SEARCH_LIMIT = 8;
const searchBuckets = new Map();

// DeepSeek calls for fuzzy commands: per sender and for the whole bot.
const AI_SENDER_INTERVAL_MS = 2000;
const AI_SENDER_WINDOW_MS = 10 * 60 * 1000;
const AI_SENDER_LIMIT = 15;
const AI_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const AI_GLOBAL_LIMIT = 300;
const aiBuckets = new Map();
let aiGlobal = { startedAt: 0, count: 0 };

// Commands that only make sense on an existing draft (`!定位` also records your own position).
const DRAFT_COMMANDS = new Set(['name', 'description', 'cost', 'tags', 'skip', 'draft', 'submit', 'cancel']);
const COMMAND_WORDS = {
    search: '查询', random: '随机', help: '帮助', tag_list: '标签列表', name: '店名', description: '描述',
    cost: '人均', tags: 'tag', location: '定位', skip: '跳过', draft: '草稿', submit: '提交', cancel: '取消'
};

const HELP_TEXT = [
    '饭桶 Bot 帮助：',
    '',
    '!添加地点：添加地点',
    '!查询 (关键词)：查询已有地点',
    '!随机 / !roll：随机推荐 5 km 内的地点',
    '!定位：记录你的位置，作为随机推荐的中心',
    '',
    '以上指令!/！均可，也可以直接说，例如：!创建xx餐厅，人均60，菜很正宗',
    '群内发送店名、描述时，请回复 Bot 的提问或 @Bot。'
].join('\n');

function shorten(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// Searches and random picks share one budget.
function consumeQueryQuota(ctx) {
    const now = ctx.now.getTime();
    if (searchBuckets.size > 2000) {
        for (const [key, bucket] of searchBuckets) {
            if (now - bucket.startedAt > GROUP_SEARCH_WINDOW_MS) searchBuckets.delete(key);
        }
    }
    const senderKey = `sender:${ctx.senderQq}`;
    const sender = searchBuckets.get(senderKey);
    if (sender && now - sender.startedAt < SENDER_SEARCH_INTERVAL_MS) return false;
    if (ctx.isGroup) {
        const groupKey = `group:${ctx.chatId}`;
        const group = searchBuckets.get(groupKey);
        if (group && now - group.startedAt < GROUP_SEARCH_WINDOW_MS) {
            if (group.count >= GROUP_SEARCH_LIMIT) return false;
            group.count += 1;
        } else {
            searchBuckets.set(groupKey, { startedAt: now, count: 1 });
        }
    }
    searchBuckets.set(senderKey, { startedAt: now, count: 1 });
    return true;
}

function consumeAiQuota(ctx) {
    const now = ctx.now.getTime();
    if (now - aiGlobal.startedAt >= AI_GLOBAL_WINDOW_MS) aiGlobal = { startedAt: now, count: 0 };
    if (aiGlobal.count >= AI_GLOBAL_LIMIT) return false;
    if (aiBuckets.size > 2000) {
        for (const [key, bucket] of aiBuckets) if (now - bucket.startedAt >= AI_SENDER_WINDOW_MS) aiBuckets.delete(key);
    }
    let bucket = aiBuckets.get(ctx.senderQq);
    if (!bucket || now - bucket.startedAt >= AI_SENDER_WINDOW_MS) bucket = { startedAt: now, count: 0, lastAt: -Infinity };
    if (now - bucket.lastAt < AI_SENDER_INTERVAL_MS || bucket.count >= AI_SENDER_LIMIT) return false;
    bucket.count += 1;
    bucket.lastAt = now;
    aiBuckets.set(ctx.senderQq, bucket);
    aiGlobal.count += 1;
    return true;
}

function formatSearchResults(query, rows) {
    if (!rows.length) return `没有找到与「${query}」相关的地点，换个关键词试试。`;
    const lines = [`「${query}」找到 ${rows.length} 个地点：`];
    rows.forEach((place, index) => {
        const head = [place.name];
        if (place.per_person_cost) head.push(`人均 ${place.per_person_cost} 元`);
        if (place.category) head.push(place.category.split(/,\s*/).join('、'));
        lines.push(`${index + 1}. ${head.join(' · ')}`);
        if (place.description) lines.push(`   ${shorten(place.description, 40)}`);
        if (place.address) lines.push(`   地址：${shorten(place.address, 60)}`);
        const link = botConfig.placeUrl(place.id);
        if (link) lines.push(`   ${link}`);
    });
    return lines.join('\n');
}

function search(ctx, args) {
    const query = String(args || '').trim().slice(0, SEARCH_QUERY_MAX_LENGTH);
    if (!query) return [{ text: '用法：!查询 关键词（按店名、标签、描述匹配，最多 5 条）' }];
    if (!consumeQueryQuota(ctx)) return ctx.isGroup ? [] : [{ text: '查询太频繁了，请稍后再试。' }];
    const rows = fastSearch(query, SEARCH_LIMIT);
    const replies = [{ text: formatSearchResults(query, rows) }];
    // The first result also goes out as a link card.
    if (rows.length) replies.push({ card: { placeId: rows[0].id } });
    return replies;
}

function distanceText(km) {
    return km < 1 ? `${Math.max(1, Math.round(km * 1000))} 米` : `${km.toFixed(1)} km`;
}

function formatRandomPick(result) {
    const centerText = result.centerSource === 'user'
        ? `你上次定位的位置${result.centerLabel ? `（${shorten(result.centerLabel, 20)}）` : ''}`
        : result.centerLabel;
    const centerHint = result.centerSource === 'user' ? ''
        : result.registered
            ? '在网站或 App 的地图上点“定位”，或私聊发我 QQ 位置后，会改为以你的位置为中心。'
            : '注册网站账号并填写本人 QQ 后，可以按你的位置推荐。';
    if (!result.place) {
        return [`以${centerText}为中心，${EMPTY_MESSAGE}。`, centerHint].filter(Boolean).join('\n');
    }
    const place = result.place;
    const lines = [`🎲 随机推荐：${place.name}`];
    const meta = [];
    if (place.per_person_cost) meta.push(`人均 ${place.per_person_cost} 元`);
    if (place.category) meta.push(place.category.split(/,\s*/).join('、'));
    if (meta.length) lines.push(meta.join(' · '));
    if (place.description) lines.push(shorten(place.description, 60));
    if (place.address) lines.push(`地址：${shorten(place.address, 60)}`);
    lines.push(`距${centerText} ${distanceText(result.distanceKm)}`);
    const link = botConfig.placeUrl(place.id);
    if (link) lines.push(link);
    if (centerHint) lines.push('', centerHint);
    lines.push('换一家：!随机');
    return lines.join('\n');
}

function randomPick(ctx) {
    if (!consumeQueryQuota(ctx)) return ctx.isGroup ? [] : [{ text: '太频繁了，请稍后再试。' }];
    const result = pickRandomPlace(ctx);
    const replies = [{ text: formatRandomPick(result) }];
    if (result.place) replies.push({ card: { placeId: result.place.id } });
    return replies;
}

function commonTagNames() {
    return db._raw.prepare('SELECT name FROM Category WHERE is_common = 1 ORDER BY sort_order, name LIMIT 40').all().map((r) => r.name);
}

function tagList() {
    const common = commonTagNames();
    const popular = db._raw.prepare(`SELECT name FROM Category WHERE is_common = 0 ORDER BY sort_order, created_time DESC LIMIT 20`).all();
    const lines = ['常用标签：', common.join('、') || '（暂无）'];
    if (popular.length) lines.push('', '其他已有标签：', popular.map((r) => r.name).join('、'));
    lines.push('', '用 !tag 快餐,避雷 设置；也可以写新的标签（每个不超过 8 个汉字）。');
    return [{ text: lines.join('\n') }];
}

function dispatch(ctx, command) {
    switch (command.name) {
        case 'help': return [{ text: HELP_TEXT }];
        case 'search': return search(ctx, command.args);
        case 'random': return randomPick(ctx);
        case 'tag_list': return tagList();
        case 'add': return conversation.startDraft(ctx);
        case 'cancel': return conversation.cancelDraft(ctx);
        case 'draft':
        case 'resume': return conversation.showDraft(ctx);
        case 'name': return conversation.setField(ctx, 'name', command.args);
        case 'description': return conversation.setField(ctx, 'description', command.args);
        case 'cost': return conversation.setField(ctx, 'cost', command.args);
        case 'tags': return conversation.setField(ctx, 'tags', command.args);
        case 'location': return conversation.requestLocation(ctx);
        case 'skip': return conversation.skipStep(ctx);
        case 'submit': return conversation.preparePreview(ctx);
        case 'confirm': {
            const code = command.args.replace(/\s+/g, '');
            const viaReply = !code && !!ctx.parsed.replyId;
            return conversation.confirmSubmission(ctx, { code, viaReply });
        }
        default:
            // Unknown "!" words in a group may belong to another bot; only answer when addressed.
            if (ctx.isGroup && !ctx.parsed.atSelf) return [];
            return [{ text: `未知指令「${shorten(command.word, 12)}」，发送 !帮助 查看可用指令。` }];
    }
}

/**
 * ctx: { botId, chatType: 'private'|'group', chatId, senderQq, isGroup, parsed, now }
 * Synchronous: exact commands and conversation steps only (no DeepSeek).
 */
function handle(ctx) {
    const { parsed, isGroup } = ctx;
    const command = parseCommand(parsed.text, { allowBare: !isGroup || parsed.atSelf });
    if (command) return dispatch(ctx, command);

    const draft = conversation.loadActiveDraft(ctx);
    // Quoting the preview with "确认提交" confirms without a code; quoting a stale one explains why not.
    if (draft && parsed.replyId && /^确认(提交)?$/.test(parsed.text)) {
        return conversation.confirmSubmission(ctx, { viaReply: true });
    }
    if (parsed.location) return conversation.onLocation(ctx, draft);
    const greeting = '你好！发送 !添加地点 开始添加，或发送 !帮助 查看全部指令。';
    if (!parsed.text) return isGroup && parsed.atSelf && !draft ? [{ text: greeting }] : [];
    const replies = conversation.onText(ctx, draft);
    if (replies) return replies;
    // No draft: answer only when spoken to directly.
    if (!isGroup || parsed.atSelf) return [{ text: greeting }];
    return [];
}

async function askInterpreter(ctx, text, interpret) {
    if (!botConfig.get().ai.enabled || !consumeAiQuota(ctx)) return null;
    const draft = conversation.loadActiveDraft(ctx);
    try {
        const result = await interpret({ text, hasDraft: !!draft, draftStep: draft ? draft.step : null, knownTags: commonTagNames() });
        return result ? { result, draft } : null;
    } catch (error) {
        logger.warn('QQ bot command interpretation failed', { event: 'qqbot.ai.failed', error });
        return null;
    }
}

// Without DeepSeek, a short plain argument is taken as the shop name.
function plainNamePrefill(args) {
    const value = String(args || '').trim();
    return value.length <= 30 && !/[，,。；;！!？?\s]/.test(value) ? { name: value } : null;
}

/** `!添加地点 <long text>` / `!创建xx餐厅，人均60…`: recognise the details, then ask for what is missing. */
async function addFromText(ctx, args, interpret) {
    // An open draft or a missing account is answered without spending a DeepSeek call.
    if (conversation.loadActiveDraft(ctx)) return conversation.startDraft(ctx);
    const blocked = conversation.startDraftBlocked(ctx);
    if (blocked) return blocked;
    const asked = await askInterpreter(ctx, ctx.parsed.text.replace(COMMAND_PREFIX, ''), interpret);
    const prefill = asked && asked.result.command === 'add' && asked.result.place ? asked.result.place : plainNamePrefill(args);
    const note = prefill ? '' : '（没能自动识别附加信息，请按提示逐项填写。）';
    return conversation.startDraft(ctx, { prefill, note });
}

/** A "!" message that matches no command: let DeepSeek pick one, or fall back to the usual answer. */
async function interpretUnknown(ctx, interpret) {
    const rest = ctx.parsed.text.replace(COMMAND_PREFIX, '');
    if (!/[\p{L}\p{N}]/u.test(rest)) return null;
    const asked = await askInterpreter(ctx, rest, interpret);
    if (!asked) return null;
    const { result, draft } = asked;
    if (result.command === 'none') return null;
    if (DRAFT_COMMANDS.has(result.command) && !draft) return null;
    if (result.command === 'add') {
        return draft ? conversation.startDraft(ctx) : conversation.startDraft(ctx, { prefill: result.place });
    }
    const replies = dispatch(ctx, { name: result.command, args: result.args || '', word: rest });
    // Say how the message was understood, so the exact command is learnt along the way.
    const word = COMMAND_WORDS[result.command];
    if (word && replies[0] && replies[0].text) {
        const shown = `!${word}${result.args && ['search', 'name', 'description', 'cost', 'tags'].includes(result.command) ? ` ${shorten(result.args, 20)}` : ''}`;
        replies[0] = { ...replies[0], text: `（已理解为 ${shown}）\n${replies[0].text}` };
    }
    return replies;
}

/** Entry point for the bot: exact commands first, DeepSeek only for what they cannot place. */
async function handleMessage(ctx, { interpret = interpreter.interpretCommand } = {}) {
    const { parsed, isGroup } = ctx;
    const command = parseCommand(parsed.text, { allowBare: !isGroup || parsed.atSelf });
    if (command && command.name === 'add' && command.args) return addFromText(ctx, command.args, interpret);
    if (command && command.name === 'unknown') {
        const replies = await interpretUnknown(ctx, interpret);
        if (replies) return replies;
    }
    return handle(ctx);
}

function resetLimitsForTesting() {
    searchBuckets.clear();
    aiBuckets.clear();
    aiGlobal = { startedAt: 0, count: 0 };
}

module.exports = {
    handle,
    handleMessage,
    formatSearchResults,
    formatRandomPick,
    HELP_TEXT,
    _resetRateLimitsForTesting: resetLimitsForTesting
};
