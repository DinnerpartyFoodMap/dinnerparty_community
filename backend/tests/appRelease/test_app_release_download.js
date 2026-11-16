// 安卓安装包下载（modules/appRelease/routes/appRelease.js）：latest.apk 跳到带版本号的地址且不缓存，
// 带版本号的地址长期缓存、支持断点续传与 304，只认发版目录里的 .apk 文件名。临时目录 + 本地 express。
// npm run test:app-release
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-app-release-'));
Object.assign(process.env, { APP_RELEASE_DIR: temp, LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' });

const express = require('express');
let server = null;

function request(base, url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(base + url, { headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    const app = express();
    app.use('/api/app', require('../../modules/appRelease/routes/appRelease'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const name = 'dinnerparty-2.2.4-1101.apk';

    // 还没上传安装包
    let res = await request(base, '/api/app/android/latest.apk');
    assert.equal(res.status, 404);
    assert.equal(res.headers['cache-control'], 'no-cache');

    fs.writeFileSync(path.join(temp, name), 'apk-bytes-0123456789');
    fs.writeFileSync(path.join(temp, 'release.json'), JSON.stringify({ android: { build: 1101, version: '2.2.4', file: name } }));

    // 固定入口：跳到当前版本的地址，相对地址经 /backend 前缀转发时仍落在同一目录，跳转本身不缓存
    res = await request(base, '/api/app/android/latest.apk');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, name);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(new URL(res.headers.location, 'https://www.dinnerparty.cc/backend/api/app/android/latest.apk').pathname, `/backend/api/app/android/${name}`);

    // 带版本号的地址：内容、类型、下载文件名，长期缓存
    res = await request(base, `/api/app/android/${name}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'apk-bytes-0123456789');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(res.headers['content-type'], 'application/vnd.android.package-archive');
    assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="${name}"`));
    assert.equal(res.headers['accept-ranges'], 'bytes');
    const etag = res.headers.etag;
    assert.ok(etag);

    // 断点续传与条件请求
    res = await request(base, `/api/app/android/${name}`, { Range: 'bytes=4-8' });
    assert.equal(res.status, 206);
    assert.equal(res.body.toString(), 'bytes');
    assert.equal(res.headers['content-range'], 'bytes 4-8/20');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    res = await request(base, `/api/app/android/${name}`, { 'If-None-Match': etag });
    assert.equal(res.status, 304);

    // 发新版：入口立即指向新文件，旧文件名仍能下载（内容不变）
    const next = 'dinnerparty-2.2.5-1120.apk';
    fs.writeFileSync(path.join(temp, next), 'new-apk');
    fs.writeFileSync(path.join(temp, 'release.json'), JSON.stringify({ android: { build: 1120, version: '2.2.5', file: next } }));
    res = await request(base, '/api/app/android/latest.apk');
    assert.equal(res.headers.location, next);
    assert.equal((await request(base, `/api/app/android/${name}`)).body.toString(), 'apk-bytes-0123456789');

    // 只认发版目录里的 .apk 文件名
    for (const bad of ['missing.apk', 'release.json', '..%2Frelease.json', '..%2F..%2Fpackage.json', '%2E%2E%2Fsecret.apk']) {
        res = await request(base, `/api/app/android/${bad}`);
        assert.equal(res.status, 404, bad);
        assert.notEqual(res.headers['cache-control'], 'public, max-age=31536000, immutable', `${bad} must not be cached`);
    }
    fs.writeFileSync(path.join(path.dirname(temp), 'outside-secret.apk'), 'secret');
    res = await request(base, `/api/app/android/..%2F${encodeURIComponent('outside-secret.apk')}`);
    assert.equal(res.status, 404, 'no path traversal out of the release directory');
    fs.rmSync(path.join(path.dirname(temp), 'outside-secret.apk'), { force: true });

    console.log('App release download passed: latest redirect (no-cache, relative), versioned immutable file, range, 304, new release, refused names.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    fs.rmSync(temp, { recursive: true, force: true });
});
