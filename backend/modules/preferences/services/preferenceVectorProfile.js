const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('../../../infrastructure/aiClients');
const { decodeVector } = require('./vectorCodec');

const ALGORITHM_VERSION = 2;

function publicPreference(row) {
    if (!row) return null;
    const vector = decodeVector(row.vector);
    return {
        status: row.status, vector: vector ? Array.from(vector) : null,
        model: row.model, dimensions: row.dimensions, algorithm_version: row.algorithm_version,
        source_place_count: row.source_place_count, vector_place_count: row.vector_place_count,
        total_weight: row.total_weight, updated_at: row.updated_at
    };
}

function isUsablePreference(preference) {
    if (preference?.status !== 'ready' || preference.model !== EMBEDDING_MODEL
        || preference.dimensions !== EMBEDDING_DIMENSIONS || preference.algorithm_version !== ALGORITHM_VERSION
        || preference.vector?.length !== EMBEDDING_DIMENSIONS) return false;
    const vectorCount = Number(preference.vector_place_count);
    const sourceCount = Number(preference.source_place_count);
    return Number.isFinite(vectorCount) && Number.isFinite(sourceCount) && vectorCount > 0 && sourceCount >= vectorCount;
}

module.exports = { ALGORITHM_VERSION, publicPreference, isUsablePreference };
