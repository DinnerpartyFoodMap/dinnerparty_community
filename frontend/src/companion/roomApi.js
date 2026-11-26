// 小伙伴的一天（后端 modules/rooms，/api/rooms）。失败时抛出带后端报错文字的 Error；
// 功能没开放（ROOMS_AUDIENCE）时接口 404，调用方据此只显示原来的小伙伴页。
import { t } from '../i18n/index.js';

async function request(backendUrl, token, path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${backendUrl}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const error = new Error((data && data.error) || t('companion:room.requestFailed', { status: res.status }));
        error.status = res.status;
        error.code = data && data.code;
        error.errors = data && Array.isArray(data.errors) ? data.errors : null;
        throw error;
    }
    return data;
}

/** 角色卡、建议标签、标签表、小习惯表、20 道题、默认名、今天还能改几次名字和口头禅 */
export function fetchRoomMe(backendUrl, token, options) {
    return request(backendUrl, token, '/api/rooms/me', options);
}

/** 起名（入住）：{ name, visibility, meets, city, answers } */
export function nameRoom(backendUrl, token, body) {
    return request(backendUrl, token, '/api/rooms/me/name', { method: 'POST', body });
}

/** 保存：{ sheet, visibility, meets, city } */
export function saveRoom(backendUrl, token, body) {
    return request(backendUrl, token, '/api/rooms/me', { method: 'PUT', body });
}

/** 大头照：后端给的是站内路径（/api/skins/packs/avatar/<grant>），补上接口地址；内置角色为 null，前端用饭桶的图 */
export function roomAvatarUrl(backendUrl, avatar) {
    if (typeof avatar !== 'string' || !avatar) return null;
    if (/^https?:\/\//.test(avatar)) return avatar;
    return avatar.startsWith('/') ? `${backendUrl}${avatar}` : null;
}

const withAvatar = (backendUrl, person) => (person && typeof person === 'object'
    ? { ...person, avatar: roomAvatarUrl(backendUrl, person.avatar) }
    : person);

export async function fetchRoomDay(backendUrl, token, userId, date, options) {
    const query = date ? `?date=${encodeURIComponent(date)}` : '';
    const day = await request(backendUrl, token, `/api/rooms/${encodeURIComponent(userId)}/day${query}`, options);
    if (!day || typeof day !== 'object') return day;
    const owner = day.owner ? withAvatar(backendUrl, day.owner) : day.owner;
    if (owner && Array.isArray(owner.friends)) owner.friends = owner.friends.map((friend) => withAvatar(backendUrl, friend));
    return {
        ...day,
        owner,
        people: Array.isArray(day.people) ? day.people.map((person) => withAvatar(backendUrl, person)) : []
    };
}

/** 口味像你的小伙伴：最多 5 只 [{ user_id, name, avatar, owner_name }] */
export async function fetchRoomNeighbors(backendUrl, token, options) {
    const data = await request(backendUrl, token, '/api/rooms/me/neighbors', options);
    const list = Array.isArray(data) ? data : (Array.isArray(data?.neighbors) ? data.neighbors : []);
    return list.slice(0, 5).map((person) => withAvatar(backendUrl, person));
}

export function fetchRoomMoments(backendUrl, token, userId, before, options) {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return request(backendUrl, token, `/api/rooms/${encodeURIComponent(userId)}/moments${query}`, options);
}

/** 城市（公开的地区树 { regions: [{ name, children: [{ name, count }] }] }，与地图筛选同一份）：店多的在前 */
export async function fetchRoomCities(backendUrl, options) {
    const res = await fetch(`${backendUrl}/places/regions`, options);
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const cities = new Map();
    for (const province of Array.isArray(data?.regions) ? data.regions : []) {
        for (const city of Array.isArray(province?.children) ? province.children : []) {
            if (city?.name) cities.set(city.name, (cities.get(city.name) || 0) + (Number(city.count) || 0));
        }
    }
    return [...cities.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([name]) => name);
}
