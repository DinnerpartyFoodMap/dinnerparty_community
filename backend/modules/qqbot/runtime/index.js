const logger = require('../../../infrastructure/logger');
const { db } = require('../../../infrastructure/database');
const botConfig = require('./config');
const { OneBotClient } = require('./onebotClient');
const { parseMessage } = require('./messageParser');
const commands = require('./commands');
const conversation = require('./placeConversation');
const { normalizeQQ } = require('./qqIdentity');
const { MemberSync, syncStates } = require('./memberSync');
const { NotificationWorker, notificationSummary } = require('./notificationWorker');
const { sendPlaceCard } = require('./placeCard');

// QQ Bot inside the backend process. NapCat runs separately; a missing or
// broken connection never blocks the website, it only pauses bot features.
const sql = db._raw;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;
const INBOUND_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_REPLY_LENGTH = 3000;

let instance = null;

function publicConfig(config) {
    return {
        wsUrl: config.wsUrl,
        selfId: config.selfId || null,
        publicWebUrl: config.publicWebUrl || null,
        publicWebUrlError: config.publicWebUrlError,
        commands: config.commands,
        whitelist: { mode: config.whitelist.mode, groupIds: config.whitelist.groupIds, intervalMs: config.whitelist.intervalMs },
        notify: config.notify
    };
}

function getQQBotStatus() {
    const config = botConfig.get();
    return {
        enabled: config.enabled,
        running: !!instance,
        connection: instance ? instance.client.status() : null,
        config: publicConfig(config),
        sync: syncStates(),
        notifications: notificationSummary()
    };
}

// Only messages that can matter to the bot are recorded; ordinary group chatter is ignored outright.
function mayConcernBot(parsed, isGroup) {
    if (!isGroup) return true;
    return /^[!！]/.test(parsed.text) || parsed.atSelf || !!parsed.replyId || !!parsed.location;
}

function claimInbound(key) {
    return sql.prepare('INSERT OR IGNORE INTO QQBotInboundMessage (dedupe_key, received_at) VALUES (?, ?)')
        .run(key, new Date().toISOString()).changes === 1;
}

function startQQBot() {
    const config = botConfig.get();
    if (!config.enabled) {
        logger.info('QQ bot disabled', { event: 'qqbot.disabled' });
        return null;
    }
    if (instance) return instance;
    if (!config.accessToken) {
        logger.error('QQ bot not started: QQ_BOT_ACCESS_TOKEN is required', { event: 'qqbot.config.invalid' });
        return null;
    }
    if (!config.selfId) {
        logger.warn('QQ_BOT_SELF_ID is not set; any logged-in NapCat account will be accepted', { event: 'qqbot.config.no_self_id' });
    }
    if (config.publicWebUrlError) {
        logger.warn('QQ bot links disabled', { event: 'qqbot.config.public_url', reason: config.publicWebUrlError });
    }

    const client = new OneBotClient({
        url: config.wsUrl,
        accessToken: config.accessToken,
        expectedSelfId: config.selfId,
        logger
    });
    const memberSync = new MemberSync({ client, getConfig: botConfig.get, logger });
    const worker = new NotificationWorker({ client, getConfig: botConfig.get, logger });
    const queues = new Map();

    // Messages of one conversation are handled strictly in order.
    function enqueue(key, task) {
        const previous = queues.get(key) || Promise.resolve();
        const next = previous.then(task).catch((error) => {
            logger.error('QQ bot message handling failed', { event: 'qqbot.message.failed', error });
        });
        queues.set(key, next);
        next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    }

    // A place card goes out as its own message (QQ cards cannot be combined with a quote or @).
    function sendCard(ctx, card) {
        return sendPlaceCard({
            client,
            isGroup: ctx.isGroup,
            targetId: ctx.isGroup ? ctx.chatId : ctx.senderQq,
            placeId: card.placeId,
            logger
        });
    }

    async function sendReply(ctx, event, reply) {
        if (reply.card) return sendCard(ctx, reply.card);
        const text = reply.text.length > MAX_REPLY_LENGTH ? `${reply.text.slice(0, MAX_REPLY_LENGTH - 1)}…` : reply.text;
        let action;
        let params;
        if (ctx.isGroup) {
            // Group replies quote the sender's message and @ them, so answers stay attached to the right person.
            action = 'send_group_msg';
            params = {
                group_id: Number(ctx.chatId),
                message: [
                    { type: 'reply', data: { id: String(event.message_id) } },
                    { type: 'at', data: { qq: ctx.senderQq } },
                    { type: 'text', data: { text: ` ${text}` } }
                ]
            };
        } else {
            action = 'send_private_msg';
            params = { user_id: Number(ctx.senderQq), message: [{ type: 'text', data: { text } }] };
        }
        try {
            const result = await client.call(action, params);
            if (reply.draftId && reply.track && result && result.message_id != null) {
                conversation.recordBotMessage(reply.draftId, reply.track, result.message_id, reply.draftVersion);
            }
        } catch (error) {
            logger.warn('QQ bot reply failed', { event: 'qqbot.reply.failed', chatType: ctx.chatType, error });
        }
    }

    client.on('message', (event) => {
        const current = botConfig.get();
        if (!current.commands.enabled) return;
        const senderQq = normalizeQQ(event.user_id);
        if (!senderQq || senderQq === client.selfId) return;
        const chatType = event.message_type;
        let chatId;
        if (chatType === 'group') {
            chatId = String(event.group_id);
            if (!current.commands.groupIds.includes(chatId) || event.sub_type === 'anonymous') return;
        } else if (chatType === 'private') {
            if (!current.commands.privateEnabled) return;
            chatId = senderQq;
        } else {
            return;
        }
        const isGroup = chatType === 'group';
        const parsed = parseMessage(event, client.selfId);
        if (!mayConcernBot(parsed, isGroup)) return;
        // NapCat may re-deliver after a reconnect; each message moves a conversation at most once.
        if (!claimInbound(`${client.selfId}:${chatType}:${chatId}:${event.message_id}`)) return;
        const ctx = { botId: client.selfId, chatType, chatId, senderQq, isGroup, parsed };
        enqueue(conversation.conversationKey(ctx), async () => {
            ctx.now = new Date();
            let replies;
            try {
                replies = (await commands.handleMessage(ctx)) || [];
            } catch (error) {
                logger.error('QQ bot command failed', { event: 'qqbot.command.failed', chatType, error });
                replies = [{ text: '处理时出错了，请稍后再试；草稿不会丢失。' }];
            }
            for (const reply of replies) await sendReply(ctx, event, reply);
        });
    });

    client.on('notice', (event) => {
        if (event.notice_type === 'group_increase') {
            memberSync.addMember(event.group_id, event.user_id);
        } else if (event.notice_type === 'group_decrease' && event.sub_type === 'kick_me') {
            logger.warn('QQ bot was removed from a group; whitelist is left unchanged', { event: 'qqbot.group.kicked', groupId: String(event.group_id) });
        }
    });

    client.on('ready', () => {
        memberSync.syncAll('connect').catch(() => {});
        worker.wake();
    });

    const housekeeping = setInterval(() => {
        try {
            const expired = conversation.expireDrafts();
            sql.prepare('DELETE FROM QQBotInboundMessage WHERE received_at < ?').run(new Date(Date.now() - INBOUND_RETENTION_MS).toISOString());
            if (expired) logger.info('QQ bot drafts expired', { event: 'qqbot.drafts.expired', count: expired });
        } catch (error) {
            logger.warn('QQ bot housekeeping failed', { event: 'qqbot.housekeeping.failed', error });
        }
    }, HOUSEKEEPING_INTERVAL_MS);
    housekeeping.unref?.();

    client.start();
    memberSync.start();
    worker.start();
    logger.notice('QQ bot started', { event: 'qqbot.started', ...publicConfig(config) });

    instance = {
        client,
        memberSync,
        worker,
        stop() {
            clearInterval(housekeeping);
            memberSync.stop();
            worker.stop();
            client.stop();
            instance = null;
        }
    };
    return instance;
}

function getQQBot() {
    return instance;
}

module.exports = { startQQBot, getQQBot, getQQBotStatus };
