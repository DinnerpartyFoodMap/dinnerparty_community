import { useEffect, useState } from 'react';
import { searchPlacesFast } from '../../api/client';
import { currentMapCenter, distanceMeters } from '../externalSearch.js';

// Input previews use our SQLite markers only. External POIs require an explicit action.
export function useSearchPanel(searchTerm, mapRef, backendUrl, mapReady, places) {
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        const query = String(searchTerm || '').trim();
        if (!query || !mapReady) { setResults(null); setLoading(false); return undefined; }
        const controller = new AbortController();
        let cancelled = false;
        setResults(null); setLoading(true);
        const timer = window.setTimeout(async () => {
            try {
                const center = currentMapCenter(mapRef);
                const data = await searchPlacesFast(backendUrl, { q: query, center, limit: 30, signal: controller.signal });
                if (cancelled) return;
                setResults((Array.isArray(data) ? data : []).map(place => {
                    const distanceKm = place.distance_km == null ? NaN : Number(place.distance_km);
                    const dist = Number.isFinite(distanceKm) ? distanceKm * 1000 : distanceMeters(center, place);
                    return { ...place, isMarked: true, ...(Number.isFinite(dist) ? { dist } : {}) };
                }));
            } catch (error) {
                if (!cancelled && error?.name !== 'AbortError') { console.warn('live fast search unavailable:', error.message || error); setResults([]); }
            } finally { if (!cancelled) setLoading(false); }
        }, 300);
        return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
    }, [searchTerm, mapRef, backendUrl, mapReady, places]);
    return { results, loading };
}
