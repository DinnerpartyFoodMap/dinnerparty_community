// Upstream failure handling in infrastructure/aiClients.js, against a local fake of the
// SiliconFlow embedding API and the DeepSeek chat API.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-ai-clients-'));
process.env.DB_FILE = path.join(tempDirectory, 'ai-clients.sqlite');
process.env.LOG_TO_FILE = 'false';

const EMBEDDING_DIMENSIONS = 1024;
const queryVector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
let deepseekMode = 'ok';
let embeddingMode = 'ok';
let deepseekContent = '{"ok":true}';
let lastChatPayload = null;

const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
            try { lastChatPayload = JSON.parse(raw); } catch (_) { lastChatPayload = null; }
        }
        if (req.url === '/v1/embeddings') {
            const payload = JSON.parse(raw);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model: embeddingMode === 'wrong_model' ? 'wrong-model' : payload.model,
                data: payload.input.map((_, index) => ({ index: embeddingMode === 'duplicate' ? 0 : index, embedding: queryVector })) }));
            return;
        }
        if (deepseekMode === 'stall') {
            // What DeepSeek sends while a request waits in its queue: 200 at once,
            // then keep-alive blank lines and no answer.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('\n');
            return;
        }
        if (deepseekMode === 'garbage') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>gateway</html>');
            return;
        }
        if (deepseekMode === 'rate_limited') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
            return;
        }
        // A queued request that eventually ran: blank lines, then the JSON body.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`\n\n${JSON.stringify({ choices: [{ message: { content: deepseekContent } }] })}`);
    });
});

async function main() {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    Object.assign(process.env, {
        SILICONFLOW_API_KEY: 'test-key',
        SILICONFLOW_BASE_URL: upstreamUrl,
        EMBEDDING_TIMEOUT_MS: '2000',
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_BASE_URL: upstreamUrl,
        DEEPSEEK_TIMEOUT_MS: '200',
        DEEPSEEK_EXPANSION_TIMEOUT_MS: '200'
    });

    const { db, init, isVectorSearchAvailable } = require('../../infrastructure/database');
    const { expandSearchIntent, completeDeepseekJson, createEmbeddings, EMBEDDING_MODEL } = require('../../infrastructure/aiClients');
    const { searchSemanticPlaces } = require('../../modules/discovery/services/semanticSearch');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        init();

        assert.deepEqual(await createEmbeddings(['one'], { expectedModel: EMBEDDING_MODEL, requireModel: true }), [queryVector]);
        await assert.rejects(createEmbeddings(['one'], { expectedModel: 'wrong-model' }), /feature contract/);
        embeddingMode = 'wrong_model';
        await assert.rejects(createEmbeddings(['one'], { requireModel: true }), /model mismatch/);
        embeddingMode = 'duplicate';
        await assert.rejects(createEmbeddings(['one', 'two']), /indices mismatch/);
        embeddingMode = 'ok';

        deepseekMode = 'stall';
        const stalledIntent = await expandSearchIntent('想吃一顿漂亮饭');
        assert.deepEqual(stalledIntent, {
            needs_expansion: false,
            retrieval_text: '想吃一顿漂亮饭',
            source: 'original'
        }, 'a stalled DeepSeek answer should fall back to the original query');
        assert.ok(
            warnings.some((line) => /DeepSeek intent expansion failed: upstream response body timed out after 200ms \(status 200\)/.test(line)),
            'a stalled DeepSeek answer must be logged'
        );

        deepseekMode = 'ok';
        deepseekContent = '{"needs_expansion":true,"retrieval_text":"菜品摆盘精致、适合拍照"}';
        const recoveredIntent = await expandSearchIntent('想吃一顿漂亮饭');
        assert.equal(recoveredIntent.source, 'deepseek', 'the stalled fallback must not be cached');

        deepseekContent = '{"ok":true}';
        assert.deepEqual(await completeDeepseekJson({ system: 's', user: 'u' }), { ok: true });
        deepseekMode = 'garbage';
        await assert.rejects(completeDeepseekJson({ system: 's', user: 'u' }), /invalid JSON body/);
        deepseekMode = 'rate_limited';
        await assert.rejects(completeDeepseekJson({ system: 's', user: 'u' }), e=>/Rate limit reached/.test(e.message)&&e.code==='upstream_http_error'&&e.httpStatus===429);
        deepseekMode = 'stall';
        await assert.rejects(completeDeepseekJson({ system: 's', user: 'u' }), e=>/body timed out/.test(e.message)&&e.code==='upstream_timeout'&&e.timeoutMs===200);

        assert.ok(isVectorSearchAvailable(), 'sqlite-vec is required for the semantic search fallback test');
        const placeId = Number(db._raw.prepare(`INSERT INTO Place (name, category, description, per_person_cost, latitude, longitude)
                                                VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
                '精致摆盘小馆',
                '创意菜',
                '菜品摆盘精致，适合拍照和朋友聚餐，环境安静有氛围，招牌是季节限定的小份套餐，服务细致，人均价格清楚，适合想吃一顿漂亮饭的时候来。',
                88,
                23.1291,
                113.2644
            ).lastInsertRowid);
        db._raw.prepare('INSERT INTO place_vectors(place_id, embedding) VALUES (?, ?)')
            .run(BigInt(placeId), Buffer.from(new Float32Array(queryVector).buffer));

        warnings.length = 0;
        const result = await searchSemanticPlaces('想吃一顿漂亮饭', {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 }
        });
        assert.equal(result.recommendations.length, 1, 'a stalled DeepSeek review must not reject every candidate');
        assert.equal(result.recommendations[0].place.id, placeId);
        assert.equal(result.recommendations[0].review_source, 'local_fallback');
        assert.ok(
            warnings.some((line) => /DeepSeek relevance review failed: upstream response body timed out/.test(line)),
            'a stalled DeepSeek review must be logged'
        );

        assert.equal(result.recommendations[0].reason_source, 'template');

        // DSC-C09: a completed review only selects and quotes; the sentence is a fixed template.
        const searchPrettyMeal = async (evidence) => {
            deepseekMode = 'ok';
            deepseekContent = JSON.stringify({ recommendations: [{ name: '精致摆盘小馆', relevant: true, confidence: 0.9, evidence }] });
            return searchSemanticPlaces('想吃一顿漂亮饭', {
                center: { lat: 23.1291, lng: 113.2644 },
                bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 }
            });
        };
        const quoted = await searchPrettyMeal('菜品摆盘精致，适合拍照和朋友聚餐');
        const sentDescription = JSON.parse(lastChatPayload.messages[1].content).recommended_places[0].description;
        assert.ok(sentDescription.startsWith('菜品摆盘精致，适合拍照'), 'the review sees the plain description text');
        const reviewPrompt = lastChatPayload.messages[0].content;
        assert.ok(reviewPrompt.includes('"evidence"') && !reviewPrompt.includes('"reason"'), 'the review prompt asks for evidence, not a recommendation sentence');
        assert.equal(quoted.status, 'ok');
        assert.equal(quoted.recommendations[0].review_source, 'deepseek');
        assert.equal(quoted.recommendations[0].reason_source, 'template');
        assert.ok(quoted.recommendations[0].reason.includes('「菜品摆盘精致，适合拍照和朋友聚餐」'), 'a verbatim excerpt is quoted in the template');
        const noEvidence = await searchPrettyMeal('');
        const paraphrased = await searchPrettyMeal('摆盘很精致，拍照好看');
        assert.equal(paraphrased.recommendations[0].reason, noEvidence.recommendations[0].reason, 'a paraphrased excerpt falls back to the template without a quote');
        assert.ok(!paraphrased.recommendations[0].reason.includes('拍照好看'), 'model wording never reaches the sentence');

        // DSC-C10: with a map center the candidates are every place within the radius, not the
        // nationwide top 200. 250 exact matches in Beijing used to push the only nearby
        // noodle shop (cosine 0.9, rank 252) out of the candidates, so a sparse city got nothing.
        const insertPlace = db._raw.prepare(`INSERT INTO Place (name, category, description, per_person_cost, latitude, longitude)
                                             VALUES (?, ?, ?, ?, ?, ?)`);
        const insertVector = db._raw.prepare('INSERT INTO place_vectors(place_id, embedding) VALUES (?, ?)');
        db._raw.transaction(() => {
            for (let index = 0; index < 250; index += 1) {
                const id = insertPlace.run(`北京面馆${index}`, '面馆', '手擀面', 20, 39.9042, 116.4074).lastInsertRowid;
                insertVector.run(BigInt(id), Buffer.from(new Float32Array(queryVector).buffer));
            }
        })();
        const nearbyVector = queryVector.map((_, index) => (index === 0 ? 0.9 : index === 1 ? Math.sqrt(1 - 0.81) : 0));
        const noodleId = Number(insertPlace.run('巷口面馆', '面馆', '现拉的牛肉面，汤是牛骨熬的', 18, 23.138, 113.2644).lastInsertRowid);
        insertVector.run(BigInt(noodleId), Buffer.from(new Float32Array(nearbyVector).buffer));
        deepseekMode = 'ok';
        deepseekContent = JSON.stringify({ recommendations: [{ name: '巷口面馆', relevant: true, confidence: 0.8, evidence: '' }] });
        const sparseCity = await searchSemanticPlaces('附近吃碗面', {
            center: { lat: 23.1291, lng: 113.2644 },
            bounds: { minLat: 23.1, minLng: 113.23, maxLat: 23.16, maxLng: 113.3 }
        });
        const reviewedNames = JSON.parse(lastChatPayload.messages[1].content).recommended_places.map((place) => place.name);
        assert.ok(reviewedNames.includes('巷口面馆') && reviewedNames.length <= 8, 'the nearby shop reaches the review, at most eight are reviewed');
        assert.ok(!reviewedNames.some((name) => name.startsWith('北京面馆')), 'places outside the radius are never candidates');
        assert.deepEqual(sparseCity.recommendations.map((item) => item.place.id), [noodleId]);

        console.log(JSON.stringify({ status: result.status, reviewSource: result.recommendations[0].review_source, quotedReason: quoted.recommendations[0].reason }));
    } finally {
        console.warn = originalWarn;
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
        db.close();
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    try { upstream.closeAllConnections(); upstream.close(); } catch (_) { }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    process.exitCode = 1;
});
