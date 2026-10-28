import { t } from '../i18n/index.js';
export async function fetchPlaces(backendUrl) {
    const res = await fetch(`${backendUrl}/places`);
    if (!res.ok) throw new Error(`Failed to fetch places: ${res.status}`);
    return res.json();
}

export async function fetchRandomPlace(backendUrl, center, excludedIds = [], { signal, token } = {}) {
    const params = new URLSearchParams({ lat: String(center.lat), lng: String(center.lng) });
    if (excludedIds.length) params.set('excludeIds', excludedIds.slice(-2).join(','));
    const res = await fetch(`${backendUrl}/places/random?${params}`, {
        signal, cache: 'no-store', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.random.loadFailed'));
    if (!Number.isInteger(data.candidateCount) || !Object.prototype.hasOwnProperty.call(data, 'place')) {
        throw new Error(t('map:api.random.invalid'));
    }
    return data;
}

// 带 token 时结果包含自己新增、还在审核中的地点（其他人看不到）；token 无效时后端按游客返回
const authHeaders = (token) => (token ? { headers: { Authorization: `Bearer ${token}` } } : {});

export async function fetchPlacesNearby(backendUrl, { minLng, minLat, maxLng, maxLat }, { signal, token } = {}) {
    const params = new URLSearchParams({
        minLng: String(minLng),
        minLat: String(minLat),
        maxLng: String(maxLng),
        maxLat: String(maxLat)
    });
    const res = await fetch(`${backendUrl}/places/nearby?${params.toString()}`, { signal, ...authHeaders(token) });
    if (!res.ok) throw new Error(`Failed to fetch nearby places: ${res.status}`);
    return res.json();
}

export async function resolveAmapShareRoute(backendUrl, url, { signal } = {}) {
    const res = await fetch(`${backendUrl}/api/along-route/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.routeLinkFailed', { status: res.status }));
    return data;
}

export async function searchPlacesAlongRoute(backendUrl, payload, { signal } = {}) {
    const res = await fetch(`${backendUrl}/api/along-route/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.alongRouteFailed', { status: res.status }));
    return data;
}

export async function fetchCurrentUser(backendUrl, token) {
    if (!token) return null;
    const res = await fetch(`${backendUrl}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return res.json().then(d => d.user);
}

// 记录“定位”得到的位置（GCJ-02，后端只保留最近一次），QQ Bot 的 !随机 以它为推荐中心
export async function reportUserLocation(backendUrl, token, { lat, lng }) {
    if (!token) return;
    const res = await fetch(`${backendUrl}/users/me/location`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lat, lng })
    });
    if (!res.ok) throw new Error(`Failed to report location: ${res.status}`);
}

export async function postPlace(backendUrl, token, payload) {
    const res = await fetch(`${backendUrl}/places`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(t('map:api.backendError', { status: res.status, statusText: res.statusText, text }));
    }
    return res.json();
}

export async function searchPlacesFast(backendUrl, opts = {}) {
    const params = new URLSearchParams();
    params.set('q', opts.q || '');
    if (opts.limit) params.set('limit', String(opts.limit));
    if (Number.isFinite(Number(opts.center?.lat)) && Number.isFinite(Number(opts.center?.lng))) {
        params.set('lat', String(opts.center.lat));
        params.set('lng', String(opts.center.lng));
    }
    const url = `${backendUrl}/api/places/search/fast?${params.toString()}`;
    const res = await fetch(url, { signal: opts.signal, ...authHeaders(opts.token) });
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    return res.json();
}

// Kept as the lightweight live-suggestion API.
export const searchPlaces = searchPlacesFast;

export async function searchPlacesAi(backendUrl, opts = {}) {
    const payload = { q: opts.q || '', limit: opts.limit || 5 };
    if (Number.isFinite(Number(opts.center?.lat)) && Number.isFinite(Number(opts.center?.lng))) {
        payload.center = { lat: Number(opts.center.lat), lng: Number(opts.center.lng) };
    }
    const bounds = opts.bounds;
    if (bounds && ['minLng', 'minLat', 'maxLng', 'maxLat'].every((key) => Number.isFinite(Number(bounds[key])))) {
        payload.bounds = Object.fromEntries(
            ['minLng', 'minLat', 'maxLng', 'maxLat'].map((key) => [key, Number(bounds[key])])
        );
    }
    // 需要登录（后端未登录返回 401）
    const res = await fetch(`${backendUrl}/api/places/search/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
        body: JSON.stringify(payload),
        signal: opts.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `AI search failed: ${res.status}`);
    return data;
}

// 单个地点：自己审核中的地点要带 token 才能读到（管理员同样）
export async function fetchPlace(backendUrl, id, { token, signal } = {}) {
    return fetch(`${backendUrl}/places/${encodeURIComponent(id)}`, { signal, ...authHeaders(token) });
}

// 某位住民创建的地点（最近创建在前，最多 limit 个；带 token 时包含自己审核中的地点）。
// relation 是观看者与这位住民的关系：self、blocked（已屏蔽时不列出地点）、can_block
export async function fetchUserPlaces(backendUrl, userId, { token, signal } = {}) {
    const res = await fetch(`${backendUrl}/users/${encodeURIComponent(userId)}/places`, { signal, cache: 'no-store', ...authHeaders(token) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('map:api.userPlaces.loadFailed', { status: res.status })), { status: res.status });
    return data;
}

// 屏蔽 / 解除屏蔽某位住民（只影响自己看到的内容），返回 { relation }
export async function setUserBlocked(backendUrl, token, userId, blocked) {
    const res = await fetch(`${backendUrl}/users/${encodeURIComponent(userId)}/block`, {
        method: blocked ? 'POST' : 'DELETE',
        ...authHeaders(token)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('map:api.userPlaces.blockFailed', { status: res.status })), { status: res.status });
    return data;
}

export async function putPlace(backendUrl, token, id, payload) {
    const res = await fetch(`${backendUrl}/places/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || t('map:api.updateFailed', { status: res.status }));
    }
    return data;
}

export async function deletePlace(backendUrl, token, id) {
    const res = await fetch(`${backendUrl}/places/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('common:error.deleteFailedStatus', { status: res.status }));
    return data;
}

export async function postPlaceRequest(backendUrl, token, payload) {
    const res = await fetch(`${backendUrl}/place-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.placeRequestFailed', { status: res.status }));
    return data;
}

function normalizeDinner(item) {
    if (!item || typeof item !== 'object') return null;
    return {
        id: Number(item.id),
        title: item.title || '',
        description: item.description || '',
        place_name: item.place_name || '',
        start_time: item.start_time || null,
        max_participants: item.max_participants == null ? null : Number(item.max_participants),
        contact_info: item.contact_info || '',
        status: item.status || 'open',
        creator_id: item.creator_id == null ? null : Number(item.creator_id),
        creator_name: item.creator_name || '',
        created_time: item.created_time || null,
        updated_time: item.updated_time || null
    };
}

export async function fetchDinners(backendUrl) {
    const res = await fetch(`${backendUrl}/dinners`);
    if (!res.ok) throw new Error(t('map:api.dinners.fetchFailed', { status: res.status }));
    const data = await res.json().catch(() => []);
    const list = Array.isArray(data) ? data : [];
    return list.map(normalizeDinner).filter(Boolean);
}

export async function fetchDinnerById(backendUrl, id) {
    const res = await fetch(`${backendUrl}/dinners/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.dinners.fetchOneFailed', { status: res.status }));
    return normalizeDinner(data);
}

export async function createDinner(backendUrl, token, payload) {
    const res = await fetch(`${backendUrl}/dinners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.dinners.createFailed', { status: res.status }));
    return normalizeDinner(data);
}

export async function deleteDinner(backendUrl, token, id) {
    const targets = [
        `${backendUrl}/dinners/${id}`,
        `${backendUrl}/api/dinners/${id}`
    ];

    let lastError = null;
    for (const url of targets) {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });

        if (res.ok) {
            return res.json().catch(() => ({ success: true }));
        }

        const data = await res.json().catch(() => ({}));
        const msg = data.error || t('map:api.dinners.deleteFailed', { status: res.status });

        // 若是 404，继续尝试兼容路径；其他错误直接抛出
        if (res.status !== 404) {
            throw new Error(msg);
        }
        lastError = new Error(msg);
    }

    throw (lastError || new Error(t('map:api.dinners.deleteNotFound')));
}

// -------- Favorites --------

export async function fetchFavorites(backendUrl, token) {
    const res = await fetch(`${backendUrl}/api/favorites`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('map:api.favorites.fetchFailed', { status: res.status }));
    }
    return res.json();
}

// 地点评价：游客只读公开汇总；登录后附带自己的评价、按口味加权的平均分与今日剩余次数
export async function fetchPlaceRating(backendUrl, placeId, { token, signal } = {}) {
    const res = await fetch(`${backendUrl}/api/ratings/places/${placeId}`, {
        signal, cache: 'no-store', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('map:api.rating.loadFailed', { status: res.status })), { status: res.status });
    return data;
}

export async function savePlaceRating(backendUrl, token, placeId, score, {requestId,confirm=true}={}) {
    const res = await fetch(`${backendUrl}/api/ratings/places/${placeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ score,request_id:requestId||ratingRequestId(),confirm })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('map:api.rating.saveFailed', { status: res.status })), { status: res.status,committed:data.committed===true });
    return data;
}

export const ratingRequestId=()=>globalThis.crypto?.randomUUID?.()||`rating_${Date.now()}_${Math.random().toString(36).slice(2)}`;
export async function withdrawPlaceRating(backendUrl, token, placeId,{requestId}={}) {
    const res = await fetch(`${backendUrl}/api/ratings/places/${placeId}`, {
        method: 'DELETE',
        headers: { 'Content-Type':'application/json',Authorization: `Bearer ${token}` },
        body:JSON.stringify({request_id:requestId||ratingRequestId()})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('map:api.rating.withdrawFailed', { status: res.status })), { status: res.status,committed:data.committed===true });
    return data;
}

export async function addFavorite(backendUrl, token, placeId) {
    const res = await fetch(`${backendUrl}/api/favorites/${placeId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.favorites.addFailed', { status: res.status }));
    return data;
}

export async function removeFavorite(backendUrl, token, placeId) {
    const res = await fetch(`${backendUrl}/api/favorites/${placeId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('map:api.favorites.removeFailed', { status: res.status }));
    return data;
}

// -------- Categories --------

export async function fetchCategories(backendUrl) {
    const res = await fetch(`${backendUrl}/categories`);
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || t('map:api.categories.fetchFailed', { status: res.status }));
    return Array.isArray(data) ? data : [];
}

export async function createCategory(backendUrl, token, name, { allowSimilar = false } = {}) {
    const res = await fetch(`${backendUrl}/categories`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name, allow_similar: allowSimilar })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(data.error || t('map:api.categories.createFailed', { status: res.status }));
        error.status = res.status;
        error.similarCategories = Array.isArray(data.similar_categories) ? data.similar_categories : [];
        throw error;
    }
    return data;
}

// -------- 地点列表 / 住民主页 / 发版信息 --------

// 地点列表页：按标签、人均筛选，按综合评价与口味加权评价排序；条目不带坐标，只链接 /p/:id
export async function fetchPlaceList(backendUrl, { query, offset = 0, limit = 20, token, signal } = {}) {
    const params = new URLSearchParams(query || '');
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    const res = await fetch(`${backendUrl}/places/list?${params}`, { signal, cache: 'no-store', ...authHeaders(token) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('places:list.loadFailed')), { status: res.status });
    return data;
}

// 住民主页：头像、六类餐饮偏好、上次定位的城市、两个小组件与观看者关系
export async function fetchUserProfile(backendUrl, userId, { token, signal } = {}) {
    const res = await fetch(`${backendUrl}/users/${encodeURIComponent(userId)}/profile`, { signal, cache: 'no-store', ...authHeaders(token) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || t('profile:loadFailed')), { status: res.status });
    return data;
}

export async function saveProfileWidgets(backendUrl, token, widgets) {
    const res = await fetch(`${backendUrl}/users/me/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ widgets })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('profile:widgets.saveFailed'));
    return data;
}

// 自己填某一类餐饮的喜好（1–4；null 回到自动推断），返回新的六轴
export async function saveTasteLevel(backendUrl, token, axis, level) {
    const res = await fetch(`${backendUrl}/users/me/taste`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ axis, level })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('profile:taste.saveFailed'));
    return data;
}

// 两端最新构建号与更新说明（App 启动检查更新、/home 下载页）
export async function fetchAppRelease(backendUrl, { signal } = {}) {
    const res = await fetch(`${backendUrl}/api/app/release`, { signal, cache: 'no-cache' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || String(res.status));
    return data;
}
