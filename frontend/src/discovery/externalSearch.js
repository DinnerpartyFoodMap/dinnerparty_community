import { categoryFromAmapType } from '../map/utils.js';
import { t } from '../i18n/index.js';

const pendingRequests = new Map();

export function searchExternalPlaces(base, { q, center, city, source = 'map_manual' }) {
    const query = String(q || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!query) return Promise.resolve([]);
    const body = { q: query, source, ...(center ? { center } : {}), ...(city ? { city } : {}) };
    const id = `${base}:${JSON.stringify(body)}`;
    if (pendingRequests.has(id)) return pendingRequests.get(id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const promise = (async () => {
        try {
            const response = await fetch(`${base}/api/amap/search`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: controller.signal, cache: 'no-store'
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || t('map:ui.search.externalUnavailable'));
            if (!Array.isArray(data?.places)) throw new Error(t('map:ui.search.externalUnavailable'));
            return data.places;
        } catch (error) {
            if (error?.name === 'AbortError' || error instanceof TypeError) throw new Error(t('map:ui.search.externalUnavailable'));
            throw error;
        } finally { clearTimeout(timer); }
    })();
    pendingRequests.set(id, promise);
    const clean = () => { if (pendingRequests.get(id) === promise) pendingRequests.delete(id); };
    promise.then(clean, clean);
    return promise;
}

/** Context changes invalidate responses but never issue a query. */
export function createExternalSearchController(request, onChange) {
    let version = 0, context = '', active = null;
    let state = { query: '', results: [], loading: false, loaded: false, error: '' };
    const publish = patch => { state = { ...state, ...patch }; onChange(state); };
    return {
        setContext(query, resetKey) {
            query = String(query || '').trim();
            const next = JSON.stringify([query, resetKey]);
            if (next === context) return;
            context = next; version++; active = null;
            publish({ query, results: [], loading: false, loaded: false, error: '' });
        },
        search(options) {
            if (!state.query || state.loaded) return Promise.resolve(state.results);
            if (active) return active;
            const requestVersion = version;
            publish({ loading: true, error: '' });
            const task = (async () => {
                try {
                    const results = await request({ ...options, q: state.query });
                    if (requestVersion === version) publish({ results, loaded: true });
                    return results;
                } catch (error) {
                    if (requestVersion === version) publish({ error: error?.message || t('map:ui.search.externalUnavailable'), loaded: false });
                    return [];
                }
            })();
            active = task;
            task.then(() => {
                if (requestVersion === version) { active = null; publish({ loading: false }); }
            });
            return task;
        },
        dispose() { version++; active = null; context = ''; }
    };
}

export function currentMapCenter(mapRef) {
    const center = mapRef?.current?.getCenter?.();
    const lat = Number(center?.lat ?? center?.getLat?.());
    const lng = Number(center?.lng ?? center?.getLng?.());
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}

export function distanceMeters(center, place) {
    if (place?.latitude == null || place?.longitude == null || center?.lat == null || center?.lng == null) return null;
    const [lat1, lng1, lat2, lng2] = [center.lat, center.lng, place.latitude, place.longitude].map(Number);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
    const radians = value => value * Math.PI / 180;
    const h = Math.sin(radians(lat2 - lat1) / 2) ** 2
        + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function unmarkedExternalPlaces(pois, known, center) {
    const name = value => String(value || '').normalize('NFKC').replace(/[\s()]/g, '').toLowerCase();
    return pois.filter(poi => !known.some(place => {
        const distance = distanceMeters({ lng: place.longitude, lat: place.latitude }, poi);
        return name(place.name) === name(poi.name) && distance != null && distance < 50;
    })).map(poi => {
        const amapCategory = categoryFromAmapType(poi.type);
        return { ...poi, id: `amap_${poi.id || `${poi.longitude},${poi.latitude},${poi.name}`}`,
            category: amapCategory || t('common:label.amapPlace'), amapCategory,
            isMarked: false, showOnMap: false, dist: distanceMeters(center, poi) };
    });
}
