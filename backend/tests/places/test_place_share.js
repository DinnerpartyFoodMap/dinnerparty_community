// 地点分享页 /p/:id：QQ / 微信链接卡片的标题、描述、图片，以及 QQ 追加参数后的地址解析。
// 临时 SQLite + 本地 express，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-share-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    UPLOADS_DIR: path.join(temp, 'uploads'),
    FRONTEND_BASE_URL: 'https://dinnerparty.cc',
    OSS_PUBLIC_BASE_URL: 'https://cdn.example.cc', OSS_PREFIX: 'food'
});

const express = require('express');
const { db, init } = require('../../infrastructure/database');
const sharp = require('sharp');
const placeShare = require('../../modules/places/routes/placeShare');
const placeCard = require('../../modules/places/services/placeCard');

const OSS_IMAGE = 'https://cdn.example.cc/food/abc.jpg';
const THUMB = `${OSS_IMAGE}?x-oss-process=image/auto-orient,1/resize,m_fill,w_300,h_300/quality,q_85/format,jpg`;

function meta(html, attr, key) {
    const match = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html);
    return match ? match[1] : null;
}

function get(port, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function getRaw(port, pathname) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

(async () => {
    await init();
    fs.mkdirSync(path.join(temp, 'uploads'));
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#c33' } }).png().toFile(path.join(temp, 'uploads', 'x.png'));
    const insert = (sql, args) => new Promise((resolve, reject) => db.run(sql, args, (err) => (err ? reject(err) : resolve())));
    const sql = `INSERT INTO Place (id, name, description, latitude, longitude, category, address, exterior_images, menu_images)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await insert(sql, [1049216, 'PIPA枇杷小厨披萨研究所', '广州超级正宗又平价的意大利披萨', 23.08, 113.26, '外国餐厅', '南边路2-12号', '[]', '[]']);
    await insert(sql, [2, '小店', '', 23.08, 113.26, '', '某路1号', '[]', JSON.stringify([OSS_IMAGE])]);
    await insert(sql, [3, '图店 <b>', '好吃 "真的"', 23.08, 113.26, '中餐', '', JSON.stringify(['/uploads/x.png', OSS_IMAGE]), '[]']);
    await insert(sql, [4, '外链图店', '', 23.08, 113.26, '', '', JSON.stringify(['https://evil.example/a.jpg']), '[]']);

    // 纯函数
    assert.equal(placeShare.buildCardTitle({ name: ' 店 ', category: '火锅' }), '店 · 火锅');
    assert.equal(placeShare.buildCardTitle({ name: '店' }), '店');
    assert.equal(placeShare.buildCardDescription({ description: '  好吃\n不贵 ' }), '好吃 不贵');
    assert.equal(placeShare.buildCardDescription({ description: '', address: '某路1号' }), '某路1号');
    assert.match(placeShare.buildCardDescription({}), /东方饭联地图/);
    assert.deepEqual(placeShare.buildCardImage({ exterior_images: '[]' }, 'https://s.cc', ''),
        { url: 'https://s.cc/favicon.png', width: 256, height: 256 });
    assert.deepEqual(placeShare.buildCardImage({ exterior_images: 'not json', menu_images: JSON.stringify([OSS_IMAGE]) }, 'https://s.cc', 'https://cdn.example.cc/food/'),
        { url: THUMB, width: 300, height: 300 });
    assert.deepEqual(placeShare.buildCardImage({ exterior_images: '["/uploads/a.jpg"]' }, 'https://s.cc', 'https://cdn.example.cc/food/'),
        { url: 'https://s.cc/uploads/a.jpg' });
    assert.equal(placeShare.isAmapNav('amap?qq_aio_chat_type=2'), true);
    assert.equal(placeShare.isAmapNav(['amap', 'x']), false);

    const app = express();
    app.set('trust proxy', true);
    app.use('/p', placeShare);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const headers = { Host: 'dinnerparty.cc', 'X-Forwarded-Proto': 'https' };

    try {
        // 无图：大标题 店名 · 分类，小标题 详情，图片回退 favicon.png；QQ 追加的参数不进 og:url
        let res = await get(port, '/p/1049216?qq_aio_chat_type=2', headers);
        assert.equal(res.status, 200);
        assert.equal(meta(res.body, 'itemprop', 'name'), 'PIPA枇杷小厨披萨研究所 · 外国餐厅');
        assert.equal(meta(res.body, 'property', 'og:title'), 'PIPA枇杷小厨披萨研究所 · 外国餐厅');
        assert.equal(meta(res.body, 'itemprop', 'description'), '广州超级正宗又平价的意大利披萨');
        assert.equal(meta(res.body, 'property', 'og:description'), '广州超级正宗又平价的意大利披萨');
        assert.equal(meta(res.body, 'itemprop', 'image'), 'https://dinnerparty.cc/favicon.png');
        assert.equal(meta(res.body, 'property', 'og:image'), 'https://dinnerparty.cc/favicon.png');
        assert.equal(meta(res.body, 'property', 'og:url'), 'https://dinnerparty.cc/p/1049216');
        assert.match(res.body, /<title>PIPA枇杷小厨披萨研究所 · 外国餐厅<\/title>/);
        assert.match(res.body, /<html lang="zh-CN" itemscope itemtype="https:\/\/schema.org\/WebPage">/);
        assert.match(res.body, /location\.replace\('https:\/\/dinnerparty\.cc\/\?place=1049216'\)/);

        // 无分类、无详情：标题只有店名，描述用地址；只有菜单图时用菜单图的 OSS 方图
        res = await get(port, '/p/2', headers);
        assert.equal(meta(res.body, 'itemprop', 'name'), '小店');
        assert.equal(meta(res.body, 'itemprop', 'description'), '某路1号');
        assert.equal(meta(res.body, 'itemprop', 'image'), THUMB.replace(/&/g, '&amp;'));
        assert.equal(meta(res.body, 'property', 'og:image:width'), '300');

        // 第一张图是相对路径时按网站地址补全；HTML 转义
        res = await get(port, '/p/3', headers);
        assert.equal(meta(res.body, 'itemprop', 'name'), '图店 &lt;b&gt; · 中餐');
        assert.equal(meta(res.body, 'itemprop', 'description'), '好吃 &quot;真的&quot;');
        assert.equal(meta(res.body, 'itemprop', 'image'), 'https://dinnerparty.cc/uploads/x.png');
        assert.equal(meta(res.body, 'property', 'og:image:width'), null);

        // 导航分享：参数被直接拼接也能识别，规范地址保留 nav=amap
        res = await get(port, '/p/1049216?nav=amap?qq_aio_chat_type=2', headers);
        assert.equal(meta(res.body, 'property', 'og:url'), 'https://dinnerparty.cc/p/1049216?nav=amap');
        assert.match(res.body, /location\.replace\('https:\/\/uri\.amap\.com\/navigation\?to=113\.26,23\.08,/);

        // id 后被拼上其他字符时仍取开头的数字；不存在 / 非法 id 返回 404
        res = await get(port, `/p/${encodeURIComponent('1049216&qq_aio_chat_type=2')}`, headers);
        assert.equal(meta(res.body, 'property', 'og:url'), 'https://dinnerparty.cc/p/1049216');
        assert.equal((await get(port, '/p/999', headers)).status, 404);
        assert.equal((await get(port, '/p/abc', headers)).status, 404);

        // 卡片缩略图 /p/<id>/card-<key>.jpg：站内提供的 300×300 JPG（QQ 图文卡片用）
        const file = placeCard.cardImageFile({ exterior_images: JSON.stringify(['/uploads/x.png', OSS_IMAGE]) });
        assert.match(file, /^card-[0-9a-f]{8}\.jpg$/);
        assert.equal(placeCard.cardImageFile({ exterior_images: '[]', menu_images: null }), null);
        const thumb = await getRaw(port, `/p/3/${file}`);
        assert.equal(thumb.status, 200);
        assert.equal(thumb.headers['content-type'], 'image/jpeg');
        const info = await sharp(thumb.body).metadata();
        assert.deepEqual([info.format, info.width, info.height], ['jpeg', 300, 300]);
        // 没有图 / 不是本站存储的图：跳到网站图标；文件名不对：404
        for (const target of ['/p/1049216/card-00000000.jpg', '/p/4/card-00000000.jpg', '/p/999/card-00000000.jpg']) {
            const res2 = await getRaw(port, target);
            assert.deepEqual([res2.status, res2.headers.location], [302, '/favicon.png'], target);
        }
        assert.equal((await getRaw(port, '/p/3/x.png')).status, 404);
        assert.equal((await getRaw(port, '/p/3/card-12345678.jpg?x=1')).status, 200, 'the key only busts caches');

        // OSS 图：取 OSS 裁好的方图，失败时取原图本地缩放；其他域名不发请求
        const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3c3' } }).jpeg().toBuffer();
        const requested = [];
        const fakeFetch = (fail) => async (url) => {
            requested.push(url);
            if (fail(url)) return new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } });
            return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
        };
        const ossDir = 'https://cdn.example.cc/food/';
        placeCard._clearCardImageCacheForTesting();
        let out = await placeCard.loadCardImage(OSS_IMAGE, { fetchImpl: fakeFetch(() => false), ossImageDir: ossDir });
        assert.deepEqual(requested, [THUMB]);
        assert.equal((await sharp(out).metadata()).width, 300);
        await placeCard.loadCardImage(OSS_IMAGE, { fetchImpl: fakeFetch(() => false), ossImageDir: ossDir });
        assert.equal(requested.length, 1, 'cached');
        placeCard._clearCardImageCacheForTesting();
        requested.length = 0;
        out = await placeCard.loadCardImage(OSS_IMAGE, { fetchImpl: fakeFetch((url) => url.includes('?')), ossImageDir: ossDir });
        assert.deepEqual(requested, [THUMB, OSS_IMAGE]);
        assert.equal((await sharp(out).metadata()).height, 300);
        requested.length = 0;
        for (const url of ['https://evil.example/a.jpg', 'http://127.0.0.1:8080/admin', `${OSS_IMAGE}?x=1`]) {
            await assert.rejects(placeCard.loadCardImage(url, { fetchImpl: fakeFetch(() => false), ossImageDir: ossDir }));
        }
        assert.deepEqual(requested, [], 'never fetches addresses outside the site storage');
    } finally {
        server.close();
    }
    console.log('place share tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
