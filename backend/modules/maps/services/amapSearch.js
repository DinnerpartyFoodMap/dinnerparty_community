'use strict';
const { getSearchBudget, searchError } = require('./amapSearchBudget');
const logger = require('../../../infrastructure/logger');

function validateSearch(input) {
    const q = typeof input?.q === 'string' ? input.q.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    const source = input?.source;
    if (!q || q.length > 100 || !['map_manual', 'journey_address'].includes(source)) {
        throw searchError('AMAP_SEARCH_INVALID', 400, '请填写具体地点名称。');
    }
    let location;
    if (input.center != null) {
        const { lng, lat } = input.center;
        if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
            throw searchError('AMAP_SEARCH_INVALID', 400, '无效的搜索中心。');
        }
        location = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    }
    const city = input.city == null ? '' : input.city;
    if (typeof city !== 'string' || city.length > 60) throw searchError('AMAP_SEARCH_INVALID', 400, '无效的搜索城市。');
    return { q, source, location, city: city.trim() };
}

function cleanText(value) { return typeof value === 'string' ? value.trim() : ''; }
function normalizePoi(poi) {
    if (typeof poi?.location !== 'string' || !poi.location.includes(',')) return null;
    const parts = poi.location.split(',');
    if (parts.length !== 2 || parts.some(part => !part.trim())) return null;
    const [longitude, latitude] = parts.map(Number);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90 || !cleanText(poi.name)) return null;
    return {
        id: cleanText(poi.id), name: cleanText(poi.name), longitude, latitude,
        address: cleanText(poi.address) || [poi.pname, poi.cityname, poi.adname].map(cleanText).join(''),
        city: cleanText(poi.cityname) || cleanText(poi.pname), type: cleanText(poi.type)
    };
}

function createAmapSearch({ budget, key = () => String(process.env.AMAP_WEB_SERVICE_KEY || '').trim(), fetchImpl = (...args) => fetch(...args), timeoutMs = 8000 } = {}) {
    const pending = new Map();
    async function request(query, credential) {
        (budget || getSearchBudget()).reserve(query.source);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const params = new URLSearchParams({ key: credential, keywords: query.q, offset: '20', page: '1', extensions: 'base', output: 'JSON' });
        if (query.city) { params.set('city', query.city); params.set('citylimit', 'false'); }
        if (query.location) { params.set('location', query.location); params.set('radius', '20000'); params.set('sortrule', 'weight'); }
        try {
            const response = await fetchImpl(`https://restapi.amap.com/v3/place/${query.location ? 'around' : 'text'}?${params}`, { signal: controller.signal, redirect: 'error' });
            const data = await response.json();
            if (!response.ok || String(data?.status) !== '1' || !Array.isArray(data.pois)) throw new Error('Invalid upstream response');
            logger.info('AMap search completed', { event: 'amap.search.completed', source: query.source, count: data.pois.length });
            return { places: data.pois.map(normalizePoi).filter(Boolean) };
        } catch {
            // Do not log the URL, credentials, query, or location; do not retry paid attempts.
            logger.warn('AMap search failed', { event: 'amap.search.failed', source: query.source });
            throw searchError('AMAP_SEARCH_UPSTREAM', 502, '外部地点搜索暂时不可用，请稍后重试或在地图上选点。');
        } finally { clearTimeout(timer); }
    }
    return {
        async search(input) {
            const query = validateSearch(input);
            const credential = key();
            if (!credential) throw searchError('AMAP_SEARCH_UNAVAILABLE', 503, '外部地点搜索暂时不可用，请使用地图选点。');
            // Coalesce only in-flight identical requests; no response cache/POI database.
            const id = JSON.stringify(query);
            if (pending.has(id)) return pending.get(id);
            const promise = request(query, credential);
            pending.set(id, promise);
            try { return await promise; } finally { if (pending.get(id) === promise) pending.delete(id); }
        }
    };
}

module.exports = { createAmapSearch };
