import { useEffect, useRef, useState } from 'react';
import { fetchRandomPlace } from '../../api/client';
import { normalizeLngLat } from '../../map/utils';
import { eventId, request } from '../../journey/feedback';
import { t } from '../../i18n/index.js';

// 网页与原生弹窗共用一轮抽取，固定中心、短历史、失败重试和取消规则。
export default function useRandomFood({ open, mapRef, backendUrl, token, feedback, origin, onSelectPlace, onClose }) {
    const [result, setResult] = useState(null);
    const [activeOrigin, setActiveOrigin] = useState(origin || null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const centerRef = useRef(null);
    const recentRef = useRef([]);
    const requestRef = useRef(null);
    const pendingDrawRef = useRef(null);
    const sessionRef = useRef(null);

    const draw = async (reset = false, from = activeOrigin, recordPrevious = true) => {
        if (!open || requestRef.current) return;
        const center = !reset ? centerRef.current
            : from ? { lat: from.lat, lng: from.lng } : normalizeLngLat(mapRef.current?.getCenter?.());
        if (!center) { setError(t('map:randomFood.mapNotReady')); return; }
        if (reset) {
            pendingDrawRef.current = null;
            centerRef.current = { lat: center.lat, lng: center.lng };
            recentRef.current = [];
        }
        const controller = new AbortController();
        if (recordPrevious && result?.place) feedback?.record('next', 'random', result.place.id, { decision_id: result.decision_id || null });
        requestRef.current = controller;
        setBusy(true);
        setError('');
        setResult(null);
        try {
            let data;
            if (feedback?.consent?.feedback && token) {
                pendingDrawRef.current ||= { draw_id: eventId(), center: centerRef.current, exclude_ids: [...recentRef.current] };
                data = await request(backendUrl, token, '/api/community/draw', { method: 'POST', signal: controller.signal,
                    body: JSON.stringify({ ...pendingDrawRef.current, consent_version: feedback.consent.version }) });
            } else data = await fetchRandomPlace(backendUrl, centerRef.current, recentRef.current, { signal: controller.signal, token });
            if (requestRef.current !== controller) return;
            pendingDrawRef.current = null;
            setResult(data);
            if (data.place) recentRef.current = [...recentRef.current, data.place.id].slice(-2);
        } catch (err) {
            if (requestRef.current === controller && err.name !== 'AbortError') setError(err.message || t('map:randomFood.loadFailed'));
        } finally {
            if (requestRef.current === controller) { requestRef.current = null; setBusy(false); }
        }
    };

    useEffect(() => {
        if (!open) return undefined;
        sessionRef.current = { backendUrl, mapRef, token, originKey: origin?.key };
        setActiveOrigin(origin || null);
        setResult(null);
        setError('');
        draw(true, origin || null, false);
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
            centerRef.current = null;
            recentRef.current = [];
            pendingDrawRef.current = null;
            sessionRef.current = null;
        };
    }, [open, backendUrl, mapRef, token, origin?.key]);

    const redrawAtMapCenter = () => {
        if (requestRef.current) return;
        setActiveOrigin(null);
        draw(true, null);
    };
    const selectPlace = () => {
        if (!currentSession || busy || !result?.place) return;
        feedback?.record('click', 'random', result.place.id, { decision_id: result.decision_id || null });
        onSelectPlace?.(result.place);
        onClose?.();
    };
    const current = sessionRef.current;
    const currentSession = open && current?.backendUrl === backendUrl && current?.mapRef === mapRef && current?.token === token && current?.originKey === origin?.key;
    return {
        result: currentSession ? result : null,
        activeOrigin: currentSession ? activeOrigin : origin || null,
        busy: open && (!currentSession || busy),
        error: currentSession ? error : '',
        drawNext: () => draw(!centerRef.current), redrawAtMapCenter, selectPlace
    };
}
