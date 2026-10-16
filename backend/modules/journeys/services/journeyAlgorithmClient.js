const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OPERATIONS = new Set(['reconstruct', 'search', 'rank', 'merge', 'clarify', 'share']);
const SAFE_ERROR = Symbol('journeyAlgorithmError');
const ERROR_CODES = {
    400: ['invalid_input'], 409: ['conflict'], 410: ['gone'], 413: ['payload_too_large'],
    429: ['rate_limited', 'capacity_exceeded'], 503: ['unavailable', 'timeout', 'aborted']
};
const MESSAGES = {
    400: '日记算法请求无效，请检查输入', 409: '日记内容或请求已变化，请重新操作',
    410: '此日记算法请求已失效，请重新发起', 413: '日记算法请求内容过大，请减少素材',
    429: '日记算法服务繁忙，请稍后重试', 502: '日记算法服务返回无效结果，请稍后重试',
    503: '日记算法服务暂不可用，手动编辑仍可使用'
};
const unavailableCapabilities = () => ({text_ai:false, vision_ai:false, amap_search:false, amap_export:false, version:null});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum, nonempty = false) => typeof value === 'string' && value.length <= maximum && (!nonempty || value.trim().length > 0);
const identifier = value => text(value, 160, true) && !/[\u0000-\u001f\u007f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function failure(status, code = ERROR_CODES[status]?.[0] || 'upstream_error', retryAfter) {
    const error = Object.assign(new Error(MESSAGES[status] || MESSAGES[502]), {status, statusCode:status, code});
    error[SAFE_ERROR] = true;
    if (integer(retryAfter) && retryAfter <= 86400) {
        error.retry_after = retryAfter;
        error.details = {retry_after:retryAfter};
    }
    if (code === 'aborted') error.name = 'AbortError';
    return error;
}

function timeout(value, fallback = DEFAULT_TIMEOUT_MS) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : fallback;
}

function configuration() {
    const timeoutMs = timeout(process.env.JOURNEY_ALGORITHM_TIMEOUT_MS);
    const raw = String(process.env.JOURNEY_ALGORITHM_SERVICE_URL || '').trim();
    const token = String(process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN || '').trim();
    if (!raw || !token || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token) || /[?#]/.test(raw)) return {url:'', token:'', timeoutMs};
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return {url:'', token:'', timeoutMs};
        return {url:url.href.replace(/\/+$/, ''), token, timeoutMs};
    } catch {
        return {url:'', token:'', timeoutMs};
    }
}

function configured() { return !!configuration().url; }

function validCoordinates(value) {
    const absent = value.lng == null && value.lat == null;
    return absent || (Number.isFinite(value.lng) && Math.abs(value.lng) <= 180 && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90);
}

function validCandidate(value) {
    return object(value) && identifier(value.id) && text(value.name, 200, true) &&
        Number.isFinite(value.lng) && Math.abs(value.lng) <= 180 && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 &&
        ['local', 'amap'].includes(value.source) && (value.place_id == null || (integer(value.place_id) && value.place_id > 0)) &&
        (value.address === undefined || text(value.address, 1000)) && (value.score === undefined || Number.isFinite(value.score)) &&
        (value.suggested === undefined || typeof value.suggested === 'boolean') && (value.geo_ok === undefined || typeof value.geo_ok === 'boolean');
}

function validCandidates(value) { return Array.isArray(value) && value.length <= 100 && value.every(validCandidate) && new Set(value.map(c => c.id)).size === value.length; }

function validDocument(value) {
    if (!object(value) || !text(value.title, 120, true) || !text(value.start_date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.start_date) ||
        !text(value.end_date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.end_date) || !Array.isArray(value.stops) || value.stops.length > 60) return false;
    if (value.summary !== undefined && !text(value.summary, 5000)) return false;
    if (value.entry_media_ids !== undefined && (!Array.isArray(value.entry_media_ids) || value.entry_media_ids.length > 60 || !value.entry_media_ids.every(identifier))) return false;
    return value.stops.every(stop => object(stop) && identifier(stop.id) && text(stop.name, 200, true) && validCoordinates(stop) &&
        (stop.candidates === undefined || validCandidates(stop.candidates)) &&
        (stop.expenses === undefined || (Array.isArray(stop.expenses) && stop.expenses.length <= 100 && stop.expenses.every(object))) &&
        (stop.confirmed === undefined || typeof stop.confirmed === 'boolean') &&
        (stop.visit_status === undefined || ['visited', 'planned', 'unknown'].includes(stop.visit_status))) &&
        new Set(value.stops.map(stop => stop.id)).size === value.stops.length;
}

function validQuestions(value) {
    return Array.isArray(value) && value.length <= 60 && value.every(question => object(question) && identifier(question.stop_id) && text(question.prompt, 2000, true));
}

function validResolution(value) {
    return object(value) && ['ready', 'partial', 'needs_input'].includes(value.status) && validQuestions(value.questions);
}

function validRank(value) {
    return object(value) && text(value.basis, 500000, true) && text(value.algorithm_version, 120, true) && validResolution(value.resolution) &&
        Array.isArray(value.patches) && value.patches.length <= 60 && value.patches.every(patch => object(patch) && identifier(patch.stop_id) &&
            ['named', 'clue', 'broad'].includes(patch.candidate_basis) && validCandidates(patch.candidates) &&
            (patch.suggested_id === null || (identifier(patch.suggested_id) && patch.candidates.some(candidate => candidate.id === patch.suggested_id)))) &&
        new Set(value.patches.map(patch => patch.stop_id)).size === value.patches.length;
}

function validMerge(value) {
    return object(value) && validDocument(value.document) && Array.isArray(value.sources) && value.sources.length === 2 &&
        value.sources.every(source => object(source) && identifier(source.id) && integer(source.revision) && source.revision > 0) &&
        value.sources[0].id !== value.sources[1].id && Array.isArray(value.conflicts) && value.conflicts.length <= 200 && value.conflicts.every(object) &&
        Array.isArray(value.warnings) && value.warnings.length <= 200 && value.warnings.every(warning => text(warning, 4000)) &&
        integer(value.total_minor) && typeof value.preview_hash === 'string' && /^[a-f0-9]{64}$/.test(value.preview_hash) &&
        ['constraints', 'source', 'time'].includes(value.order_policy);
}

function validResult(operation, value) {
    switch (operation) {
    case 'reconstruct':
        return object(value) && validDocument(value.document) && (value.questions === undefined || validQuestions(value.questions)) &&
            (value.resolution === undefined || validResolution(value.resolution)) &&
            (value.algorithm_version === undefined || text(value.algorithm_version, 120, true));
    case 'search': return validCandidates(value);
    case 'rank': return validRank(value);
    case 'merge': return validMerge(value);
    case 'clarify': return validRank(value) && value.kind === 'clarification' && identifier(value.draft_id) && integer(value.draft_revision) && value.draft_revision > 0 &&
        object(value.answer) && identifier(value.answer.stop_id) && text(value.answer.text, 1000, true) && text(value.answer.city, 50);
    case 'share': return object(value) && text(value.text, 4000, true);
    default: return false;
    }
}

function validEnvelope(value) {
    return object(value) && value.protocol_version === 1 && Object.keys(value).length === 2 && Object.hasOwn(value, 'result');
}

async function readJson(response) {
    const length = response.headers.get('content-length');
    if ((length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) ||
        !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw failure(502, 'invalid_response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure(502, 'invalid_response');
    let bytes = 0;
    const chunks = [];
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw failure(502, 'invalid_response');
            }
            chunks.push(Buffer.from(value));
        }
        try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
        catch { throw failure(502, 'invalid_response'); }
    } finally { reader.releaseLock(); }
}

async function request(config, endpoint, {input, requestId, signal, timeoutMs} = {}) {
    if (signal?.aborted) throw failure(503, 'aborted');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout(timeoutMs, config.timeoutMs));
    try {
        const response = await fetch(`${config.url}${endpoint}`, {
            method:input === undefined ? 'GET' : 'POST', redirect:'error', signal:controller.signal,
            headers:{Authorization:`Bearer ${config.token}`, Accept:'application/json', 'Content-Type':'application/json', 'Cache-Control':'no-store'},
            body:input === undefined ? undefined : JSON.stringify({request_id:requestId, input})
        });
        const body = await readJson(response);
        if (!response.ok) {
            const status = ERROR_CODES[response.status] ? response.status : response.status === 504 ? 503 : 502;
            const remoteError = object(body) && body.protocol_version === 1 && object(body.error) ? body.error : null;
            const code = ERROR_CODES[status]?.includes(remoteError?.code) ? remoteError.code : ERROR_CODES[status]?.[0] || 'upstream_error';
            throw failure(status, response.status === 504 ? 'timeout' : code, remoteError?.retry_after);
        }
        if (!validEnvelope(body)) throw failure(502, 'invalid_response');
        return body.result;
    } catch (error) {
        if (error[SAFE_ERROR]) throw error;
        if (timedOut) throw failure(503, 'timeout');
        if (signal?.aborted) throw failure(503, 'aborted');
        throw failure(503, 'unavailable');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

async function capabilities() {
    const config = configuration();
    if (!config.url) return unavailableCapabilities();
    try {
        const result = await request(config, '/v1/capabilities', {timeoutMs:Math.min(config.timeoutMs, 5000)});
        if (!object(result) || !['text_ai', 'vision_ai', 'amap_search', 'amap_export'].every(key => typeof result[key] === 'boolean') || !text(result.version, 120, true)) return unavailableCapabilities();
        return {text_ai:result.text_ai, vision_ai:result.vision_ai, amap_search:result.amap_search, amap_export:result.amap_export, version:result.version};
    } catch { return unavailableCapabilities(); }
}

async function compute(operation, input, {requestId = randomUUID(), signal, timeoutMs} = {}) {
    const config = configuration();
    if (!config.url) throw failure(503, 'unavailable');
    if (!OPERATIONS.has(operation) || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId) || !object(input)) throw failure(400, 'invalid_input');
    const result = await request(config, `/v1/compute/${operation}`, {input, requestId, signal, timeoutMs});
    if (!validResult(operation, result)) throw failure(502, 'invalid_response');
    return result;
}

module.exports = {configured, configuration, capabilities, compute};
