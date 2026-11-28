'use strict';

const { statSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { backendPath } = require('../../infrastructure/paths');

function parseCircle(value) {
    const parts = value.split(',');
    const [lat, lng, km] = parts.map((part) => part.trim() ? Number(part) : NaN);
    if (parts.length !== 3 || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180) || !Number.isFinite(km) || km <= 0) {
        throw new Error('--near must be lat,lng,km with valid coordinates and a positive radius');
    }
    return { lat, lng, km };
}

async function main() {
    const args = process.argv.slice(2);
    // Node treats a separately supplied negative latitude as an option unless it is attached.
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--near' && /^-(?:\d|\.\d)/.test(args[i + 1])) args.splice(i, 2, `--near=${args[i + 1]}`);
    }
    const { values } = parseArgs({ args, options: {
        db: { type: 'string' }, limit: { type: 'string' }, concurrency: { type: 'string', default: '4' },
        near: { type: 'string', multiple: true, default: [] }
    } });
    const limit = values.limit === undefined ? Infinity : Number(values.limit);
    if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new Error('--limit must be a positive integer');
    }
    const concurrency = Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error('--concurrency must be an integer from 1 to 8');
    }
    const circles = values.near.map(parseCircle);
    if (values.db !== undefined) {
        if (!values.db.trim() || !statSync(resolve(values.db)).isFile()) throw new Error('--db must be an existing file');
        process.env.DB_FILE = resolve(values.db);
    }
    require('dotenv').config({ path: backendPath('.env'), quiet: true });
    const { configuration, searchCapabilities } = require('../../infrastructure/numericAlgorithmClient');
    if (!configuration()) throw new Error('Private calculation service is not configured');
    const capabilities = await searchCapabilities();
    if (!capabilities) throw new Error('Private search service is unavailable');

    const { db } = require('../../infrastructure/database');
    const { initSearchProfileSchema } = require('../../modules/discovery/services/searchProfileSchema');
    const { BATCH_SIZE, runSearchProfileRound, selectPendingSearchProfiles } = require('../../modules/discovery/services/searchProfiles');
    const { haversineDistanceKm } = require('../../modules/discovery/services/semanticSearch');
    const inScope = (place) => !circles.length || circles.some((circle) => {
        const distance = haversineDistanceKm(circle, { lat: place.latitude, lng: place.longitude });
        return distance !== null && distance <= circle.km;
    });
    const total = { selected: 0, done: 0, error: 0, stale: 0 };
    try {
        initSearchProfileSchema(db._raw);
        const pendingIds = selectPendingSearchProfiles({ database: db._raw, profileVersion: capabilities.profile_version, limit, inScope }).map(({ input }) => input.id);
        const batches = [];
        for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
            batches.push(pendingIds.slice(i, i + BATCH_SIZE));
        }
        let nextBatch = 0;
        let failure;
        const processBatches = async () => {
            while (!failure && nextBatch < batches.length) {
                const ids = batches[nextBatch++];
                try {
                    const batch = await runSearchProfileRound({ database: db._raw, ids });
                    if (['failed', 'skipped'].includes(batch.requestStatus)) throw new Error('Search profile batch failed');
                    for (const field of Object.keys(total)) total[field] += batch[field];
                    console.log(JSON.stringify({ type: 'batch', ...batch }));
                } catch (error) {
                    failure ??= error;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, processBatches));
        if (failure) throw new Error(`${failure.message}; rerun to resume backfill`);
        console.log(JSON.stringify({ type: 'summary', ...total }));
        if (total.error || total.stale) process.exitCode = 1;
    } finally {
        db.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
