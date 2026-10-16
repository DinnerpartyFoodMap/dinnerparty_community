const { db } = require('../../../infrastructure/database');
const { insertWhitelistNumbers, missingWhitelistNumbers, WHITELIST_QQ_PATTERN } = require('../../accounts/services/qqWhitelist');

// Adds members of the configured QQ groups to the registration whitelist.
// Add-only: leaving a group, an empty member list, an API failure or the bot
// being removed from a group never deletes anyone. Modes:
//   off     – do nothing
//   dry-run – only compute and record who would be added (for the cut-over check)
//   on      – insert missing numbers
const sql = db._raw;
const MISSING_SAMPLE_LIMIT = 500;
const MEMBER_LIST_TIMEOUT_MS = 60000;

function iso(date = new Date()) { return date.toISOString(); }

function recordState(groupId, values) {
    const time = iso();
    sql.prepare(`INSERT INTO QQBotSyncState (group_id, mode, status, member_count, added_count, missing_count, missing_sample,
            last_error, last_attempt_at, last_success_at, updated_at)
        VALUES (@group_id, @mode, @status, @member_count, @added_count, @missing_count, @missing_sample, @last_error, @time, @last_success_at, @time)
        ON CONFLICT(group_id) DO UPDATE SET
            mode = excluded.mode, status = excluded.status,
            member_count = COALESCE(excluded.member_count, member_count),
            added_count = excluded.added_count, missing_count = excluded.missing_count,
            missing_sample = COALESCE(excluded.missing_sample, missing_sample),
            last_error = excluded.last_error, last_attempt_at = excluded.last_attempt_at,
            last_success_at = COALESCE(excluded.last_success_at, last_success_at),
            updated_at = excluded.updated_at`).run({
        group_id: groupId,
        mode: values.mode,
        status: values.status,
        member_count: values.member_count ?? null,
        added_count: values.added_count ?? null,
        missing_count: values.missing_count ?? null,
        missing_sample: values.missing_sample ?? null,
        last_error: values.last_error ?? null,
        last_success_at: values.status === 'ok' ? time : null,
        time
    });
}

function memberNumbers(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((member) => String(member && member.user_id || '')).filter((qq) => WHITELIST_QQ_PATTERN.test(qq) && qq !== '0'))];
}

function applyMembers(members, mode) {
    if (mode === 'on') {
        const { added } = sql.transaction(() => insertWhitelistNumbers(members)).immediate();
        return { added_count: added.length, missing_count: 0, missing_sample: '[]', added };
    }
    const missing = missingWhitelistNumbers(members);
    return { added_count: 0, missing_count: missing.length, missing_sample: JSON.stringify(missing.slice(0, MISSING_SAMPLE_LIMIT)), added: [] };
}

class MemberSync {
    constructor({ client, getConfig, logger }) {
        this.client = client;
        this.getConfig = getConfig;
        this.logger = logger;
        this.running = null;
        this.timer = null;
    }

    start() {
        const { intervalMs } = this.getConfig().whitelist;
        this.timer = setInterval(() => this.syncAll('interval').catch(() => {}), intervalMs);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Full reconciliation; concurrent triggers share one run. */
    syncAll(reason) {
        if (this.running) return this.running;
        this.running = this.runAll(reason).finally(() => { this.running = null; });
        return this.running;
    }

    async runAll(reason) {
        const { mode, groupIds } = this.getConfig().whitelist;
        if (mode === 'off' || !groupIds.length || !this.client.connected) return [];
        const results = [];
        // Groups are independent: one failing group never blocks the others.
        for (const groupId of groupIds) results.push(await this.syncGroup(groupId, mode));
        this.logger.info('QQ whitelist sync finished', {
            event: 'qqbot.whitelist.sync_finished',
            reason,
            mode,
            groups: results.map((r) => ({ groupId: r.groupId, status: r.status, members: r.memberCount, added: r.addedCount, missing: r.missingCount, error: r.error }))
        });
        return results;
    }

    async syncGroup(groupId, mode) {
        try {
            const list = await this.client.call('get_group_member_list', { group_id: Number(groupId), no_cache: true }, { timeoutMs: MEMBER_LIST_TIMEOUT_MS });
            const members = memberNumbers(list);
            if (!members.length) throw new Error('成员列表为空，已跳过（不会清空白名单）');
            const applied = applyMembers(members, mode);
            recordState(groupId, { mode, status: 'ok', member_count: members.length, ...applied });
            if (applied.added.length) {
                this.logger.notice('QQ whitelist members added', { event: 'qqbot.whitelist.added', groupId, count: applied.added.length });
            }
            return { groupId, status: 'ok', memberCount: members.length, addedCount: applied.added_count, missingCount: applied.missing_count };
        } catch (error) {
            recordState(groupId, { mode, status: 'error', last_error: String(error.message || error).slice(0, 500) });
            this.logger.warn('QQ whitelist sync failed for group', { event: 'qqbot.whitelist.sync_failed', groupId, error });
            return { groupId, status: 'error', error: error.message };
        }
    }

    /** group_increase notice: add the new member right away. */
    addMember(groupId, qqValue) {
        const { mode, groupIds } = this.getConfig().whitelist;
        const qq = String(qqValue || '');
        if (mode === 'off' || !groupIds.includes(String(groupId)) || !WHITELIST_QQ_PATTERN.test(qq)) return null;
        if (mode !== 'on') {
            const missing = missingWhitelistNumbers([qq]).length > 0;
            this.logger.info('QQ group member joined (dry run)', { event: 'qqbot.whitelist.join_dry_run', groupId, wouldAdd: missing });
            return { added: false, wouldAdd: missing };
        }
        const { added } = sql.transaction(() => insertWhitelistNumbers([qq])).immediate();
        if (added.length) this.logger.notice('QQ whitelist member added on join', { event: 'qqbot.whitelist.joined', groupId });
        return { added: added.length > 0 };
    }
}

function syncStates() {
    return sql.prepare('SELECT * FROM QQBotSyncState ORDER BY group_id').all().map((row) => {
        let sample = [];
        try { sample = JSON.parse(row.missing_sample || '[]'); } catch (_) { /* keep empty */ }
        return { ...row, missing_sample: sample };
    });
}

module.exports = { MemberSync, memberNumbers, syncStates };
