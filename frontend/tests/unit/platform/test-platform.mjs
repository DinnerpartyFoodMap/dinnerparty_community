// 平台层纯逻辑测试：npm run test:platform（无需浏览器或原生环境）
import assert from 'node:assert/strict';
import { resolveRuntimeConfig, resolveResourceUrl, buildPublicUrl, getRuntimeConfig, buildImageThumbnailUrl } from "../../../src/platform/runtimeConfig.js";
import { wgs84ToGcj02, isOutOfChina } from "../../../src/platform/coordTransform.js";
import { isInAmapChinaRegion, rectTouchesAmapChinaRegion, rectWithinAmapChinaRegion } from "../../../src/platform/chinaRegion.js";
import { pushBackHandler, dispatchBack, BACK_PRIORITY } from "../../../src/platform/backButton.js";
import { decodeTokenPayload, getTokenUserId } from "../../../src/platform/credentialStore.js";
import { toInAppPath } from "../../../src/platform/nativeShell.js";
import { placeSharePath, shareParamValue } from "../../../src/platform/navigation.js";
import { shouldForceAmapWebGL, resolveAmapJsKey } from "../../../src/platform/amapLoader.js";

const webLocation = { protocol: 'https:', hostname: 'cn.dinnerparty.cc', origin: 'https://cn.dinnerparty.cc' };

// 高德 JS API key 由后端下发；后端不可用时只能退回上次取到的 key，没有就报错，不回退到任何内置凭证。
{
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const stored = new Map();
    globalThis.window = { localStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) } };
    const requested = [];
    const respond = (status, body) => async (url) => {
        requested.push(url);
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    const apiConfig = { apiBaseUrl: 'https://dinnerparty.cc/backend' };
    try {
        globalThis.fetch = respond(503, { error: 'not configured' });
        await assert.rejects(resolveAmapJsKey(apiConfig), { code: 'AMAP_KEY_UNAVAILABLE' });
        assert.equal(requested[0], 'https://dinnerparty.cc/backend/api/amap/js-config');

        globalThis.fetch = respond(200, { key: '  key-from-server  ' });
        assert.equal(await resolveAmapJsKey(apiConfig), 'key-from-server');

        globalThis.fetch = async () => { throw new TypeError('network down'); };
        assert.equal(await resolveAmapJsKey(apiConfig), 'key-from-server', 'falls back to the last key the server sent');

        globalThis.fetch = respond(200, { key: 'rotated-key' });
        assert.equal(await resolveAmapJsKey(apiConfig), 'rotated-key', 'a rotated key replaces the cached one');
        globalThis.fetch = respond(200, { key: '' });
        assert.equal(await resolveAmapJsKey(apiConfig), 'rotated-key');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    }
}

// 网页：保持原有回退逻辑
let config = resolveRuntimeConfig({ env: {}, location: webLocation, native: false });
assert.equal(config.apiBaseUrl, 'https://cn.dinnerparty.cc:2053');
assert.equal(config.amapServiceHost, 'https://cn.dinnerparty.cc/_AMapService');
assert.equal(config.publicWebBaseUrl, 'https://cn.dinnerparty.cc');
assert.deepEqual(config.errors, []);

config = resolveRuntimeConfig({ env: { VITE_BACKEND_URL: 'https://api.example.cc:2053/' }, location: webLocation, native: false });
assert.equal(config.apiBaseUrl, 'https://api.example.cc:2053');
assert.equal(config.amapServiceHost, 'https://api.example.cc:2053/_AMapService');
assert.equal(config.resourceBaseUrl, 'https://api.example.cc:2053');

// 同源部署：后端带路径前缀时，高德代理仍须是一级路由 /_AMapService
config = resolveRuntimeConfig({ env: { VITE_BACKEND_URL: 'https://dinnerparty.cc/backend' }, location: webLocation, native: false });
assert.equal(config.apiBaseUrl, 'https://dinnerparty.cc/backend');
assert.equal(config.amapServiceHost, 'https://dinnerparty.cc/_AMapService');
assert.equal(config.resourceBaseUrl, 'https://dinnerparty.cc/backend');

// 未替换的 %VITE_X% 占位符视为未配置
config = resolveRuntimeConfig({ env: { VITE_BACKEND_URL: '%VITE_BACKEND_URL%' }, location: webLocation, native: false });
assert.equal(config.apiBaseUrl, 'https://cn.dinnerparty.cc:2053');

// App：本地 origin 不能代表线上服务，缺失或不安全的配置要报错
const appLocation = { protocol: 'https:', hostname: 'localhost', origin: 'https://localhost' };
config = resolveRuntimeConfig({ env: {}, location: appLocation, native: true });
assert.equal(config.apiBaseUrl, '');
assert.ok(config.errors.length >= 2);
config = resolveRuntimeConfig({ env: { VITE_BACKEND_URL: 'http://127.0.0.1:7000', VITE_PUBLIC_WEB_URL: 'https://cn.dinnerparty.cc' }, location: appLocation, native: true });
assert.ok(config.errors.some((e) => e.includes('HTTPS')));
assert.ok(config.errors.some((e) => e.includes('本机')));
config = resolveRuntimeConfig({ env: { VITE_BACKEND_URL: 'https://cn.dinnerparty.cc:2053', VITE_PUBLIC_WEB_URL: 'https://cn.dinnerparty.cc' }, location: appLocation, native: true });
assert.deepEqual(config.errors, []);
assert.equal(config.amapServiceHost, 'https://cn.dinnerparty.cc:2053/_AMapService');
assert.equal(config.publicWebBaseUrl, 'https://cn.dinnerparty.cc');

// 备案信息：App 与网站的 ICP 备案号分开配置，App 不会显示网站的备案号；公安备案号共用；号码或链接缺一不显示
const filingEnv = {
    VITE_ICP_BEIAN_TEXT: '闽ICP备0000000号-2', VITE_ICP_BEIAN_URL: 'https://beian.miit.gov.cn/',
    VITE_GONGAN_BEIAN_TEXT: '闽公网安备0号', VITE_GONGAN_BEIAN_URL: 'https://beian.mps.gov.cn/#/query/webSearch?code=0'
};
config = resolveRuntimeConfig({ env: filingEnv, location: webLocation, native: false });
assert.deepEqual(config.icpBeian, { text: '闽ICP备0000000号-2', url: 'https://beian.miit.gov.cn/' });
assert.deepEqual(config.gonganBeian, { text: '闽公网安备0号', url: 'https://beian.mps.gov.cn/#/query/webSearch?code=0' });
config = resolveRuntimeConfig({ env: { ...filingEnv, VITE_APP_ICP_BEIAN_TEXT: '', VITE_APP_ICP_BEIAN_URL: 'https://beian.miit.gov.cn/' }, location: appLocation, native: true });
assert.equal(config.icpBeian, null);
assert.ok(config.gonganBeian);
config = resolveRuntimeConfig({ env: { ...filingEnv, VITE_APP_ICP_BEIAN_TEXT: '闽ICP备0000000号-3A', VITE_APP_ICP_BEIAN_URL: 'https://beian.miit.gov.cn/' }, location: appLocation, native: true });
assert.equal(config.icpBeian.text, '闽ICP备0000000号-3A');
assert.equal(resolveRuntimeConfig({ env: { VITE_GONGAN_BEIAN_TEXT: '闽公网安备0号' }, location: webLocation, native: false }).gonganBeian, null);

// 资源地址：兼容历史绝对 URL（旧域名映射）与 /uploads 相对路径；本地 blob/data 原样返回
// （Node 中无 window，默认配置的资源地址为 https://localhost:2053）
const resourceBase = getRuntimeConfig().resourceBaseUrl;
assert.equal(resolveResourceUrl('/uploads/a.jpg'), `${resourceBase}/uploads/a.jpg`);
assert.equal(resolveResourceUrl('uploads/a.jpg'), `${resourceBase}/uploads/a.jpg`);
assert.equal(resolveResourceUrl('https://dinnerparty.cc:2053/uploads/a.jpg'), 'https://cn.dinnerparty.cc:2053/uploads/a.jpg');
assert.equal(resolveResourceUrl('https://cdn.example/x.png'), 'https://cdn.example/x.png');
assert.equal(resolveResourceUrl('blob:https://app/1'), 'blob:https://app/1');
assert.equal(resolveResourceUrl(''), '');
assert.equal(buildPublicUrl('/p/1'), `${getRuntimeConfig().publicWebBaseUrl}/p/1`);

// OSS 缩略图：只处理配置目录下的静态图，动图、带参数、其他来源与未配置时用原图
const ossBase = 'https://img.example.cc/food';
assert.equal(resolveRuntimeConfig({ env: { VITE_OSS_IMAGE_BASE_URL: `${ossBase}/` }, location: webLocation, native: false }).ossImageBaseUrl, ossBase);
assert.equal(buildImageThumbnailUrl(`${ossBase}/1-2.jpg`, 800, ossBase), `${ossBase}/1-2.jpg?x-oss-process=image/auto-orient,1/resize,w_800/quality,q_80/format,webp`);
assert.equal(buildImageThumbnailUrl(`${ossBase}/1-2.gif`, 800, ossBase), `${ossBase}/1-2.gif`);
assert.equal(buildImageThumbnailUrl(`${ossBase}/1-2.jpg?v=1`, 800, ossBase), `${ossBase}/1-2.jpg?v=1`);
assert.equal(buildImageThumbnailUrl('https://img.example.cc/foodx/1.jpg', 800, ossBase), 'https://img.example.cc/foodx/1.jpg');
assert.equal(buildImageThumbnailUrl('https://cn.dinnerparty.cc:2053/uploads/a.jpg', 800, ossBase), 'https://cn.dinnerparty.cc:2053/uploads/a.jpg');
assert.equal(buildImageThumbnailUrl(`${ossBase}/1-2.jpg`, 800, ''), `${ossBase}/1-2.jpg`);

// 坐标转换：境外不转换；境内偏移量在合理范围（数百米），且只转换一次
assert.ok(isOutOfChina(-122.4, 37.7));
assert.deepEqual(wgs84ToGcj02(-122.4, 37.7), { lng: -122.4, lat: 37.7 });
const shanghai = wgs84ToGcj02(121.5272106, 31.1774276);
assert.ok(Math.abs(shanghai.lng - 121.531541859215) < 1e-6, `lng ${shanghai.lng}`);
assert.ok(Math.abs(shanghai.lat - 31.17530398364597) < 1e-6, `lat ${shanghai.lat}`);

// “境内”与高德转换服务一致（2026-10 实测：偏移 > 0 的算境内）
const AMAP_SHIFTED = {
    台北: [121.5654, 25.033], 金门: [118.3171, 24.4368], 澳门: [113.5439, 22.1987], 香港: [114.1694, 22.3193],
    钓鱼岛: [123.4755, 25.7458], 永兴岛: [112.3333, 16.8333], 永暑礁: [112.89, 9.55], 黄岩岛: [117.76, 15.15],
    新义州: [124.4, 40.1], 海参崴: [131.8869, 43.1155], 布拉戈维申斯克: [127.53, 50.27], 漠河: [122.54, 52.97],
    扎门乌德: [111.9, 43.72], 喀什: [75.99, 39.47], 阿克赛钦: [79.5, 35.2], 廷布: [89.64, 27.47],
    达旺: [91.86, 27.59], 密支那: [97.4, 25.38], 老街: [103.97, 22.48], 磨憨: [101.58, 21.21], 巴坦群岛: [121.97, 20.45]
};
const AMAP_UNSHIFTED = {
    东京: [139.7016, 35.69], 大阪: [135.5023, 34.6937], 首尔: [126.978, 37.5665], 平壤: [125.75, 39.03],
    济州: [126.53, 33.5], 那霸: [127.68, 26.21], 石垣岛: [124.16, 24.34], 与那国岛: [123.0, 24.47],
    乌兰巴托: [106.9, 47.9], 乔巴山: [114.5, 48.07], 阿拉木图: [76.85, 43.22], 比什凯克: [74.6, 42.87],
    列城: [77.58, 34.15], 加德满都: [85.3, 27.7], 樟木: [85.98, 27.99], 河内: [105.83, 21.03],
    琅勃拉邦: [102.14, 19.89], 马尼拉: [120.98, 14.6], 曼谷: [100.5, 13.75], 曾母暗沙: [112.28, 3.97]
};
for (const [name, [lng, lat]] of Object.entries(AMAP_SHIFTED)) {
    assert.equal(isInAmapChinaRegion(lng, lat), true, name);
    const shifted = wgs84ToGcj02(lng, lat);
    assert.ok(shifted.lng !== lng || shifted.lat !== lat, name);
}
for (const [name, [lng, lat]] of Object.entries(AMAP_UNSHIFTED)) {
    assert.equal(isInAmapChinaRegion(lng, lat), false, name);
    assert.deepEqual(wgs84ToGcj02(lng, lat), { lng, lat }, name);
}
// 格子边界在整数经纬度上
assert.equal(isInAmapChinaRegion(131.999, 43.5), true);
assert.equal(isInAmapChinaRegion(132.001, 43.5), false);
assert.equal(isInAmapChinaRegion(109.999, 2.999), false);
assert.equal(isInAmapChinaRegion(109.999, 3.001), true);
assert.equal(isInAmapChinaRegion(NaN, 30), false);
// 矩形：碰到 / 完全在内
assert.equal(rectTouchesAmapChinaRegion(139.5, 35.5, 140, 36), false);
assert.equal(rectTouchesAmapChinaRegion(131.5, 43.2, 132.5, 43.8), true);
assert.equal(rectWithinAmapChinaRegion(116, 39.5, 117, 40.5), true);
assert.equal(rectWithinAmapChinaRegion(131.5, 43.2, 132.5, 43.8), false);
assert.equal(rectWithinAmapChinaRegion(100, 60, 101, 61), false);

// 返回键：高优先级先处理；返回 false 交给下一层；注销后不再调用
const calls = [];
const offPage = pushBackHandler(() => { calls.push('page'); return true; }, BACK_PRIORITY.PAGE);
const offPanel = pushBackHandler(() => { calls.push('panel'); return false; }, BACK_PRIORITY.PANEL);
const offDialog = pushBackHandler(() => { calls.push('dialog'); return true; }, BACK_PRIORITY.DIALOG);
assert.equal(await dispatchBack(), true);
offDialog();
assert.equal(await dispatchBack(), true);
assert.deepEqual(calls, ['dialog', 'panel', 'page']);
offPanel(); offPage();
assert.equal(await dispatchBack(), false);

// JWT 载荷解析（用于按账号隔离本地草稿、识别旧版 token）
const payload = { id: 'u-1', username: '幽幽子', sid: 's-1' };
const token = `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
assert.deepEqual(decodeTokenPayload(token), payload);
assert.equal(getTokenUserId(token), 'u-1');
assert.equal(decodeTokenPayload('garbage'), null);

// 应用链接：本站公开链接转换为应用内路径，其他域名忽略
assert.equal(toInAppPath('https://cn.dinnerparty.cc/p/42', 'https://cn.dinnerparty.cc'), '/?place=42');
assert.equal(toInAppPath('https://cn.dinnerparty.cc/p/42?nav=amap', 'https://cn.dinnerparty.cc'), '/?place=42&nav=amap');
assert.equal(toInAppPath('https://cn.dinnerparty.cc/dinners/7', 'https://cn.dinnerparty.cc'), '/dinners/7');
assert.equal(toInAppPath('https://evil.example/p/42', 'https://cn.dinnerparty.cc'), null);
// QQ 打开链接时追加的参数不能影响地点（含直接拼在已有参数后面的写法）
assert.equal(toInAppPath('https://dinnerparty.cc/p/1049216?qq_aio_chat_type=2', 'https://dinnerparty.cc'), '/?place=1049216');
assert.equal(toInAppPath('https://dinnerparty.cc/p/42?nav=amap?qq_aio_chat_type=2', 'https://dinnerparty.cc'), '/?place=42&nav=amap');
assert.equal(placeSharePath('/p/42/', '?qq_aio_chat_type=2&nav=amap'), '/?place=42&nav=amap');
assert.equal(placeSharePath('/p/abc', ''), null);
assert.equal(placeSharePath('/', '?place=42'), null);
assert.equal(shareParamValue('1049216?qq_aio_chat_type=2'), '1049216');
assert.equal(shareParamValue(null), '');

// 高德 WebGL：iOS 上 UA 不带 "Version/… Safari" 的 WebKit 也要用 WebGL 渲染，否则自定义样式不生效
const IOS_WKWEBVIEW_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPADOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36';
assert.equal(shouldForceAmapWebGL({ platform: 'ios', userAgent: IOS_WKWEBVIEW_UA }), true);
assert.equal(shouldForceAmapWebGL({ platform: 'web', userAgent: IOS_WKWEBVIEW_UA }), true);
assert.equal(shouldForceAmapWebGL({ platform: 'web', userAgent: IPADOS_UA, maxTouchPoints: 5 }), true);
assert.equal(shouldForceAmapWebGL({ platform: 'web', userAgent: IPADOS_UA, maxTouchPoints: 0 }), false);
assert.equal(shouldForceAmapWebGL({ platform: 'android', userAgent: ANDROID_WEBVIEW_UA, maxTouchPoints: 5 }), false);

console.log('platform tests passed');
