'use strict';

const logger = require('../../../infrastructure/logger');

function searchError(code, status, message) {
    return Object.assign(new Error(message), { code, status });
}

// Calendar accounting follows the provider's China calendar, independently of host TZ.
function calendar(date) {
    const china = new Date(date.getTime() + 8 * 3600000);
    const day = china.toISOString().slice(0, 10);
    return {
        day, month: day.slice(0, 7),
        daysLeft: new Date(Date.UTC(china.getUTCFullYear(), china.getUTCMonth() + 1, 0)).getUTCDate() - china.getUTCDate() + 1
    };
}

function count(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) throw new Error(`Invalid ${name}`);
    return value;
}

function createSearchBudget(sql, { now = () => new Date() } = {}) {
    sql.exec(`
        CREATE TABLE IF NOT EXISTS AmapSearchConfig (
            id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL,
            monthly_limit INTEGER NOT NULL, daily_limit INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO AmapSearchConfig VALUES (1, 1, 4000, 0);
        CREATE TABLE IF NOT EXISTS AmapSearchUsage (
            day TEXT NOT NULL, source TEXT NOT NULL, requests INTEGER NOT NULL,
            PRIMARY KEY (day, source)
        );
        CREATE TABLE IF NOT EXISTS AmapSearchAdjustment (month TEXT PRIMARY KEY, requests INTEGER NOT NULL);
    `);
    function status() {
        const { day, month, daysLeft } = calendar(now());
        const configRow = sql.prepare('SELECT * FROM AmapSearchConfig WHERE id = 1').get();
        const config = { enabled: !!configRow.enabled, monthlyLimit: configRow.monthly_limit, dailyLimit: configRow.daily_limit };
        const rows = sql.prepare('SELECT day, source, requests FROM AmapSearchUsage WHERE day >= ? AND day <= ?').all(`${month}-01`, `${month}-31`);
        const priorUsage = sql.prepare('SELECT requests FROM AmapSearchAdjustment WHERE month = ?').get(month)?.requests || 0;
        const tracked = rows.reduce((sum, row) => sum + row.requests, 0);
        const todayUsed = rows.filter(row => row.day === day).reduce((sum, row) => sum + row.requests, 0);
        const monthlyUsed = tracked + priorUsage;
        const monthlyRemaining = Math.max(0, config.monthlyLimit - monthlyUsed);
        // Compute today's allocation from the remaining budget at the START of today,
        // so each reservation does not progressively shrink that day's allowance.
        const todayLimit = config.dailyLimit || Math.ceil(Math.max(0, config.monthlyLimit - monthlyUsed + todayUsed) / daysLeft);
        const sources = {};
        for (const row of rows) sources[row.source] = (sources[row.source] || 0) + row.requests;
        return { config, day, month, monthlyUsed, monthlyRemaining, todayUsed, todayLimit, priorUsage, sources };
    }
    const reserveTransaction = sql.transaction(source => {
        const state = status();
        if (!state.config.enabled) throw searchError('AMAP_SEARCH_DISABLED', 503, '外部地点搜索暂时关闭，请使用已有标记或地图选点。');
        if (!state.monthlyRemaining) throw searchError('AMAP_SEARCH_MONTHLY_LIMIT', 429, '本月外部地点搜索已达上限，请使用已有标记或地图选点。');
        if (state.todayUsed >= state.todayLimit) throw searchError('AMAP_SEARCH_DAILY_LIMIT', 429, '今日外部地点搜索已达上限，请使用已有标记或地图选点。');
        sql.prepare(`INSERT INTO AmapSearchUsage (day, source, requests) VALUES (?, ?, 1)
            ON CONFLICT(day, source) DO UPDATE SET requests = requests + 1`).run(state.day, source);
        return { month: state.month, monthlyUsed: state.monthlyUsed + 1, source };
    });
    return {
        status,
        reserve(source) {
            if (!['map_manual', 'journey_address', 'legacy_sdk'].includes(source)) throw new Error('Invalid search source');
            const result = reserveTransaction.immediate(source);
            logger.info('AMap search reserved', { event: 'amap.search.reserved', ...result });
            return result;
        },
        configure(patch) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid configuration');
            for (const key of Object.keys(patch)) {
                if (!['enabled', 'monthlyLimit', 'dailyLimit'].includes(key)) throw new Error(`Unknown configuration: ${key}`);
            }
            if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw new Error('Invalid enabled');
            if ('monthlyLimit' in patch) count(patch.monthlyLimit, 'monthlyLimit');
            if ('dailyLimit' in patch) count(patch.dailyLimit, 'dailyLimit');
            sql.transaction(() => {
                const config = { ...status().config, ...patch };
                sql.prepare('UPDATE AmapSearchConfig SET enabled = ?, monthly_limit = ?, daily_limit = ? WHERE id = 1')
                    .run(Number(config.enabled), config.monthlyLimit, config.dailyLimit);
            }).immediate();
            return status();
        },
        // Set total usage from the console at rollout; tracked requests are never erased.
        reconcile(monthUsed) {
            count(monthUsed, 'monthUsed');
            sql.transaction(() => {
                const state = status();
                const tracked = state.monthlyUsed - state.priorUsage;
                if (monthUsed < tracked) throw new Error('Reported usage cannot be below tracked requests');
                sql.prepare(`INSERT INTO AmapSearchAdjustment (month, requests) VALUES (?, ?)
                    ON CONFLICT(month) DO UPDATE SET requests = excluded.requests`).run(state.month, monthUsed - tracked);
            }).immediate();
            return status();
        }
    };
}

let singleton;
function getSearchBudget() {
    if (!singleton) singleton = createSearchBudget(require('../../../infrastructure/database').db._raw);
    return singleton;
}

function isSearchPath(rawUrl) {
    let pathname = String(rawUrl || '').split('?')[0];
    try { pathname = decodeURIComponent(pathname); } catch { /* Match known prefixes even with malformed suffixes. */ }
    // Express may leave multiple leading slashes after removing the mount path.
    // Treat them as path separators, never as a URL authority (//v3/...).
    pathname = pathname.replace(/\\/g, '/').replace(/\/+/g, '/');
    pathname = new URL(`http://amap.local/${pathname.replace(/^\/+/, '')}`).pathname;
    return /\/(?:v3|v4|v5)\/(?:place(?:\/|$)|assistant\/inputtips(?:\/|$))/.test(pathname);
}

function createLegacySearchGuard(budget) {
    return (req, res, next) => {
        if (!isSearchPath(req.url)) return next();
        try {
            (budget || getSearchBudget()).reserve('legacy_sdk');
            return next();
        } catch (error) {
            res.set('Cache-Control', 'no-store');
            if (error.status === 429) res.set('Retry-After', '3600');
            return res.status(error.status || 503).json({
                status: '0', info: 'SERVICE_NOT_AVAILABLE',
                code: error.code || 'AMAP_SEARCH_UNAVAILABLE',
                error: error.code ? error.message : '外部地点搜索暂时不可用。'
            });
        }
    };
}

module.exports = { createSearchBudget, getSearchBudget, createLegacySearchGuard, searchError };
