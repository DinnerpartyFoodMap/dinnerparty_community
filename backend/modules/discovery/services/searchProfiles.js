'use strict';

const { createHash } = require('node:crypto');
const service = require('../../../infrastructure/numericAlgorithmClient');
const logger = require('../../../infrastructure/logger');
const { markdownToPlainText } = require('../../places/services/markdownText');
const { publicPlaceSql } = require('../../places/services/placeVisibility');

const BATCH_SIZE = 10;
const RETRY_DELAYS = [60_000, 600_000, 3_600_000];
const defaultDatabase = () => require('../../../infrastructure/database').db._raw;

function plainSearchDescription(description) {
    return markdownToPlainText(description).replace(/\s+/g, ' ').trim();
}

function profileInput(place, description = plainSearchDescription(place.description)) {
    return { id: place.id, name: place.name ?? '', category: place.category ?? '', description };
}

function searchProfileInputHash({ name, category, description }) {
    return createHash('sha256').update(JSON.stringify([name, category, description])).digest('hex');
}

const SELECT_PROFILES = `SELECT p.id, p.name, p.category, p.description, p.latitude, p.longitude,
    s.input_hash, s.profile_version, s.attempt_hash, s.attempt_version, s.status, s.attempts, s.next_retry_at, s.updated_at,
    (s.facts IS NOT NULL AND s.inferred IS NOT NULL) AS has_archive
    FROM Place p LEFT JOIN PlaceSearchProfile s ON s.place_id = p.id WHERE ${publicPlaceSql('p')}`;

function selectPendingSearchProfiles({
    database = defaultDatabase(), profileVersion, limit = BATCH_SIZE, afterId = 0, ids, inScope = () => true, now = Date.now()
} = {}) {
    const batch = [];
    if (limit <= 0) return batch;
    const restrictIds = ids === undefined ? '' : 'AND p.id IN (SELECT value FROM json_each(?))';
    const bindings = ids === undefined ? [afterId] : [afterId, JSON.stringify(ids)];
    for (const row of database.prepare(`${SELECT_PROFILES} AND p.id > ? ${restrictIds} ORDER BY p.id`).iterate(...bindings)) {
        if (!inScope(row)) continue;
        const input = profileInput(row);
        const hash = searchProfileInputHash(input);
        if (row.has_archive && hash === row.input_hash && profileVersion === row.profile_version) continue;
        const sameAttempt = hash === row.attempt_hash && profileVersion === row.attempt_version;
        const attempts = sameAttempt ? row.attempts : 0;
        if (sameAttempt && (attempts >= RETRY_DELAYS.length || row.next_retry_at > now)) continue;
        batch.push({ row, input, hash, attempts });
        if (batch.length >= limit) break;
    }
    return batch;
}

async function extractSearchProfiles(places, profileVersion, results) {
    let reply;
    try {
        reply = await service.compute('searchprofile', { places });
    } catch (error) {
        if (error.code !== 'model_output_truncated') throw error;
        if (places.length === 1) {
            results.set(places[0].id, null);
            return;
        }
        const middle = Math.ceil(places.length / 2);
        await extractSearchProfiles(places.slice(0, middle), profileVersion, results);
        await extractSearchProfiles(places.slice(middle), profileVersion, results);
        return;
    }
    if (reply.profile_version !== profileVersion) throw service.failure(503, 'profile_version_changed');
    for (const row of reply.results) results.set(row.id, row.status === 'done' ? { ...row, model: reply.model } : null);
}

const stateFields = ['input_hash', 'profile_version', 'attempt_hash', 'attempt_version', 'status', 'attempts', 'updated_at'];

async function runSearchProfileRound({
    database = defaultDatabase(), limit = BATCH_SIZE, afterId = 0, ids, now
} = {}) {
    const capabilities = await service.searchCapabilities();
    const stats = { selected: 0, done: 0, error: 0, stale: 0, requestStatus: null, lastId: afterId };
    if (!capabilities) return { ...stats, requestStatus: 'skipped' };
    const profileVersion = capabilities.profile_version;
    const batch = selectPendingSearchProfiles({ database, profileVersion, limit: Math.min(BATCH_SIZE, limit), afterId, ids, now });
    stats.selected = batch.length;
    if (!batch.length) return stats;
    stats.lastId = batch.at(-1).input.id;

    const results = new Map();
    try {
        await extractSearchProfiles(batch.map(({ input }) => input), profileVersion, results);
        stats.requestStatus = 'ok';
    } catch (error) {
        stats.requestStatus = 'failed';
        logger.warn('Search profile request failed', {
            event: 'discovery.search_profiles.request_failed', count: batch.length, code: error.code, error
        });
    }
    if (!results.size) return stats;

    const finishedAt = now ?? Date.now();
    const get = database.prepare(`${SELECT_PROFILES} AND p.id = ?`);
    const saveSuccess = database.prepare(`INSERT INTO PlaceSearchProfile
        (place_id, input_hash, profile_version, status, attempts, facts, inferred, closed, model, updated_at)
        VALUES (@id, @hash, @version, 'done', @attempts, @facts, @inferred, @closed, @model, @updatedAt)
        ON CONFLICT(place_id) DO UPDATE SET input_hash = excluded.input_hash, profile_version = excluded.profile_version,
            status = excluded.status, attempts = excluded.attempts, next_retry_at = NULL, attempt_hash = NULL,
            attempt_version = NULL, facts = excluded.facts, inferred = excluded.inferred, closed = excluded.closed,
            model = excluded.model, updated_at = excluded.updated_at`);
    const saveFailure = database.prepare(`INSERT INTO PlaceSearchProfile
        (place_id, input_hash, status, attempts, next_retry_at, attempt_hash, attempt_version, updated_at)
        VALUES (@id, '', 'error', @attempts, @retryAt, @hash, @version, @updatedAt)
        ON CONFLICT(place_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
            next_retry_at = excluded.next_retry_at, attempt_hash = excluded.attempt_hash,
            attempt_version = excluded.attempt_version, updated_at = excluded.updated_at`);
    database.transaction(() => {
        for (const { row, input, hash, attempts } of batch) {
            if (!results.has(input.id)) continue;
            const current = get.get(input.id);
            // A place edit or another backfill may have superseded this result.
            if (!current || stateFields.some((field) => current[field] !== row[field])
                || searchProfileInputHash(profileInput(current)) !== hash) {
                stats.stale++;
                continue;
            }
            const result = results.get(input.id);
            const parameters = { id: input.id, hash, version: profileVersion, attempts: attempts + 1, updatedAt: finishedAt };
            if (result) {
                saveSuccess.run({ ...parameters, facts: JSON.stringify(result.facts), inferred: JSON.stringify(result.inferred),
                    closed: Number(result.closed), model: result.model });
                stats.done++;
            } else {
                saveFailure.run({ ...parameters, retryAt: attempts + 1 === RETRY_DELAYS.length ? null : finishedAt + RETRY_DELAYS[attempts] });
                stats.error++;
            }
        }
    }).immediate();
    return stats;
}

let worker;

function startSearchProfileWorker(options = {}) {
    if (worker) return worker.stop;
    if (String(process.env.SEARCH_PROFILE_WORKER || '').trim().toLowerCase() === 'false' || !service.configuration()) return () => {};
    let timer;
    let running = false;
    let stopped = false;
    let woken = false;
    let requestFailures = 0;
    const schedule = (delay) => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(run, delay);
        timer.unref?.();
    };
    const run = async () => {
        if (running || stopped) return;
        running = true;
        let delay = RETRY_DELAYS[0];
        try {
            const result = await runSearchProfileRound(options);
            if (['failed', 'skipped'].includes(result.requestStatus)) {
                delay = RETRY_DELAYS[Math.min(requestFailures++, RETRY_DELAYS.length - 1)];
            } else {
                requestFailures = 0;
                if (result.selected === BATCH_SIZE) delay = 1500;
            }
        } catch (error) {
            logger.warn('Search profile worker failed', { event: 'discovery.search_profiles.round_failed', error });
        } finally {
            running = false;
            schedule(woken && !requestFailures ? 500 : delay);
            woken = false;
        }
    };
    worker = {
        wake: () => { if (running) woken = true; else if (!requestFailures) schedule(500); },
        stop: () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(timer);
            worker = undefined;
        }
    };
    schedule(5000);
    return worker.stop;
}

function wakeSearchProfileWorker() {
    worker?.wake();
}

module.exports = { BATCH_SIZE, selectPendingSearchProfiles, plainSearchDescription, profileInput, searchProfileInputHash,
    runSearchProfileRound, startSearchProfileWorker, wakeSearchProfileWorker };
