// 有公开地点的省 / 市 / 区（GET /places/regions，后端用高德逆地理编码补齐）：地区筛选的下拉栏、iOS 原生筛选面板共用。
// 整个页面只读一次，失败时下次重新请求。树的每个节点：{ name, count, bounds: [minLng, minLat, maxLng, maxLat], children }
import { t } from '../i18n/index.js';

let regionsPromise = null;
let loadedRegions = null;

export function loadPlaceRegions(backendUrl) {
    if (!regionsPromise) {
        regionsPromise = fetch(`${backendUrl}/places/regions`)
            .then(async (res) => {
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || !Array.isArray(data.regions)) throw new Error((data && data.error) || t('places:filter.regionLoadFailed'));
                loadedRegions = data.regions;
                return loadedRegions;
            })
            .catch((error) => {
                regionsPromise = null;
                throw error;
            });
    }
    return regionsPromise;
}

export function peekPlaceRegions() {
    return loadedRegions;
}

/** 地区筛选（{ province, city, district }）在树里对应的节点链：[省, 市?, 区?]，找不到的层不返回 */
export function regionPath(regions, { province, city, district } = {}) {
    const path = [];
    const provinceNode = province && (regions || []).find((item) => item.name === province);
    if (!provinceNode) return path;
    path.push(provinceNode);
    const cityNode = city && (provinceNode.children || []).find((item) => item.name === city);
    if (!cityNode) return path;
    path.push(cityNode);
    const districtNode = district && (cityNode.children || []).find((item) => item.name === district);
    if (districtNode) path.push(districtNode);
    return path;
}

/** 选中地区的范围（最深一层）；没选或找不到时为 null */
export function regionBounds(regions, region) {
    const path = regionPath(regions, region);
    const node = path[path.length - 1];
    return node && Array.isArray(node.bounds) && node.bounds.length === 4 ? node.bounds : null;
}
