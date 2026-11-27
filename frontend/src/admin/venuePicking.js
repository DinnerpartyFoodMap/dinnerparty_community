// 场馆落点（网页后台 AdminVenues 与 iOS 原生后台共用）：选点器的初始中心、选点结果的坐标、提交落点。
// 场馆不是地点：不建 Place，坐标只来自管理员选点。见 backend/modules/venues/doc/README.md。
import { t } from '../i18n/index.js';

/**
 * 选点时地图的初始中心：用已有地点算出的地区树，按城市名找 bounds 的中心。
 * 零外部调用（不碰高德行政区查询）；城市还没被任何地点覆盖时返回 null，用地图默认视野。
 */
export function cityCenterOf(regions, city) {
    const raw = String(city || '').trim();
    if (!raw) return null;
    // 对端可能只写「上海」，地区树里是「上海市」；去掉行政区后缀再比，避免静默退回默认视野。
    const bare = (value) => String(value || '').trim().replace(/(特别行政区|自治区|自治州|地区|省|市|县)$/u, '');
    const want = bare(raw);
    if (!want) return null;
    const matches = (value) => bare(value) === want || raw === String(value || '').trim();
    for (const province of regions || []) {
        const cityNode = (province.children || []).find((item) => matches(item.name));
        const node = cityNode || (matches(province.name) ? province : null);
        const bounds = node && node.bounds;
        if (Array.isArray(bounds) && bounds.length === 4 && bounds.every((value) => Number.isFinite(Number(value)))) {
            return { lat: (Number(bounds[1]) + Number(bounds[3])) / 2, lng: (Number(bounds[0]) + Number(bounds[2])) / 2 };
        }
    }
    return null;
}

/** 选点器回传的点（图钉位置 { lat, lng } 或站内地点 { latitude, longitude }）→ 坐标；无效时 null */
export function pickedCoordinates(point) {
    const latitude = Number(point?.lat ?? point?.latitude);
    const longitude = Number(point?.lng ?? point?.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

/** 提交落点；失败时抛出带后端说明的错误（401 先交给 onRequireAuth） */
export async function placeVenue({ backendUrl, token, onRequireAuth }, venueId, coordinates) {
    const res = await fetch(`${backendUrl}/admin/venues/${encodeURIComponent(venueId)}/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(coordinates)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) onRequireAuth?.();
        throw new Error(body.error || t('admin:venues.requestFailed'));
    }
    return body;
}
