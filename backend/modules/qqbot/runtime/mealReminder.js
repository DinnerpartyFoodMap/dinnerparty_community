const { MEAL_COPY, RANDOM_HINT } = require('./mealReminderCopy');
const { beijingClock, DAY_MS } = require('../../../infrastructure/beijingClock');

// Daily breakfast / lunch / dinner reminders in QQ groups at fixed Beijing times
// (QQ_BOT_MEAL_REMINDER_TIMES). Each group gets one message per meal and day: the
// QQBotMealReminder row is claimed before sending, so restarts never send twice.
// A meal missed by more than LATE_WINDOW_MS (bot offline) is skipped for that day.
// Status: sending → sent | retry (explicit failure, tried again a minute later) | failed | unknown.
const getDatabase = () => require('../../../infrastructure/database').db._raw;
const MEALS = ['breakfast', 'lunch', 'dinner'];
const CHECK_INTERVAL_MS = 30 * 1000;
const LATE_WINDOW_MS = 20 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 20000;
const GROUP_SEND_GAP_MS = 2000;
const RETENTION_DAYS = 30;

const iso = (date) => date.toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Meals whose time has come within the last LATE_WINDOW_MS: [{ meal, index, day, dayNumber }]. */
function dueMeals(now, times) {
    const clock = beijingClock(now);
    return times.flatMap((time, index) => {
        const [hours, minutes] = String(time).split(':').map(Number);
        const late = clock.msOfDay - (hours * 60 + minutes) * 60000;
        return late >= 0 && late < LATE_WINDOW_MS && MEALS[index]
            ? [{ meal: MEALS[index], index, day: clock.day, dayNumber: clock.dayNumber }]
            : [];
    });
}

/** The day's line for this meal (the same in every group), plus the !随机 hint where the bot takes commands. */
function reminderText(due, config, groupId) {
    const lines = MEAL_COPY[due.meal];
    const line = lines[(due.dayNumber + due.index) % lines.length];
    const takesCommands = config.commands.enabled && config.commands.groupIds.includes(String(groupId));
    return takesCommands ? `${line}\n${RANDOM_HINT}` : line;
}

class MealReminder {
    constructor({ client, getConfig, logger, now = () => new Date(), sendGapMs = GROUP_SEND_GAP_MS }) {
        this.client = client;
        this.getConfig = getConfig;
        this.logger = logger;
        this.now = now;
        this.sendGapMs = sendGapMs;
        this.timer = null;
        this.running = false;
        this.lastSentAt = 0;
    }

    start() {
        const stuck = getDatabase().prepare("UPDATE QQBotMealReminder SET status = 'unknown', last_error = '进程重启时发送结果未确认', updated_at = ? WHERE status = 'sending'").run(iso(this.now()));
        if (stuck.changes) this.logger.warn('QQ meal reminders with unconfirmed delivery after restart', { event: 'qqbot.meal.unknown_after_restart', count: stuck.changes });
        this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    tick() {
        if (this.running) return;
        this.running = true;
        this.runOnce()
            .catch((error) => this.logger.error('QQ meal reminder failed', { event: 'qqbot.meal.worker_failed', error }))
            .finally(() => { this.running = false; });
    }

    async runOnce() {
        const config = this.getConfig();
        const settings = config.mealReminder;
        if (!settings || !settings.enabled || !settings.groupIds.length || !this.client.connected) return;
        for (const due of dueMeals(this.now(), settings.times)) {
            for (const groupId of settings.groupIds) {
                if (!this.client.connected) return;
                await this.sendTo(groupId, due, config);
            }
        }
    }

    /** Returns true when a message went out. */
    async sendTo(groupId, due, config) {
        const sql = getDatabase();
        const key = [groupId, due.day, due.meal];
        const now = this.now();
        const time = iso(now);
        const claimed = sql.prepare(`INSERT OR IGNORE INTO QQBotMealReminder (group_id, day, meal, status, attempts, created_at, updated_at)
            VALUES (?, ?, ?, 'sending', 1, ?, ?)`).run(...key, time, time).changes === 1
            || sql.prepare(`UPDATE QQBotMealReminder SET status = 'sending', attempts = attempts + 1, updated_at = ?
                WHERE group_id = ? AND day = ? AND meal = ? AND status = 'retry' AND attempts < ? AND updated_at <= ?`)
                .run(time, ...key, MAX_ATTEMPTS, iso(new Date(now.getTime() - RETRY_AFTER_MS))).changes === 1;
        if (!claimed) return false;

        const gap = this.sendGapMs - (Date.now() - this.lastSentAt);
        if (gap > 0) await sleep(gap);
        const update = (status, values = {}) => sql.prepare(`UPDATE QQBotMealReminder SET status = ?, message_id = COALESCE(?, message_id),
            last_error = ?, attempts = attempts + ?, updated_at = ? WHERE group_id = ? AND day = ? AND meal = ?`)
            .run(status, values.messageId ?? null, values.error ?? null, values.attemptsDelta || 0, values.updatedAt || iso(this.now()), ...key);
        try {
            const result = await this.client.call('send_group_msg', {
                group_id: Number(groupId),
                message: [{ type: 'text', data: { text: reminderText(due, config, groupId) } }]
            }, { timeoutMs: SEND_TIMEOUT_MS });
            this.lastSentAt = Date.now();
            update('sent', { messageId: result && result.message_id != null ? String(result.message_id) : null });
            this.logger.info('QQ meal reminder sent', { event: 'qqbot.meal.sent', groupId, meal: due.meal, day: due.day });
            return true;
        } catch (error) {
            this.lastSentAt = Date.now();
            const message = String(error.message).slice(0, 500);
            if (error.code === 'not_connected') {
                // Never reached QQ: hand the claim back so the next check can try again at once.
                update('retry', { error: message, attemptsDelta: -1, updatedAt: iso(new Date(this.now().getTime() - RETRY_AFTER_MS)) });
                return false;
            }
            if (error.outcomeUnknown) {
                update('unknown', { error: `发送结果未知：${message}` });
                this.logger.warn('QQ meal reminder delivery unknown', { event: 'qqbot.meal.unknown', groupId, meal: due.meal, error });
                return false;
            }
            const { attempts } = sql.prepare('SELECT attempts FROM QQBotMealReminder WHERE group_id = ? AND day = ? AND meal = ?').get(...key);
            const willRetry = error.code === 'failed' && attempts < MAX_ATTEMPTS;
            update(willRetry ? 'retry' : 'failed', { error: message });
            this.logger.warn('QQ meal reminder send failed', { event: 'qqbot.meal.failed', groupId, meal: due.meal, attempts, willRetry, error });
            return false;
        }
    }
}

/** Keeps the last RETENTION_DAYS days of reminder rows. */
function pruneMealReminders(now = new Date()) {
    const cutoff = beijingClock(new Date(now.getTime() - RETENTION_DAYS * DAY_MS)).day;
    return getDatabase().prepare('DELETE FROM QQBotMealReminder WHERE day < ?').run(cutoff).changes;
}

function mealReminderSummary() {
    return getDatabase().prepare(`SELECT group_id, day, meal, status, attempts, last_error, updated_at
        FROM QQBotMealReminder ORDER BY day DESC, updated_at DESC LIMIT 30`).all();
}

module.exports = { MealReminder, dueMeals, reminderText, beijingClock, pruneMealReminders, mealReminderSummary, MEALS, LATE_WINDOW_MS };
