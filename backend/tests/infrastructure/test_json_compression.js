// JSON 响应压缩：npm run test:compression（不打开数据库）
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const { jsonCompression } = require('../../http/middleware/jsonCompression');

const big = Array.from({ length: 400 }, (_, id) => ({ id, name: `地点${id}`, description: '描述'.repeat(10), longitude: 113 + id / 1000, latitude: 23 }));

function request(port, path, { encoding, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

function decode({ headers, raw }) {
    if (headers['content-encoding'] === 'br') return zlib.brotliDecompressSync(raw).toString('utf8');
    if (headers['content-encoding'] === 'gzip') return zlib.gunzipSync(raw).toString('utf8');
    return raw.toString('utf8');
}

async function main() {
    const app = express();
    // 与 index.js 相同：请求日志式的 res.json 包装在压缩之前
    app.use((req, res, next) => { const json = res.json.bind(res); res.json = (body) => json(body); next(); });
    app.use(jsonCompression());
    app.get('/big', (req, res) => res.json(big));
    app.get('/big-send-object', (req, res) => res.send(big));
    app.get('/small', (req, res) => res.json({ ok: true }));
    app.get('/text', (req, res) => res.type('text').send('x'.repeat(5000)));
    app.get('/no-transform', (req, res) => { res.set('Cache-Control', 'no-transform'); res.json(big); });
    app.get('/error', (req, res) => res.status(400).json({ error: '错误'.repeat(600) }));
    app.get('/stream', (req, res) => { res.type('json'); res.write(JSON.stringify(big).slice(0, 2000)); res.end(); });

    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = server.address();
    try {
        const expected = JSON.stringify(big);

        const br = await request(port, '/big', { encoding: 'gzip, deflate, br' });
        assert.equal(br.status, 200);
        assert.equal(br.headers['content-encoding'], 'br');
        assert.match(br.headers.vary, /Accept-Encoding/i);
        assert.match(br.headers['content-type'], /^application\/json; charset=utf-8$/);
        assert.equal(Number(br.headers['content-length']), br.raw.length);
        assert.ok(br.raw.length < expected.length / 4, `br ${br.raw.length} / ${Buffer.byteLength(expected)}`);
        assert.equal(decode(br), expected);

        const gzip = await request(port, '/big', { encoding: 'gzip' });
        assert.equal(gzip.headers['content-encoding'], 'gzip');
        assert.equal(decode(gzip), expected);

        const objectSend = await request(port, '/big-send-object', { encoding: 'gzip' });
        assert.equal(objectSend.headers['content-encoding'], 'gzip', 'res.send(object) goes through res.json and is compressed');
        assert.equal(decode(objectSend), expected);

        for (const encoding of [undefined, 'identity', 'gzip;q=0, br;q=0']) {
            const plain = await request(port, '/big', { encoding });
            assert.equal(plain.headers['content-encoding'], undefined, `no compression for ${encoding}`);
            assert.match(plain.headers.vary, /Accept-Encoding/i, 'caches still learn the response varies');
            assert.equal(plain.raw.toString('utf8'), expected);
        }

        const small = await request(port, '/small', { encoding: 'gzip, br' });
        assert.equal(small.headers['content-encoding'], undefined);
        assert.deepEqual(JSON.parse(small.raw.toString('utf8')), { ok: true });

        const text = await request(port, '/text', { encoding: 'gzip, br' });
        assert.equal(text.headers['content-encoding'], undefined, 'only JSON is compressed');

        const noTransform = await request(port, '/no-transform', { encoding: 'gzip, br' });
        assert.equal(noTransform.headers['content-encoding'], undefined);

        const error = await request(port, '/error', { encoding: 'gzip' });
        assert.equal(error.status, 400);
        assert.equal(error.headers['content-encoding'], 'gzip');
        assert.equal(JSON.parse(decode(error)).error, '错误'.repeat(600));

        const stream = await request(port, '/stream', { encoding: 'gzip, br' });
        assert.equal(stream.headers['content-encoding'], undefined, 'streamed writes are untouched');

        const head = await request(port, '/big', { encoding: 'gzip', method: 'HEAD' });
        assert.equal(head.headers['content-encoding'], undefined);
        assert.equal(head.raw.length, 0);

        // ETag 按压缩后的内容计算，同一编码的条件请求仍能 304
        const etag = gzip.headers.etag;
        assert.ok(etag);
        const conditional = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: '/big', headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
        });
        assert.equal(conditional, 304);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    console.log('JSON compression passed: br/gzip negotiation, res.send(object), thresholds, non-JSON, no-transform, errors, streams, HEAD and ETag.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
