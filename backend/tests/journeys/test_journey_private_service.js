// Optional real-service integration. Public tests never need private source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const privateDirectory = process.env.JOURNEY_PRIVATE_SERVICE_DIR;
const servers = new Set();
let temp, sql, stopWorker;

async function listen(server) {
    servers.add(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    if (!servers.has(server)) return;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    servers.delete(server);
}
async function main() {
    if (!privateDirectory) {
        console.log('Optional real private journey service integration skipped: JOURNEY_PRIVATE_SERVICE_DIR is unset.');
        return;
    }
    const serverPath = path.join(path.resolve(privateDirectory), 'src', 'server.js');
    assert.ok(fs.existsSync(serverPath), `Private service entry point is missing: ${serverPath}`);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-private-integration-'));
    Object.assign(process.env, {
        DB_FILE: path.join(temp, 'test.sqlite'), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false',
        JOURNEY_ALGORITHM_SERVICE_TOKEN: `integration-${randomUUID()}`,
        JOURNEY_ALGORITHM_CALLBACK_TOKEN: `callback-${randomUUID()}`,
        JOURNEY_ALGORITHM_TIMEOUT_MS: '10000',
        DEEPSEEK_API_KEY: '', JOURNEY_LLM_API_KEY: '', SILICONFLOW_API_KEY: '',
        AMAP_WEB_SERVICE_KEY: '', AMAP_JOURNAL_STORAGE_ALLOWED: 'false', AMAP_EXPORT_ALLOWED: 'false'
    });
    require.cache[require.resolve('../../infrastructure/redis')] = {exports: {isReady: () => false}};
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const sharp = require('sharp');
    const {db, init} = require('../../infrastructure/database');
    sql = db._raw;
    init();
    const userId = randomUUID();
    sql.prepare('INSERT INTO User(id,username,password) VALUES(?,?,?)').run(userId, '真实私有服务集成', 'unused');
    const placeId = Number(sql.prepare('INSERT INTO Place(name,longitude,latitude,address) VALUES(?,?,?,?)')
        .run('集成面馆', 120.15, 30.28, '集成东门路 1 号').lastInsertRowid);
    const token = jwt.sign({id: userId}, process.env.JWT_SECRET || 'yuyuko_secret_key');

    // The only mocked boundary is the model provider. It returns fixed extraction facts.
    const modelRequests = [], callbackRequests = [], providerErrors = [];
    const modelKey = 'local-integration-model-key';
    const provider = http.createServer(async (req, res) => {
        try {
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/chat/completions');
            assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw), content = body.messages[1].content;
            const payload = JSON.parse(Array.isArray(content) ? content.find(item => item.type === 'text').text : content);
            modelRequests.push({payload, content});
            const reply = Array.isArray(payload.facts) ? {text: '集成分享文案'}
                : typeof payload.answer === 'string' ? {query: '集成面馆', city: '杭州'}
                : {title: '真实服务生成', summary: '一次面馆记录', city: '杭州',
                    photos: [{index: 0, kind: 'dish', caption: '一碗面', merchant_text: '集成面馆'}],
                    stops: [{name: '集成面馆', city: '杭州', query: '集成面馆', visit_status: 'visited',
                        quotes: [payload.text], evidence: '原文及照片', media_indices: [0]}]};
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({choices: [{message: {content: JSON.stringify(reply)}}]}));
        } catch (error) {
            providerErrors.push(error);
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Local model fixture failed'}));
        }
    });
    const providerUrl = await listen(provider);
    const app = express();
    app.use(express.json({limit: '256kb'}));
    app.use('/internal/journey-algorithms/places', (req, _res, next) => {
        callbackRequests.push({authorization: req.get('Authorization'), body: req.body});
        next();
    }, require('../../modules/journeys/routes/algorithmPlaces'));
    const publicUrl = await listen(http.createServer(app));
    const callbackUrl = `${publicUrl}/internal/journey-algorithms/places`;
    const serviceEnv = {
        JOURNEY_ALGORITHM_SERVICE_TOKEN: process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN,
        JOURNEY_ALGORITHM_CALLBACK_TOKEN: process.env.JOURNEY_ALGORITHM_CALLBACK_TOKEN,
        JOURNEY_PLACE_LOOKUP_URL: callbackUrl,
        JOURNEY_LLM_API_KEY: modelKey, JOURNEY_LLM_BASE_URL: providerUrl,
        JOURNEY_LLM_MODEL: 'local-integration-model', JOURNEY_LLM_VISION: 'true',
        AMAP_WEB_SERVICE_KEY: '', AMAP_JOURNAL_STORAGE_ALLOWED: 'false', AMAP_EXPORT_ALLOWED: 'false'
    };
    // Real HTTP is retained; prevent this optional test from contacting paid/external services.
    const localFetch = (url, options) => {
        const requested = new URL(String(url));
        assert.ok([providerUrl, publicUrl].includes(requested.origin), 'private service made an unexpected external request');
        return fetch(url, options);
    };
    const {createServer} = require(serverPath);
    const privateServer = createServer({env: serviceEnv, fetch: localFetch});
    process.env.JOURNEY_ALGORITHM_SERVICE_URL = await listen(privateServer);
    app.use('/api/journeys', require('../../modules/journeys/routes/journeys'));
    const ai = require('../../modules/journeys/services/journeyAI');
    const call = async (method, endpoint, body, status = 200) => {
        const response = await fetch(`${publicUrl}/api/journeys${endpoint}`, {
            method, headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const result = response.status === 204 ? null : await response.json();
        assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(result)}`);
        return result;
    };
    const waitJob = async id => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const job = await call('GET', `/jobs/${id}`);
            if (job.status === 'ready') return job;
            assert.notEqual(job.status, 'failed', JSON.stringify(job));
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error('Real private service worker did not complete');
    };

    const capabilities = await call('GET', '/capabilities');
    assert.equal(capabilities.text_ai, true);
    assert.equal(capabilities.vision_ai, true);
    const unauthorized = await fetch(callbackUrl, {method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${process.env.JOURNEY_ALGORITHM_SERVICE_TOKEN}`
    }, body: JSON.stringify({name: '集成面馆'})});
    assert.equal(unauthorized.status, 401, 'the service token cannot authenticate the callback');

    const photo = await sharp({create: {width: 32, height: 24, channels: 3, background: '#d9b980'}}).webp().toBuffer();
    const form = new FormData();
    form.append('image', new Blob([photo], {type: 'image/webp'}), 'integration.webp');
    const uploaded = await fetch(`${publicUrl}/api/journeys/media`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: form});
    assert.equal(uploaded.status, 201);
    const mediaId = (await uploaded.json()).id;
    const composeId = randomUUID(), text = '中午在集成面馆吃了一碗面。';
    await call('PUT', `/compose-drafts/${composeId}`, {revision: 0, payload: {
        text, media_ids: [mediaId], media_notes: {[mediaId]: {kind: 'menu'}},
        start_date: '2026-10-10', end_date: '2026-10-10', intended_visibility: 'private',
        center: {name: '集成东门', city: '杭州', lng: 120.15, lat: 30.28, source: 'map'}
    }});
    const generationInput = {compose_revision: 1, request_id: randomUUID()};
    const generation = await call('POST', `/compose-drafts/${composeId}/generate`, generationInput, 202);
    assert.equal((await call('POST', `/compose-drafts/${composeId}/generate`, generationInput, 202)).id, generation.id);
    stopWorker = ai.startJourneyWorker();
    const ready = await waitJob(generation.id);
    const draft = await call('GET', `/drafts/${ready.draft_id}`);
    assert.equal(draft.compose_draft_id, composeId);
    assert.equal(draft.document.title, '真实服务生成');
    assert.deepEqual(draft.document.entry_media_ids, [mediaId]);
    assert.equal(draft.document.media_meta[mediaId].kind, 'menu');
    assert.equal(draft.document.media_meta[mediaId].kind_source, 'user');
    assert.equal(draft.document.stops[0].excerpts[0].text, text);
    assert.equal(draft.document.stops[0].place_id, placeId);
    assert.equal(draft.document.stops[0].confirmed, false);
    const imageContent = modelRequests[0].content.find(item => item.type === 'image_url');
    const encoded = imageContent.image_url.url.replace(/^data:image\/webp;base64,/, '');
    assert.equal((await sharp(Buffer.from(encoded, 'base64')).metadata()).format, 'webp');
    const validCallbacks = () => callbackRequests.filter(request => request.authorization === `Bearer ${serviceEnv.JOURNEY_ALGORITHM_CALLBACK_TOKEN}`);
    assert.ok(validCallbacks().some(request => request.body.name === '集成面馆'));
    assert.ok(validCallbacks().every(request => Object.keys(request.body).join() === 'name'));

    const ranked = await call('POST', `/drafts/${draft.id}/rank`, {draft_revision: draft.revision});
    assert.equal(ranked.draft_revision, draft.revision);
    assert.equal(ranked.patches[0].suggested_id, `local_${placeId}`);
    const clarification = await call('POST', '/clarifications', {draft_id: draft.id, draft_revision: draft.revision,
        stop_id: draft.document.stops[0].id, answer: '杭州东门的集成面馆', city: '杭州', request_id: randomUUID()}, 202);
    const clarified = await waitJob(clarification.id);
    assert.equal(clarified.output.answer.city, '杭州');
    assert.equal(clarified.output.patches[0].candidates[0].place_id, placeId);
    assert.ok(validCallbacks().length >= 2, 'generation and clarification both use the real place callback');

    const confirmedDocument = {...draft.document, stops: draft.document.stops.map(stop => ({...stop, confirmed: true,
        note: '私人备注不进入默认分享', expenses: [{id: randomUUID(), amount: 28.5, note: '私人账目'}]}))};
    const first = await call('POST', '', {document: confirmedDocument}, 201);
    const shared = await call('POST', `/${first.id}/share`, {base_revision: 1, stop_ids: [first.document.stops[0].id]});
    assert.equal(shared.generated, true);
    assert.equal(shared.text, '集成分享文案');
    const shareFacts = modelRequests.find(request => Array.isArray(request.payload.facts)).payload.facts;
    assert.ok(!JSON.stringify(shareFacts).includes('私人'));
    assert.deepEqual(shareFacts[0].expenses, []);
    const second = await call('POST', '', {document: {...confirmedDocument, title: '第二篇',
        start_date: '2026-10-11', end_date: '2026-10-11', stops: confirmedDocument.stops.map(stop => ({...stop, id: randomUUID(), expenses: []}))}}, 201);
    const mergeInput = {first_id: first.id, second_id: second.id, revisions: [1, 1]};
    const preview = await call('POST', '/merge/preview', mergeInput);
    assert.match(preview.preview_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(preview.conflicts, []);
    await call('POST', '/merge', {...mergeInput, preview_hash: '0'.repeat(64), request_id: randomUUID()}, 409);
    const mergeRequest = {...mergeInput, preview_hash: preview.preview_hash, request_id: randomUUID()};
    const merged = await call('POST', '/merge', mergeRequest, 201);
    assert.equal((await call('POST', '/merge', mergeRequest, 201)).id, merged.id);
    assert.equal(merged.document.sources.length, 2);
    assert.equal(merged.document.stops.length, 2);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM Journey WHERE user_id=?').get(userId).n, 3);

    stopWorker(); stopWorker = null;
    await close(privateServer);
    const unavailable = await call('GET', '/capabilities');
    assert.equal(unavailable.text_ai, false);
    assert.equal(unavailable.vision_ai, false);
    const manual = await call('POST', '', {document: {title: '服务停机时手动记录', start_date: '2026-10-12', end_date: '2026-10-12', stops: []}}, 201);
    const saved = await call('PUT', `/${manual.id}`, {base_revision: 1, document: {...manual.document, title: '手动保存仍可用'}});
    assert.equal(saved.revision, 2);
    assert.equal(saved.document.title, '手动保存仍可用');
    assert.deepEqual(providerErrors, []);
    console.log('Real private journey service integration passed: image generation, place callback, metadata, rank, clarification, share, merge integrity/replay, callback isolation and manual editing during outage.');
}

main().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
    stopWorker?.();
    for (const server of [...servers]) await close(server);
    sql?.close();
    if (temp) {
        const resolved = path.resolve(temp), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
        if (resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('yuyuko-private-integration-')) fs.rmSync(resolved, {recursive: true, force: true});
    }
});
