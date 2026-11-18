const { db } = require('../../../infrastructure/database');
const botConfig = require('./config');
const { onNotificationWake } = require('../../places/services/placeNotifications');
const { markdownToPlainText } = require('../../places/services/markdownText');
const { ensurePlaceRegions } = require('../../places/services/placeRegions');
const { recoverDiaryNotifications, sendDueDiaryNotifications } = require('./diaryNotifications');

// Delivers queued new-place notifications to QQ groups every half hour: the places
// queued during one half hour go out together right after it ends (:00 and :30,
// Beijing and UTC half hours coincide), as one merged-forward message (合并转发)
// per group with one node per place. Nothing queued → nothing is sent.
// Status: pending → sending → sent | pending (retry) | failed | unknown | skipped.
// "unknown" means the request reached NapCat but no answer came back; it is
// checked against recent group history instead of being blindly resent.
const sql = db._raw;
const BATCH_INTERVAL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
// A forward message is uploaded before it is posted, so it gets more time than a plain message.
const SEND_TIMEOUT_MS = 30000;
const HISTORY_TIMEOUT_MS = 20000;
const GROUP_SEND_GAP_MS = 2000;
const MAX_ATTEMPTS = 6;
// QQ caps a forward at 100 messages; a busier half hour is split into several forwards.
const MAX_PER_FORWARD = 50;
const UNKNOWN_CHECK_AFTER_MS = 30000;
// An unconfirmed forward counts as sent when the bot's own forward shows up in the group this close to the attempt.
const HISTORY_MATCH_MS = 60000;
const DESCRIPTION_PREVIEW = 60;
const NODE_NICKNAME = '饭桶 Bot';
const PREVIEW_LINES = 4;

const iso = (date = new Date()) => date.toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start of the half hour `time` falls in; tasks queued before it are due. */
function slotStart(time) {
    return new Date(Math.floor(time.getTime() / BATCH_INTERVAL_MS) * BATCH_INTERVAL_MS);
}

function nextSlotAtOrAfter(ms) {
    return new Date(Math.ceil(ms / BATCH_INTERVAL_MS) * BATCH_INTERVAL_MS);
}

function shorten(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function retryDelayMs(attempts) {
    return Math.min(60 * 60 * 1000, 30000 * 2 ** Math.max(0, attempts - 1));
}

// Province and city from PlaceRegion. AMap has none abroad, so only places in China get them;
// a municipality's city is the province itself and is not repeated.
function regionText(place) {
    if (!place.province) return '';
    return place.city && place.city !== place.province ? `${place.province}${place.city}` : place.province;
}

function placeBlock(place) {
    const lines = [`店名：${place.name}`, `作者：${place.creator_name || '未知'}`];
    const region = regionText(place);
    if (region) lines.push(`地区：${region}`);
    if (place.address) lines.push(`地址：${place.address}`);
    if (place.category) lines.push(`标签：${place.category.split(/,\s*/).join('、')}`);
    if (place.per_person_cost) lines.push(`人均：${place.per_person_cost} 元`);
    if (place.description) lines.push(`描述：${shorten(markdownToPlainText(place.description), DESCRIPTION_PREVIEW)}`);
    const link = botConfig.placeUrl(place.id);
    if (link) lines.push(`在地图中查看：${link}`);
    return lines.join('\n');
}

/** send_group_forward_msg parameters: one node per place, posted under the bot's own account. */
function buildForward(groupId, places, selfId) {
    return {
        group_id: Number(groupId),
        messages: places.map((place) => ({
            type: 'node',
            data: { user_id: String(selfId || ''), nickname: NODE_NICKNAME, content: [{ type: 'text', data: { text: placeBlock(place) } }] }
        })),
        // NapCat's fields for the outer card (title, preview lines, footer, chat-list text); others ignore them.
        source: '新地点推送',
        news: places.slice(0, PREVIEW_LINES).map((place) => {
            const city = place.city || place.province;
            return { text: city ? `${place.name}（${city}）` : place.name };
        }),
        summary: `查看 ${places.length} 个新地点`,
        prompt: `[新地点 ×${places.length}]`
    };
}

function loadPlaces(ids) {
    // The region only counts when it was looked up at the place's current position.
    const select = sql.prepare(`SELECT p.id, p.name, p.address, p.category, p.per_person_cost, p.description,
            u.username AS creator_name, r.province, r.city
        FROM Place p LEFT JOIN User u ON u.id = p.creator_id
        LEFT JOIN PlaceRegion r ON r.place_id = p.id AND r.lat IS p.latitude AND r.lng IS p.longitude
        WHERE p.id = ? AND p.moderation_status = 'visible'`);
    return new Map(ids.map((id) => [id, select.get(id)]).filter(([, row]) => row));
}

function isForwardMessage(message) {
    if (Array.isArray(message.message) && message.message.some((segment) => segment && segment.type === 'forward')) return true;
    return /\[CQ:forward/.test(String(message.raw_message || ''));
}

class NotificationWorker {
    constructor({ client, getConfig, logger, now = () => new Date(), resolveRegions = ensurePlaceRegions }) {
        this.client = client;
        this.getConfig = getConfig;
        this.logger = logger;
        this.now = now;
        this.resolveRegions = resolveRegions;
        this.timer = null;
        this.running = false;
        this.again = false;
        this.unsubscribe = null;
        this.lastSentAt = new Map();
    }

    start() {
        // A crash between "sending" and the reply leaves the outcome unknown.
        const stuck = sql.prepare("UPDATE QQBotNotification SET status = 'unknown', last_error = '进程重启时发送结果未确认', updated_at = ? WHERE status = 'sending'").run(iso(this.now()));
        recoverDiaryNotifications();
        if (stuck.changes) this.logger.warn('QQ notifications with unconfirmed delivery after restart', { event: 'qqbot.notify.unknown_after_restart', count: stuck.changes });
        // New places wait for the end of their half hour; the wake-up only matters for admin retries.
        this.unsubscribe = onNotificationWake(() => this.wake());
        this.timer = setInterval(() => this.wake(), POLL_INTERVAL_MS);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
        if (this.unsubscribe) this.unsubscribe();
    }

    wake() {
        if (this.running) {
            this.again = true;
            return;
        }
        this.running = true;
        this.runOnce()
            .catch((error) => this.logger.error('QQ notification worker failed', { event: 'qqbot.notify.worker_failed', error }))
            .finally(() => {
                this.running = false;
                if (this.again) {
                    this.again = false;
                    setImmediate(() => this.wake());
                }
            });
    }

    async runOnce() {
        if (!this.client.connected) return;
        await this.verifyUnknown();
        // Switching pushes off, or dropping a group, holds its queued tasks instead of sending them.
        const { enabled, groupIds } = this.getConfig().notify;
        if (!enabled) return;
        const now = this.now();
        // Only tasks queued before the current half hour began; retries also wait for their own time.
        const due = sql.prepare(`SELECT * FROM QQBotNotification WHERE status = 'pending' AND next_attempt_at <= ? AND created_at < ?
            ORDER BY next_attempt_at, id LIMIT 200`).all(iso(now), iso(slotStart(now))).filter((task) => groupIds.includes(task.group_id));
        const byGroup = new Map();
        for (const task of due) {
            if (!byGroup.has(task.group_id)) byGroup.set(task.group_id, []);
            byGroup.get(task.group_id).push(task);
        }
        for (const [groupId, tasks] of byGroup) {
            for (let i = 0; i < tasks.length; i += MAX_PER_FORWARD) {
                if (!this.client.connected) return;
                await this.sendBatch(groupId, tasks.slice(i, i + MAX_PER_FORWARD));
            }
        }
        await sendDueDiaryNotifications({ client: this.client, groupIds, logger: this.logger, now: this.now });
    }

    async sendBatch(groupId, tasks) {
        const placeIds = tasks.map((t) => t.place_id);
        // The region worker normally has these already; a place added just before the half hour may still be missing.
        try {
            await this.resolveRegions(placeIds);
        } catch (error) {
            // The reason goes into the message: the console line shows no error details below error level.
            this.logger.warn(`QQ notification region lookup failed (${error && error.message}); sending without it`, { event: 'qqbot.notify.region_failed', groupId, error });
        }
        const places = loadPlaces(placeIds);
        const time = iso(this.now());
        const skip = sql.prepare("UPDATE QQBotNotification SET status = 'skipped', last_error = '地点已删除', updated_at = ? WHERE id = ? AND status = 'pending'");
        const live = tasks.filter((task) => {
            if (places.has(task.place_id)) return true;
            skip.run(time, task.id);
            return false;
        });
        if (!live.length) return;

        // Claim the batch; another worker tick cannot pick it up while it is "sending".
        const claim = sql.prepare("UPDATE QQBotNotification SET status = 'sending', attempts = attempts + 1, attempted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'");
        const claimed = sql.transaction(() => live.filter((task) => claim.run(time, time, task.id).changes === 1))();
        if (!claimed.length) return;

        const gap = GROUP_SEND_GAP_MS - (Date.now() - (this.lastSentAt.get(groupId) || 0));
        if (gap > 0) await sleep(gap);
        const payload = buildForward(groupId, claimed.map((task) => places.get(task.place_id)), this.client.selfId);
        const ids = claimed.map((task) => task.id);
        try {
            const result = await this.client.call('send_group_forward_msg', payload, { timeoutMs: SEND_TIMEOUT_MS });
            this.lastSentAt.set(groupId, Date.now());
            this.mark(ids, { status: 'sent', message_id: result && result.message_id != null ? String(result.message_id) : null, last_error: null });
            this.logger.info('QQ new-place notification sent', { event: 'qqbot.notify.sent', groupId, placeIds: claimed.map((t) => t.place_id) });
        } catch (error) {
            this.lastSentAt.set(groupId, Date.now());
            if (error.outcomeUnknown) {
                this.mark(ids, { status: 'unknown', last_error: `发送结果未知：${error.message}` });
                this.logger.warn('QQ notification delivery unknown', { event: 'qqbot.notify.unknown', groupId, placeIds: claimed.map((t) => t.place_id), error });
                return;
            }
            // not_connected never reached QQ, so it does not count as an attempt.
            if (error.code === 'not_connected') {
                sql.prepare(`UPDATE QQBotNotification SET status = 'pending', attempts = attempts - 1, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(iso(this.now()), ...ids);
                return;
            }
            const attempts = Math.max(...claimed.map((task) => task.attempts + 1));
            // Explicit failures are retried with backoff, at a later half hour; anything unexpected stops for an administrator.
            const failed = attempts >= MAX_ATTEMPTS || error.code !== 'failed';
            const nextAt = iso(nextSlotAtOrAfter(this.now().getTime() + retryDelayMs(attempts)));
            this.mark(ids, failed
                ? { status: 'failed', last_error: String(error.message).slice(0, 500) }
                : { status: 'pending', next_attempt_at: nextAt, last_error: String(error.message).slice(0, 500) });
            this.logger.warn('QQ notification send failed', { event: 'qqbot.notify.failed', groupId, attempts, willRetry: !failed, error });
        }
    }

    mark(ids, values) {
        const time = iso(this.now());
        const update = sql.prepare(`UPDATE QQBotNotification SET status = @status,
            message_id = COALESCE(@message_id, message_id), last_error = @last_error,
            next_attempt_at = COALESCE(@next_attempt_at, next_attempt_at), updated_at = @time WHERE id = @id`);
        sql.transaction(() => ids.forEach((id) => update.run({
            id, time, status: values.status, message_id: values.message_id ?? null,
            last_error: values.last_error ?? null, next_attempt_at: values.next_attempt_at ?? null
        })))();
    }

    // Looks through the bot's own recent group messages: the place link (older plain-text pushes,
    // or a forward NapCat expanded), else a forward the bot posted around the attempt time.
    // Found → sent; not found → stays "unknown" for an administrator to retry or mark.
    async verifyUnknown() {
        const cutoff = iso(new Date(this.now().getTime() - UNKNOWN_CHECK_AFTER_MS));
        const rows = sql.prepare(`SELECT * FROM QQBotNotification WHERE status = 'unknown' AND updated_at <= ?
            AND (last_error IS NULL OR last_error NOT LIKE '%已核对%') ORDER BY id LIMIT 50`).all(cutoff);
        const byGroup = new Map();
        rows.forEach((row) => byGroup.set(row.group_id, [...(byGroup.get(row.group_id) || []), row]));
        for (const [groupId, tasks] of byGroup) {
            let messages = [];
            try {
                const history = await this.client.call('get_group_msg_history', { group_id: Number(groupId), count: 50 }, { timeoutMs: HISTORY_TIMEOUT_MS });
                messages = (history && history.messages) || [];
            } catch (error) {
                this.logger.warn('QQ group history check failed', { event: 'qqbot.notify.history_failed', groupId, error });
                continue;
            }
            const own = messages.filter((m) => String(m.user_id || m.sender?.user_id) === this.client.selfId);
            for (const task of tasks) {
                const marker = `?place=${task.place_id}`;
                const attemptedAt = task.attempted_at ? Date.parse(task.attempted_at) : NaN;
                const diaryInWindow = Number.isFinite(attemptedAt) && sql.prepare(`SELECT 1 FROM QQBotDiaryNotification
                    WHERE group_id = ? AND attempted_at BETWEEN ? AND ?`).get(groupId,
                    iso(new Date(attemptedAt - HISTORY_MATCH_MS - SEND_TIMEOUT_MS)),
                    iso(new Date(attemptedAt + SEND_TIMEOUT_MS + HISTORY_MATCH_MS)));
                const found = own.find((m) => JSON.stringify(m.message || m.raw_message || '').includes(marker))
                    || (!diaryInWindow && Number.isFinite(attemptedAt) && own.find((m) => isForwardMessage(m) && Number.isFinite(Number(m.time))
                        && Number(m.time) * 1000 >= attemptedAt - HISTORY_MATCH_MS
                        && Number(m.time) * 1000 <= attemptedAt + SEND_TIMEOUT_MS + HISTORY_MATCH_MS));
                if (found) {
                    this.mark([task.id], { status: 'sent', message_id: String(found.message_id), last_error: null });
                } else {
                    this.mark([task.id], { status: 'unknown', last_error: '发送结果未知，已核对近期群消息未找到，等待管理员重试' });
                }
            }
        }
    }
}

function notificationSummary() {
    const counts = Object.fromEntries(sql.prepare('SELECT status, COUNT(*) AS n FROM QQBotNotification GROUP BY status').all().map((r) => [r.status, r.n]));
    const problems = sql.prepare(`SELECT n.id, n.place_id, p.name AS place_name, n.group_id, n.status, n.attempts, n.last_error, n.updated_at
        FROM QQBotNotification n LEFT JOIN Place p ON p.id = n.place_id
        WHERE n.status IN ('failed', 'unknown') ORDER BY n.updated_at DESC LIMIT 50`).all();
    return { counts, problems };
}

/** Admin actions: retry puts a failed/unknown task back in the queue; markSent records a manual check. */
function retryNotification(id) {
    return sql.prepare(`UPDATE QQBotNotification SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'unknown')`).run(iso(), iso(), id).changes === 1;
}

function markNotificationSent(id) {
    return sql.prepare(`UPDATE QQBotNotification SET status = 'sent', last_error = '管理员确认已发送', updated_at = ?
        WHERE id = ? AND status IN ('failed', 'unknown')`).run(iso(), id).changes === 1;
}

module.exports = {
    NotificationWorker, placeBlock, buildForward, regionText, slotStart,
    notificationSummary, retryNotification, markNotificationSent,
    MAX_ATTEMPTS, BATCH_INTERVAL_MS, MAX_PER_FORWARD
};
