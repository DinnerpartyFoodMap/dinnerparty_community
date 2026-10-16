const { db } = require('../../../infrastructure/database');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('../../../infrastructure/aiClients');
const { decodeVector, ALGORITHM_VERSION } = require('../../preferences/services/userPreferenceService');

const SIMILARITY_SHARPNESS = 3;
const MEAN_VECTOR_TTL_MS = 30 * 60 * 1000;
let meanCache = null;

// Remove the common restaurant direction before comparing two taste profiles.
function placeMeanVector(now = Date.now()) {
    if (meanCache && now - meanCache.computedAt < MEAN_VECTOR_TTL_MS) return meanCache.vector;
    const sum = new Float64Array(EMBEDDING_DIMENSIONS);
    let count = 0;
    for (const row of db._raw.prepare(`SELECT v.embedding FROM place_vectors v
        JOIN Place p ON p.id = v.place_id WHERE p.has_vector = 1`).iterate()) {
        const vector = decodeVector(row.embedding);
        if (!vector) continue;
        for (let i = 0; i < sum.length; i += 1) sum[i] += vector[i];
        count += 1;
    }
    const vector = count ? sum.map((value) => value / count) : null;
    meanCache = { vector, computedAt: now };
    return vector;
}

function compatibleProfile(row) {
    return row && row.status === 'ready' && row.model === EMBEDDING_MODEL
        && row.dimensions === EMBEDDING_DIMENSIONS && row.algorithm_version === ALGORITHM_VERSION;
}

function prepareTasteProfile(row, mean) {
    if (!mean || !compatibleProfile(row)) return null;
    const vector = Buffer.isBuffer(row.vector) ? decodeVector(row.vector) : row.vector;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) return null;
    const centered = new Float64Array(EMBEDDING_DIMENSIONS);
    let squaredNorm = 0;
    for (let i = 0; i < centered.length; i += 1) {
        centered[i] = vector[i] - mean[i];
        squaredNorm += centered[i] * centered[i];
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= 1e-6) return null;
    for (let i = 0; i < centered.length; i += 1) centered[i] /= norm;
    return { vector: centered, reliability: Math.min(1, Math.max(0, Number(row.vector_place_count) || 0) / 5) };
}

function tasteSimilarity(left, right) {
    if (!left || !right) return 0;
    let cosine = 0;
    for (let i = 0; i < left.vector.length; i += 1) cosine += left.vector[i] * right.vector[i];
    return Math.max(-1, Math.min(1, cosine)) * left.reliability * right.reliability;
}

module.exports = {
    SIMILARITY_SHARPNESS, placeMeanVector, compatibleProfile, prepareTasteProfile, tasteSimilarity,
    resetMeanVectorCache: () => { meanCache = null; }
};
