import assert from 'node:assert/strict';
import { amapNavigationLink } from '../../../src/map/amapNavigation.js';

const place = { longitude: 121.4737, latitude: 31.2304, name: '白玉楼 & 冥界食堂?' };
const label = encodeURIComponent(place.name);
const web = `https://uri.amap.com/navigation?to=121.4737,31.2304,${label}&mode=car&src=yUYUko_food_MAP`;

// 网页：高德导航网页 + callnative=1，由高德网页尝试唤起 App；没有备用链接
assert.deepEqual(amapNavigationLink(place, 'web'), { url: `${web}&callnative=1`, fallbackUrl: '' });

// App：高德 URI scheme（GCJ-02 坐标 dev=0、驾车 t=0），打不开时改开不再尝试唤起的网页版
const schemes = { ios: 'iosamap://path?', android: 'amapuri://route/plan/?' };
for (const [platform, prefix] of Object.entries(schemes)) {
    const { url, fallbackUrl } = amapNavigationLink(place, platform);
    assert.ok(url.startsWith(prefix), url);
    assert.equal(fallbackUrl, web, platform);
    const params = new URLSearchParams(url.slice(prefix.length));
    assert.deepEqual(Object.fromEntries(params), {
        sourceApplication: 'yUYUko_food_MAP',
        dlat: '31.2304',
        dlon: '121.4737',
        dname: place.name,
        dev: '0',
        t: '0'
    }, platform);
}

console.log('amap navigation ok');
