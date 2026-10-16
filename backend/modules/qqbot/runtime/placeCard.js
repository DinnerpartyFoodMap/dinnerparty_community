const { db } = require('../../../infrastructure/database');
const botConfig = require('./config');
const { buildPlaceCard, cardImageFile, truncate, singleLine } = require('../../places/services/placeCard');
const { sendTuwenArk } = require('./tuwenArk');

// The card sent after a search or random pick, as its own message. Title and
// image follow the website's share page (services/placeCard.js).
//
// tuwen (default): QQ's 图文 link card through OIDB 0xdc2_34 (bot/tuwenArk.js) —
//   title, place details, preview image; tapping opens the place on the map.
// miniapp: NapCat get_mini_app_ark (QQ-signed mini app card; opens the template
//   mini app, not the browser).
// link: the /p/<id> share link on its own (QQ desktop unfurls it from its tags).
// Whatever fails falls back to the link; nothing is sent twice when the outcome is unknown.
const ARK_TIMEOUT_MS = 8000;
const DETAILS_MAX = 120;

/** Card text: per-person cost, description and address of the place. */
function placeDetails(place) {
    const parts = [];
    if (place.per_person_cost) parts.push(`人均 ${place.per_person_cost} 元`);
    const description = singleLine(place.description);
    if (description) parts.push(description);
    const address = singleLine(place.address);
    if (address) parts.push(`地址：${address}`);
    return truncate(parts.join('｜') || '东方饭联地图 · 与饭搭子一起发现身边的美食好店', DETAILS_MAX);
}

function cardContent(place, config = botConfig.get()) {
    const shareUrl = botConfig.placeShareUrl(place.id);
    const mapUrl = botConfig.placeUrl(place.id);
    if (!shareUrl || !mapUrl || !config.publicWebUrl) return null;
    const card = buildPlaceCard(place, config.publicWebUrl);
    // QQ cannot load the OSS thumbnail URL (query string, CDN host) into a card, but loads
    // plain URLs on the site itself, so photos go through /p/<id>/card-<key>.jpg.
    const file = cardImageFile(place);
    const thumbnailUrl = file ? `${config.publicWebUrl}/p/${encodeURIComponent(place.id)}/${file}` : card.image.url;
    return { ...card, details: placeDetails(place), shareUrl, mapUrl, thumbnailUrl };
}

function arkFrom(result) {
    const ark = result && typeof result === 'object' && result.data && typeof result.data === 'object' ? result.data : result;
    return ark && typeof ark === 'object' && typeof ark.app === 'string' && ark.meta ? ark : null;
}

/**
 * Sends the card for `placeId` to a group (`isGroup`) or a private chat. Returns
 * how it went out: 'tuwen' | 'miniapp' | 'link' | 'unknown' | 'none'.
 */
async function sendPlaceCard({ client, isGroup, targetId, placeId, config = botConfig.get(), logger = null }) {
    if (config.card.mode === 'off') return 'none';
    const place = db._raw.prepare('SELECT * FROM Place WHERE id = ?').get(placeId);
    if (!place) return 'none';
    const content = cardContent(place, config);
    if (!content) return 'none';
    const sendMessage = (message) => client.call(isGroup ? 'send_group_msg' : 'send_private_msg',
        isGroup ? { group_id: Number(targetId), message } : { user_id: Number(targetId), message });
    const warn = (message, extra) => logger?.warn(message, { placeId, chatType: isGroup ? 'group' : 'private', ...extra });

    if (config.card.mode === 'tuwen') {
        try {
            const result = await sendTuwenArk(client, {
                peerType: isGroup ? 1 : 0,
                targetId,
                title: content.title,
                desc: content.details,
                summary: `[分享] ${content.title}`,
                jumpUrl: content.mapUrl,
                previewUrl: content.thumbnailUrl
            });
            if (result.ok) return 'tuwen';
            warn('QQ bot link card rejected; sending the link instead', { event: 'qqbot.card.rejected', errorCode: result.errorCode, errorMessage: result.errorMessage });
        } catch (error) {
            if (error && error.outcomeUnknown) {
                warn('QQ bot link card outcome unknown; not resending', { event: 'qqbot.card.unknown', error });
                return 'unknown';
            }
            warn('QQ bot link card failed; sending the link instead', { event: 'qqbot.card.failed', error });
        }
    } else if (config.card.mode === 'miniapp') {
        let ark = null;
        try {
            ark = arkFrom(await client.call('get_mini_app_ark', {
                type: config.card.miniappTemplate,
                title: content.title,
                desc: content.details,
                picUrl: content.thumbnailUrl,
                jumpUrl: content.shareUrl,
                webUrl: content.shareUrl
            }, { timeoutMs: ARK_TIMEOUT_MS }));
            if (!ark) warn('QQ bot mini app card was unusable; sending the link instead', { event: 'qqbot.card.unusable' });
        } catch (error) {
            warn('QQ bot mini app card failed; sending the link instead', { event: 'qqbot.card.failed', error });
        }
        if (ark) {
            try {
                await sendMessage([{ type: 'json', data: { data: JSON.stringify(ark) } }]);
                return 'miniapp';
            } catch (error) {
                if (error && error.outcomeUnknown) return 'unknown';
                warn('QQ bot mini app card send failed; sending the link instead', { event: 'qqbot.card.send_failed', error });
            }
        }
    }

    try {
        await sendMessage([{ type: 'text', data: { text: content.shareUrl } }]);
        return 'link';
    } catch (error) {
        warn('QQ bot card link send failed', { event: 'qqbot.card.send_failed', error });
        return error && error.outcomeUnknown ? 'unknown' : 'none';
    }
}

module.exports = { sendPlaceCard, cardContent, placeDetails };
