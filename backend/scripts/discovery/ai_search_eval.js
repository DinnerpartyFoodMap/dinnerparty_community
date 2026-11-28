'use strict';

const { openSync, closeSync, writeSync, statSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');
const { backendPath } = require('../../infrastructure/paths');

function summarize(results) {
    const times = results.map(({ elapsed_ms }) => elapsed_ms).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const previous = new Map();
    let compared = 0;
    let identical = 0;
    for (const { location, query, cards } of results) {
        const key = JSON.stringify([location, query]);
        const ids = JSON.stringify(cards.map(({ id }) => id));
        if (previous.has(key)) {
            compared++;
            if (previous.get(key) === ids) identical++;
        }
        previous.set(key, ids);
    }
    return {
        type: 'summary', total: results.length,
        recommendation_rate: results.filter(({ cards }) => cards.length > 0).length / results.length,
        stable_pairs: identical, compared_pairs: compared, stability: compared ? identical / compared : null,
        median_ms: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
        p90_ms: times[Math.ceil(times.length * 0.9) - 1],
        vector_fallback_rate: results.filter(({ used_vector }) => used_vector).length / results.length,
        unavailable: results.filter(({ status }) => status === 'unavailable').length
    };
}

async function main() {
    const { values } = parseArgs({ options: {
        db: { type: 'string' }, runs: { type: 'string', default: '2' }, out: { type: 'string' }, queries: { type: 'string' }
    } });
    const runs = Number(values.runs);
    if (!values.db?.trim() || !values.out?.trim() || !Number.isSafeInteger(runs) || runs < 1) {
        throw new Error('Usage: npm run search:eval -- --db <database copy> --queries <private JSON file> --runs 2 --out <new JSONL file>');
    }
    const databaseFile = resolve(values.db);
    if (!statSync(databaseFile).isFile()) throw new Error('--db must be an existing database copy');
    require('dotenv').config({ path: backendPath('.env'), quiet: true });
    const queryFile = values.queries || process.env.PLACE_SEARCH_EVAL_QUERIES;
    if (!queryFile?.trim()) throw new Error('Set --queries or PLACE_SEARCH_EVAL_QUERIES to the private query file');
    const { locations, queries } = JSON.parse(readFileSync(resolve(queryFile), 'utf8'));
    if (!Array.isArray(locations) || !locations.length || !Array.isArray(queries) || !queries.length) {
        throw new Error('The evaluation query file must contain non-empty locations and queries arrays');
    }
    process.env.DB_FILE = databaseFile;
    if (!require('../../infrastructure/numericAlgorithmClient').configuration()) throw new Error('Private calculation service is not configured');
    if (!require('../../infrastructure/aiClients').hasDeepseekConfiguration()) throw new Error('DEEPSEEK_API_KEY is not configured');
    const out = openSync(resolve(values.out), 'wx');
    const write = (row) => writeSync(out, JSON.stringify(row) + '\n');
    try {
        const { db, init } = require('../../infrastructure/database');
        const { searchSemanticPlaces } = require('../../modules/discovery/services/semanticSearch');
        const { compileSearchQuery } = require('../../modules/discovery/services/searchFilter');
        try {
            init();
            const results = [];
            for (let run = 1; run <= runs; run++) {
                for (const { name: location, center, bounds } of locations) {
                    for (const query of queries) {
                        const start = performance.now();
                        let usedVector = false;
                        const result = await searchSemanticPlaces(query, { center, bounds, includeDiagnostics: true,
                            compile: (text, options) => compileSearchQuery(text, { ...options, useCache: false }),
                            onVectorLookup: () => { usedVector = true; }
                        }).catch((error) => ({ status: 'unavailable', error: error.message, recommendations: [], matches: [] }));
                        const row = { type: 'search', run, location, query, status: result.status,
                            elapsed_ms: Math.round(performance.now() - start), used_vector: usedVector,
                            conditions: result.conditions ?? null, filter: result.filter ?? null, error: result.error,
                            matches: result.matches.map(({ place, source }) => ({ id: place.id, source })),
                            cards: result.recommendations.map(({ place, source, review_source, review_confidence, distance_km, matched, reason }) =>
                                ({ id: place.id, name: place.name, source, review_source, review_confidence, distance_km, matched, reason })) };
                        results.push(row);
                        write(row);
                    }
                }
            }
            const summary = summarize(results);
            write(summary);
            console.log(JSON.stringify(summary));
            if (summary.unavailable) process.exitCode = 1;
        } finally {
            db.close();
        }
    } finally {
        closeSync(out);
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
