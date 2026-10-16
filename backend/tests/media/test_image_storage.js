// 图片存储：上传格式校验、本地/OSS 两种模式、/uploads 兜底跳转与老图迁移脚本。
// OSS 用 127.0.0.1 上的假服务（IP 地址时 ali-oss 走路径式请求），临时目录与 SQLite，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-image-storage-'));
const uploadsDir = path.join(temp, 'uploads');
fs.mkdirSync(uploadsDir);
const PUBLIC_BASE = 'https://img.example.cc';
const quietEnv = { LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '' };
Object.assign(process.env, quietEnv, { UPLOADS_DIR: uploadsDir, DB_FILE: path.join(temp, 'test.sqlite') });

/** 只实现 PUT / HEAD / GET 的假 OSS，按请求路径（对象键）存内容 */
function startFakeOss() {
    const objects = new Map();
    const server = http.createServer((req, res) => {
        const key = decodeURIComponent(req.url.split('?')[0].slice(1));
        if (req.method === 'PUT') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'], cache: req.headers['cache-control'] });
                res.writeHead(200, { etag: '"x"' }).end();
            });
            return;
        }
        const obj = objects.get(key);
        if (!obj) return res.writeHead(404, { 'content-type': 'application/xml' }).end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>');
        res.writeHead(200, { 'content-length': obj.body.length, 'content-type': obj.type });
        res.end(req.method === 'HEAD' ? undefined : obj.body);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, port: server.address().port })));
}

function ossEnv(port) {
    return {
        IMAGE_STORAGE: 'oss', OSS_REGION: 'oss-cn-hangzhou', OSS_BUCKET: 'shared-bucket',
        OSS_ENDPOINT: `http://127.0.0.1:${port}`, OSS_ACCESS_KEY_ID: 'test-id', OSS_ACCESS_KEY_SECRET: 'test-secret',
        OSS_PREFIX: '/food/', OSS_PUBLIC_BASE_URL: `${PUBLIC_BASE}/`
    };
}

async function startApp() {
    const express = require('express');
    const imageStorage = require('../../modules/media/services/imageStorage');
    const app = express();
    app.use('/uploads', express.static(imageStorage.LOCAL_UPLOAD_DIR, { maxAge: '365d', immutable: true }));
    app.get('/uploads/*', (req, res, next) => {
        const target = imageStorage.legacyRedirectUrl(req.params[0]);
        if (!target) return next();
        res.redirect(302, target);
    });
    app.use('/upload', require('../../modules/media/routes/upload'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { server, base: `http://127.0.0.1:${server.address().port}`, imageStorage };
}

async function postImage(base, buffer, filename, type) {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type }), filename);
    const res = await fetch(`${base}/upload`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

async function sampleImages() {
    const sharp = require('sharp');
    return {
        jpeg: await sharp({ create: { width: 32, height: 24, channels: 3, background: '#e07050' } }).jpeg().toBuffer(),
        png: await sharp({ create: { width: 16, height: 16, channels: 4, background: '#70a0e0' } }).png().toBuffer()
    };
}

// 子进程：OSS 模式的上传接口（配置在模块加载时读取，需独立进程）
async function childOssUpload() {
    const { jpeg } = await sampleImages();
    const { server, base } = await startApp();
    const ok = await postImage(base, jpeg, 'photo.html', 'image/jpeg');
    const redirect = await fetch(`${base}/uploads/gone.jpg`, { redirect: 'manual' });
    const nested = await fetch(`${base}/uploads/abc123/old.jpg`, { redirect: 'manual' });
    const unsafe = await fetch(`${base}/uploads/..%2Fsecret.jpg`, { redirect: 'manual' });
    server.close();
    process.stdout.write(JSON.stringify({ ok, redirect: [redirect.status, redirect.headers.get('location')], nested: nested.headers.get('location'), unsafe: unsafe.status }));
}

// 异步子进程：假 OSS 跑在本进程里，不能用 spawnSync 阻塞事件循环
function runNode(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '../..'), env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`子进程失败（${code}）：${stderr}
${stdout}`))));
    });
}

async function main() {
    const imageStorageConfig = require('../../modules/media/services/imageStorage');
    // 配置校验：OSS 模式缺项会列出；前缀去掉首尾斜杠
    const missing = imageStorageConfig.configErrors(imageStorageConfig.readConfig({ IMAGE_STORAGE: 'oss', OSS_PREFIX: '/' }));
    assert.ok(missing.some((e) => e.includes('OSS_BUCKET')));
    assert.ok(missing.some((e) => e.includes('OSS_PREFIX')));
    assert.deepEqual(imageStorageConfig.configErrors(imageStorageConfig.readConfig({ IMAGE_STORAGE: 'local' })), []);
    assert.equal(imageStorageConfig.readConfig(ossEnv(1)).prefix, 'food');
    assert.deepEqual(imageStorageConfig.configErrors(imageStorageConfig.readConfig({ ...ossEnv(1), OSS_PUBLIC_BASE_URL: 'http://img.example.cc' })), ['OSS_PUBLIC_BASE_URL 必须是 https:// 地址']);

    // 地点图片修复：损坏 JSON 拆回数组（缺引号、缺结尾 "]），截断地址不修；失效的本站图片可移除
    const { repairList, collect } = require('../../scripts/images/repair_place_images');
    assert.deepEqual(repairList('["https://a.cc/uploads/x/1_thumb.jpeg,\r\n"https://a.cc/uploads/y.jpg",\r\n"https://a.cc/z.png"]'),
        ['https://a.cc/uploads/x/1_thumb.jpeg', 'https://a.cc/uploads/y.jpg', 'https://a.cc/z.png']);
    assert.deepEqual(repairList('["https://a.cc/1.jpeg,\r\n"https://a.cc/3.jpeg'), ['https://a.cc/1.jpeg', 'https://a.cc/3.jpeg']);
    assert.equal(repairList('["https://a.cc/upl'), null);
    assert.equal(repairList('["https://a.cc/1.jpeg", "not a url.jpg"]'), null);
    const rows = [
        { id: 1, name: 'a', exterior_images: '["https://cn.dinnerparty.cc:2053/uploads/d/snap_1.jpeg,\r\n"https://cn.dinnerparty.cc:2053/uploads/ok.jpg"', menu_images: null },
        { id: 2, name: 'b', exterior_images: JSON.stringify(['https://dinnerparty.cc/backend/uploads/gone.jpg', 'https://other.example/uploads/gone.jpg']), menu_images: '[]' },
        { id: 3, name: 'c', exterior_images: JSON.stringify(['https://img.example.cc/food/x.jpg']), menu_images: 'garbage' }
    ];
    const fakeSql = { prepare: () => ({ all: () => rows }) };
    const exists = (name) => name === 'ok.jpg';
    const keep = collect(fakeSql, { dropMissing: false, exists });
    assert.deepEqual(keep.updates.map((u) => [u.row.id, u.next]), [[1, { exterior_images: JSON.stringify(['https://cn.dinnerparty.cc:2053/uploads/d/snap_1.jpeg', 'https://cn.dinnerparty.cc:2053/uploads/ok.jpg']) }]]);
    assert.deepEqual(keep.unfixable, ['地点 3（c）menu_images']);
    assert.deepEqual(keep.stats, { localRefs: 3, missingRefs: 2 });
    const drop = collect(fakeSql, { dropMissing: true, exists });
    assert.deepEqual(drop.updates.map((u) => [u.row.id, u.next]), [
        [1, { exterior_images: JSON.stringify(['https://cn.dinnerparty.cc:2053/uploads/ok.jpg']) }],
        [2, { exterior_images: JSON.stringify(['https://other.example/uploads/gone.jpg']) }]
    ]);

    // 本地模式：按真实内容定扩展名，拒绝伪装成图片的文件，未知文件不跳转
    const { jpeg, png } = await sampleImages();
    const { server, base } = await startApp();
    const saved = await postImage(base, png, 'evil.html', 'image/png');
    assert.equal(saved.status, 200);
    assert.match(saved.body.url, /^\/uploads\/\d{13}-\d+\.png$/);
    const served = await fetch(`${base}${saved.body.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('cache-control'), /immutable/);
    const fake = await postImage(base, Buffer.from('<script>alert(1)</script>'), 'x.jpg', 'image/jpeg');
    assert.equal(fake.status, 400);
    assert.equal((await postImage(base, Buffer.from('hello'), 'x.txt', 'text/plain')).status, 400);

    // 去隐私元数据：方向正常的 JPEG 只删 Exif（含 GPS）段、像素不变；带旋转方向的摆正后重新编码；PNG 元数据也去掉
    const sharp = require('sharp');
    const storedFile = (url) => fs.readFileSync(path.join(uploadsDir, url.replace(/^\/uploads\//, '')));
    const withGps = (image) => image.withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 7/1 0/1' } });
    const gpsJpeg = await withGps(sharp({ create: { width: 40, height: 30, channels: 3, background: '#e07050' } }).jpeg({ quality: 90 })).toBuffer();
    assert.ok((await sharp(gpsJpeg).metadata()).exif, '测试图应带 Exif');
    const cleanJpeg = storedFile((await postImage(base, gpsJpeg, 'gps.jpg', 'image/jpeg')).body.url);
    assert.equal((await sharp(cleanJpeg).metadata()).exif, undefined);
    assert.equal(cleanJpeg.includes(Buffer.from('TestPhone')), false);
    assert.ok(cleanJpeg.length < gpsJpeg.length);
    assert.ok((await sharp(cleanJpeg).raw().toBuffer()).equals(await sharp(gpsJpeg).raw().toBuffer()), '只删元数据，像素完全不变');
    const rotatedJpeg = await withGps(sharp({ create: { width: 40, height: 30, channels: 3, background: '#70a0e0' } }).jpeg()).withMetadata({ orientation: 6 }).toBuffer();
    const upright = await sharp(storedFile((await postImage(base, rotatedJpeg, 'r.jpg', 'image/jpeg')).body.url)).metadata();
    assert.deepEqual([upright.width, upright.height, upright.orientation, upright.exif], [30, 40, undefined, undefined], '按方向摆正并去掉 Exif');
    const gpsPng = await withGps(sharp({ create: { width: 16, height: 16, channels: 4, background: '#70a0e0' } }).png()).toBuffer();
    assert.ok((await sharp(gpsPng).metadata()).exif);
    assert.equal((await sharp(storedFile((await postImage(base, gpsPng, 'p.png', 'image/png')).body.url)).metadata()).exif, undefined);
    assert.equal(imageStorageConfig.stripJpegMetadata(Buffer.from('not a jpeg')), null);
    assert.equal(imageStorageConfig.stripJpegMetadata(jpeg), jpeg, '没有元数据时原样返回');
    assert.equal((await fetch(`${base}/uploads/missing.jpg`, { redirect: 'manual' })).status, 404);
    server.close();

    const oss = await startFakeOss();
    try {
        // OSS 模式：对象键带前缀，返回自有域名地址，带长期缓存头；本地没有的旧文件跳转到 OSS
        const child = JSON.parse(await runNode([__filename, '--child-oss-upload'], ossEnv(oss.port)));
        assert.equal(child.ok.status, 200);
        const match = child.ok.body.url.match(/^https:\/\/img\.example\.cc\/food\/(\d{13}-\d+\.jpg)$/);
        assert.ok(match, child.ok.body.url);
        const stored = oss.objects.get(`food/${match[1]}`);
        assert.ok(stored && stored.body.equals(jpeg));
        assert.equal(stored.type, 'image/jpeg');
        assert.match(stored.cache, /immutable/);
        assert.deepEqual(child.redirect, [302, `${PUBLIC_BASE}/food/gone.jpg`]);
        assert.equal(child.nested, `${PUBLIC_BASE}/food/abc123/old.jpg`);
        assert.equal(child.unsafe, 404);

        // 迁移：准备本地文件与引用各种历史地址的数据
        oss.objects.clear();
        for (const name of fs.readdirSync(uploadsDir)) fs.rmSync(path.join(uploadsDir, name));
        fs.writeFileSync(path.join(uploadsDir, '1785342226135-927046356.jpg'), jpeg);
        fs.writeFileSync(path.join(uploadsDir, 'c87da39bc99e43db27d62d4a44442692.png'), png);
        fs.mkdirSync(path.join(uploadsDir, '16a8208516677a2e375e8c41bcfcc7ab'));
        fs.writeFileSync(path.join(uploadsDir, '16a8208516677a2e375e8c41bcfcc7ab', 'snapshot_temp_1_thumb.jpeg'), jpeg);
        const { db, init } = require('../../infrastructure/database');
        init();
        const sql = db._raw;
        const external = 'https://amap-wia-oss-files.oss-cn-zhangjiakou.aliyuncs.com/487f/uploads/1785342226135-927046356.jpg';
        const p1 = Number(sql.prepare('INSERT INTO Place(name, exterior_images, menu_images) VALUES (?, ?, ?)').run('迁移测试',
            JSON.stringify(['https://cn.dinnerparty.cc:2053/uploads/1785342226135-927046356.jpg', external, '/uploads/missing.jpg']),
            JSON.stringify(['https://dinnerparty.cc/backend/uploads/c87da39bc99e43db27d62d4a44442692.png'])).lastInsertRowid);
        const p2 = Number(sql.prepare('INSERT INTO Place(name, exterior_images) VALUES (?, ?)').run('无本地图', JSON.stringify([external])).lastInsertRowid);
        // 早期数据：子目录图片 + 引号缺失的损坏 JSON
        const brokenJson = '["https://cn.dinnerparty.cc:2053/uploads/16a8208516677a2e375e8c41bcfcc7ab/snapshot_temp_1_thumb.jpeg,\r\n"https://cn.dinnerparty.cc:2053/uploads/c87da39bc99e43db27d62d4a44442692.png"]';
        const p3 = Number(sql.prepare('INSERT INTO Place(name, exterior_images) VALUES (?, ?)').run('损坏记录', brokenJson).lastInsertRowid);
        const r1 = Number(sql.prepare('INSERT INTO PlaceRequest(place_id, proposed) VALUES (?, ?)').run(p1,
            JSON.stringify({ name: 'x', exterior_images: ['http://dinnerparty.cc:2053/uploads/c87da39bc99e43db27d62d4a44442692.png'], menu_images: [] })).lastInsertRowid);
        const before = sql.prepare('SELECT exterior_images, menu_images FROM Place WHERE id = ?').get(p1);
        db.close();

        const script = path.join(__dirname, '../../scripts/images/migrate_uploads_to_oss.js');
        const dry = await runNode([script], ossEnv(oss.port));
        assert.match(dry, /待上传 3/);
        assert.match(dry, /将改写：地点 2 个、修改申请 1 条、图片地址 5 个/);
        assert.equal(oss.objects.size, 0, '预演不能上传');

        const applied = await runNode([script, '--apply'], ossEnv(oss.port));
        assert.match(applied, /新上传 3/);
        assert.match(applied, /已改写：地点 2 个、修改申请 1 条、图片地址 5 个/);
        assert.match(applied, new RegExp(`JSON 损坏、已按原文替换地址的记录 1 条：地点 ${p3}`));
        assert.equal(oss.objects.get('food/16a8208516677a2e375e8c41bcfcc7ab/snapshot_temp_1_thumb.jpeg').type, 'image/jpeg');
        assert.match(applied, /missing\.jpg/);
        assert.equal(oss.objects.get('food/1785342226135-927046356.jpg').type, 'image/jpeg');
        assert.equal(oss.objects.get('food/c87da39bc99e43db27d62d4a44442692.png').type, 'image/png');
        assert.ok(fs.existsSync(path.join(uploadsDir, '1785342226135-927046356.jpg')), '本地文件保留');
        const backups = fs.readdirSync(temp).filter((n) => n.includes('.pre-oss-'));
        assert.equal(backups.length, 1);

        const Database = require('better-sqlite3');
        const check = new Database(path.join(temp, 'test.sqlite'), { readonly: true });
        const after = check.prepare('SELECT exterior_images, menu_images FROM Place WHERE id = ?').get(p1);
        assert.deepEqual(JSON.parse(after.exterior_images), [`${PUBLIC_BASE}/food/1785342226135-927046356.jpg`, external, '/uploads/missing.jpg']);
        assert.deepEqual(JSON.parse(after.menu_images), [`${PUBLIC_BASE}/food/c87da39bc99e43db27d62d4a44442692.png`]);
        assert.equal(check.prepare('SELECT exterior_images FROM Place WHERE id = ?').get(p2).exterior_images, JSON.stringify([external]));
        assert.equal(check.prepare('SELECT exterior_images FROM Place WHERE id = ?').get(p3).exterior_images,
            `["${PUBLIC_BASE}/food/16a8208516677a2e375e8c41bcfcc7ab/snapshot_temp_1_thumb.jpeg,\r\n"${PUBLIC_BASE}/food/c87da39bc99e43db27d62d4a44442692.png"]`);
        const proposed = JSON.parse(check.prepare('SELECT proposed FROM PlaceRequest WHERE id = ?').get(r1).proposed);
        assert.deepEqual(proposed.exterior_images, [`${PUBLIC_BASE}/food/c87da39bc99e43db27d62d4a44442692.png`]);
        const backup = new Database(path.join(temp, backups[0]), { readonly: true });
        assert.deepEqual(backup.prepare('SELECT exterior_images, menu_images FROM Place WHERE id = ?').get(p1), before);
        backup.close();
        check.close();

        // 再跑一次：OSS 上已有、地址已改，什么都不做
        const again = await runNode([script, '--apply'], ossEnv(oss.port));
        assert.match(again, /OSS 已有 3；新上传 0/);
        assert.match(again, /已改写：地点 0 个、修改申请 0 条、图片地址 0 个/);
        assert.equal(fs.readdirSync(temp).filter((n) => n.includes('.pre-oss-') && n.endsWith('.bak')).length, 1, '无改动时不再备份');
    } finally {
        oss.server.close();
    }
    console.log('image storage tests passed');
}

const entry = process.argv.includes('--child-oss-upload') ? childOssUpload : main;
entry()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        if (entry === main) fs.rmSync(temp, { recursive: true, force: true });
    });
