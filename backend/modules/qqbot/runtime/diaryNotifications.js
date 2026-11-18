const sharp = require('sharp');
const { db } = require('../../../infrastructure/database');
const botConfig = require('./config');
const { markdownToPlainText } = require('../../places/services/markdownText');

const sql = db._raw;
const MAX_PHOTOS = 6;
const MAX_TEXT_NODES = 90 - MAX_PHOTOS - 1;
const MAX_ATTEMPTS = 6;

function enqueueDiaryNotifications(publicationId) {
    const config = botConfig.get();
    if (!config.enabled || !config.notify.enabled) return;
    const enqueue = sql.prepare(`INSERT OR IGNORE INTO QQBotDiaryNotification
        (publication_id, group_id, next_attempt_at) VALUES (?, ?, ?)`);
    const time = new Date().toISOString();
    for (const groupId of config.notify.groupIds) enqueue.run(publicationId, groupId, time);
}

function cancelDiaryNotifications(publicationId) {
    sql.prepare("UPDATE QQBotDiaryNotification SET status = 'skipped', last_error = '日记已撤回' WHERE publication_id = ? AND status = 'pending'").run(publicationId);
}

function recoverDiaryNotifications() {
    sql.prepare("UPDATE QQBotDiaryNotification SET status = 'unknown', last_error = '进程重启时发送结果未确认' WHERE status = 'sending'").run();
}

function textSegment(text) {
    return { type: 'text', data: { text } };
}

async function buildDiaryForward(task, diary, link, readMedia, selfId, logger) {
    const dates = diary.start_date === diary.end_date ? diary.start_date : `${diary.start_date} 至 ${diary.end_date}`;
    const heading = [diary.title, `作者：${diary.author.username}`, dates, `查看完整日记：${link}`].filter(Boolean).join('\n');
    const summary = markdownToPlainText(diary.summary);
    const text = markdownToPlainText(diary.text);
    const stops = diary.stops.map((stop) => [stop.name,
        ...stop.excerpt.map((item) => markdownToPlainText(item.text))].filter(Boolean).join('\n'));
    const body = [text, summary !== text ? summary : '', ...stops].filter(Boolean).join('\n\n');
    const node = (segment) => ({ type: 'node', data: {
        user_id: String(selfId), nickname: '饭桶 Bot', content: [segment]
    } });
    const messages = [node(textSegment(heading))];
    const pages = body.match(/[\s\S]{1,1600}/gu) || [];
    for (const page of pages.slice(0, MAX_TEXT_NODES)) messages.push(node(textSegment(page)));
    for (const id of diary.media_ids.slice(0, MAX_PHOTOS)) {
        try {
            const jpeg = await sharp(readMedia(diary.public_id, id)).resize(1000, 1000, {
                fit: 'inside', withoutEnlargement: true
            }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
            messages.push(node({ type: 'image', data: { file: `base64://${jpeg.toString('base64')}` } }));
        } catch (error) {
            logger.warn('QQ diary photo unavailable', { event: 'qqbot.diary.photo_failed', publicationId: diary.public_id, error });
        }
    }
    return { group_id: Number(task.group_id), messages, source: '公开日记', news: [{ text: diary.title }],
        summary: diary.author.username, prompt: '[公开日记]' };
}

async function sendDueDiaryNotifications({ client, groupIds, logger, now = () => new Date() }) {
    const site = botConfig.siteUrl();
    if (!site || !client.connected || !groupIds.length) return;
    const { publicJourney, publicMedia } = require('../../journeys/services/journeyPublication');
    const tasks = sql.prepare(`SELECT * FROM QQBotDiaryNotification WHERE status = 'pending'
        AND next_attempt_at <= ? AND group_id IN (${groupIds.map(() => '?').join(',')})
        ORDER BY next_attempt_at LIMIT 12`).all(now().toISOString(), ...groupIds);
    const claim = sql.prepare(`UPDATE QQBotDiaryNotification SET status = 'sending', attempts = attempts + 1, attempted_at = ?
        WHERE publication_id = ? AND group_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM JourneyPublication p WHERE p.id = publication_id AND p.status = 'active' AND p.version = ?)`);
    const mark = sql.prepare(`UPDATE QQBotDiaryNotification SET status = @status, last_error = @error,
        message_id = @message, next_attempt_at = @next, attempts = attempts + @adjustment
        WHERE publication_id = @publication AND group_id = @group AND status = 'sending'`);
    for (const task of tasks) {
        if (!client.connected) break;
        let diary;
        try {
            diary = publicJourney(task.publication_id);
        } catch (error) {
            if (error.status !== 404) throw error;
            cancelDiaryNotifications(task.publication_id);
            continue;
        }
        const link = `${site}?diary=${encodeURIComponent(task.publication_id)}`;
        const payload = await buildDiaryForward(task, diary, link, publicMedia, client.selfId, logger);
        // Recheck after rendering the photos, since a publication can be edited or withdrawn meanwhile.
        const time = now();
        if (!claim.run(time.toISOString(), task.publication_id, task.group_id, diary.version).changes) continue;
        const result = { publication: task.publication_id, group: task.group_id, status: 'sent',
            error: null, message: null, next: time.toISOString(), adjustment: 0 };
        try {
            const response = await client.call('send_group_forward_msg', payload, { timeoutMs: 30000 });
            result.message = response?.message_id == null ? null : String(response.message_id);
        } catch (error) {
            const attempts = task.attempts + 1;
            const retry = error.code === 'failed' && attempts < MAX_ATTEMPTS;
            result.status = error.outcomeUnknown ? 'unknown' : retry || error.code === 'not_connected' ? 'pending' : 'failed';
            result.adjustment = error.code === 'not_connected' ? -1 : 0;
            result.next = new Date(now().getTime() + Math.min(3600000, 30000 * 2 ** (attempts - 1))).toISOString();
            result.error = String(error.message).slice(0, 500);
            logger.warn('QQ diary notification failed', { event: 'qqbot.diary.send_failed', status: result.status,
                publicationId: task.publication_id, groupId: task.group_id, error });
        }
        mark.run(result);
    }
}

module.exports = { enqueueDiaryNotifications, cancelDiaryNotifications, recoverDiaryNotifications, sendDueDiaryNotifications };
