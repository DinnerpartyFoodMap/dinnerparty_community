// 高德导航链接（网页 URI：lbs.amap.com/api/uri-api/guide/travel/route，App scheme：amap-mobile/guide/{ios,android}/route）。
// uri.amap.com 不是 Universal Link / App Link，App 内交给系统只会先进浏览器，所以 App 内直接用高德的 URI scheme
// 唤起已安装的高德地图，没装时 openExternal 改开网页版；网页端用 uri.amap.com 并带 callnative=1，
// 由高德网页自己尝试唤起 App（微信、QQ 内置浏览器可能拦截，仍留在网页版）。
// 地点坐标本来就是高德的 GCJ-02，scheme 里 dev=0 表示不再偏移；t=0 与 mode=car 都是驾车。

const SOURCE = 'yUYUko_food_MAP';

/**
 * @param {{longitude: number|string, latitude: number|string, name: string}} target
 * @param {'web'|'ios'|'android'} platform getPlatform() 的结果
 * @returns {{url: string, fallbackUrl: string}} fallbackUrl 只在 App 内有：scheme 打不开说明没装高德，网页版不再尝试唤起
 */
export function amapNavigationLink({ longitude, latitude, name }, platform) {
    const label = encodeURIComponent(name);
    const web = `https://uri.amap.com/navigation?to=${longitude},${latitude},${label}&mode=car&src=${SOURCE}`;
    const route = `sourceApplication=${SOURCE}&dlat=${latitude}&dlon=${longitude}&dname=${label}&dev=0&t=0`;
    if (platform === 'ios') return { url: `iosamap://path?${route}`, fallbackUrl: web };
    if (platform === 'android') return { url: `amapuri://route/plan/?${route}`, fallbackUrl: web };
    return { url: `${web}&callnative=1`, fallbackUrl: '' };
}
