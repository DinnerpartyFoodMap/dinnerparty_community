// Private messages the website asks the bot to send (verification codes).
//
// Most recipients are not the bot's friends, so the message goes out as a QQ
// temporary session through a group both are in. NapCat's send_private_msg has
// a trap here: when it cannot resolve the user it falls back to sending into
// the group_id it was given, which would post the text publicly. So group_id is
// only passed after get_group_member_info has confirmed the user is in that group.
const MEMBER_LOOKUP_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 12000;

class DirectMessageError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'DirectMessageError';
        // offline | unreachable | failed
        this.code = code;
    }
}

// Groups the bot is configured to be in; whitelisted members come from these.
function candidateGroups(config) {
    return [...new Set([...config.whitelist.groupIds, ...config.commands.groupIds, ...config.notify.groupIds])];
}

async function findSharedGroup(client, groupIds, qq) {
    for (const groupId of groupIds) {
        try {
            const member = await client.call('get_group_member_info',
                { group_id: Number(groupId), user_id: Number(qq), no_cache: false },
                { timeoutMs: MEMBER_LOOKUP_TIMEOUT_MS });
            if (member && String(member.user_id) === qq) return groupId;
        } catch (error) {
            // Not a member (explicit failure) or a slow lookup: try the next group.
            if (error && error.code === 'not_connected') throw error;
        }
    }
    return null;
}

async function isFriend(client, qq) {
    try {
        const friends = await client.call('get_friend_list', {}, { timeoutMs: MEMBER_LOOKUP_TIMEOUT_MS });
        return Array.isArray(friends) && friends.some((friend) => String(friend && friend.user_id) === qq);
    } catch (error) {
        if (error && error.code === 'not_connected') throw error;
        return false;
    }
}

/**
 * Sends a text private message to `qq`. Resolves to { via: 'group' | 'friend', outcomeUnknown }.
 * Rejects with DirectMessageError: offline (bot not connected), unreachable (no shared
 * group and not a friend), failed (NapCat refused, e.g. the user blocks temp sessions).
 */
async function sendPrivateText({ client, config, qq, text }) {
    if (!client || !client.connected) throw new DirectMessageError('QQ bot is not connected', 'offline');
    try {
        const groupId = await findSharedGroup(client, candidateGroups(config), qq);
        if (!groupId && !(await isFriend(client, qq))) {
            throw new DirectMessageError('no shared group or friendship with the recipient', 'unreachable');
        }
        const params = { user_id: Number(qq), message: [{ type: 'text', data: { text } }] };
        if (groupId) params.group_id = Number(groupId);
        try {
            await client.call('send_private_msg', params, { timeoutMs: SEND_TIMEOUT_MS });
            return { via: groupId ? 'group' : 'friend', outcomeUnknown: false };
        } catch (error) {
            // Written to the socket but no answer: the message may well have arrived.
            if (error && error.outcomeUnknown) return { via: groupId ? 'group' : 'friend', outcomeUnknown: true };
            throw error;
        }
    } catch (error) {
        if (error instanceof DirectMessageError) throw error;
        if (error && error.code === 'not_connected') throw new DirectMessageError(error.message, 'offline');
        throw new DirectMessageError(error && error.message ? error.message : String(error), 'failed');
    }
}

module.exports = { sendPrivateText, DirectMessageError, candidateGroups };
