// Rating features share the same hosted 4B client as map search and preferences.
// Their input templates and PCA remain specific to the frozen rating contract.
const ai = require('../../../infrastructure/aiClients');
const MODEL = 'Qwen/Qwen3-Embedding-4B';
const RECIPE = 'siliconflow-4b-1024-l2-f32-v1';
// Python's research/training string limits count Unicode code points.
function clip(text, limit) { return Array.from(text).slice(0, limit).join(''); }
function configuration() {
    return ai.hasEmbeddingConfiguration() && ai.EMBEDDING_MODEL === MODEL
        ? { model: MODEL, dimensions: ai.EMBEDDING_DIMENSIONS } : null;
}
function validateSpec(spec) {
    if (!spec || spec.model !== MODEL || spec.revision !== RECIPE ||
        spec.transport !== 'backend-embedding-api' || spec.pooling !== 'provider-l2-f32' ||
        spec.dimensions !== 1024 || spec.max_characters !== 12000) {
        throw new Error('Incompatible 4B feature encoder contract; retrain its PCA and models');
    }
}
function normalize(vector) {
    if (!Array.isArray(vector) || vector.length !== 1024 || vector.some(x => !Number.isFinite(x))) {
        throw new Error('Malformed 4B embedding');
    }
    const norm = Math.hypot(...vector);
    if (norm <= 1e-12) throw new Error('Zero 4B embedding');
    return vector.map(x => Math.fround(x / norm));
}
async function encodeTexts(texts, spec, { createEmbeddings = ai.createEmbeddings, config = configuration() } = {}) {
    validateSpec(spec);
    if (!config) return null;
    if (config.model !== MODEL || config.dimensions !== 1024) throw new Error('Configured feature encoder mismatch');
    const output = [];
    for (let start = 0; start < texts.length; start += 16) {
        const batch = texts.slice(start, start + 16).map(text => {
            if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid feature embedding input');
            return clip(text.trim(), spec.max_characters);
        });
        const vectors = await createEmbeddings(batch, { expectedModel: MODEL, requireModel: true });
        if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('Feature embedding count mismatch');
        output.push(...vectors.map(normalize));
    }
    return output;
}
async function encodeProfile(kind, { place, reviews }, spec, assets, options) {
    let texts;
    if (kind === 'description') {
        const price = assets.price_level === null ? 'unknown' : '$'.repeat(assets.price_level);
        texts = [`${place.name || ''}. Categories: ${(assets.categories || []).join(', ')}. Price: ${price}. ${clip(place.description || '', 400)}`.trim()];
    } else if (kind === 'review') {
        texts = reviews.map(r => clip(r.content.trim(), 300)).filter(t => Array.from(t).length >= 20);
    } else throw new Error('Unknown feature embedding kind');
    if (!texts.length) return null;
    const vectors = await encodeTexts(texts, spec, options);
    if (!vectors) return null;
    return vectors[0].map((_, k) => vectors.reduce((sum, v) => sum + v[k], 0) / vectors.length);
}
module.exports = { MODEL, RECIPE, clip, configuration, encodeTexts, encodeProfile };
