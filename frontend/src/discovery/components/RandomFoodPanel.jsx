import React, { useEffect, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import { fetchRandomPlace } from "../../api/client";
import { normalizeLngLat } from "../../map/utils";
import { Exposure, eventId, request } from "../../journey/feedback";
import MotionSurface from "../../components/overlay/MotionSurface";
import { t, tx } from "../../i18n/index.js";

// 随机美食卡片：宽屏从按钮附近展开，窄屏浮在搜索框上方；非模态，地图仍可操作。
// 内容组件随浮层出现而挂载（自动抽一次），退出动画结束后卸载并取消请求。
export default function RandomFoodPanel({ open, isNarrow, placement, onClose, ...rest }) {
    return (
        <MotionSurface
            show={open}
            as="section"
            className="fm-glass"
            preset={isNarrow ? 'dropdown' : 'menu-down'}
            presetOptions={{ opensUp: isNarrow }}
            overlay={{ onClose, modal: false, kind: 'random-food', label: t('map:randomFood.title') }}
            role="dialog"
            aria-labelledby="random-food-title"
            style={{
                position: 'absolute', zIndex: 2300,
                ...(isNarrow ? { left: 12, right: 12, bottom: 'calc(184px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))', transformOrigin: '50% 100%' } : { top: 72, [placement || 'left']: 64, width: 320, transformOrigin: placement === 'right' ? 'right top' : 'left top' }),
                maxHeight: isNarrow ? 'calc(100% - 260px)' : 'calc(100% - 100px)', overflowY: 'auto',
                padding: 16, boxSizing: 'border-box', borderRadius: 'var(--radius-md)',
                background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-surface)'
            }}
        >
            <RandomFoodContent onClose={onClose} {...rest} />
        </MotionSurface>
    );
}

function RandomFoodContent({ mapRef, backendUrl, token, onClose, onSelectPlace, feedback }) {
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const centerRef = useRef(null);
    const recentRef = useRef([]);
    const requestRef = useRef(null);
    const closeRef = useRef(null);
    const pendingDrawRef = useRef(null);

    const draw = async (reset = false) => {
        if (requestRef.current) return;
        const center = reset ? normalizeLngLat(mapRef.current?.getCenter?.()) : centerRef.current;
        if (!center) {
            setError(t('map:randomFood.mapNotReady'));
            return;
        }
        if (reset) {
            pendingDrawRef.current = null;
            centerRef.current = { lat: center.lat, lng: center.lng };
            recentRef.current = [];
        }
        const controller = new AbortController();
        if (result?.place) feedback?.record('next', 'random', result.place.id, { decision_id: result.decision_id || null });
        requestRef.current = controller;
        setBusy(true);
        setError('');
        setResult(null);
        try {
            let data;
            if (feedback?.consent?.feedback && token) {
                // A failed network attempt can be retried without drawing a different restaurant.
                pendingDrawRef.current ||= { draw_id: eventId(), center: centerRef.current, exclude_ids: [...recentRef.current] };
                data = await request(backendUrl, token, '/api/community/draw', { method: 'POST', signal: controller.signal,
                    body: JSON.stringify({ ...pendingDrawRef.current, consent_version: feedback.consent.version }) });
            } else data = await fetchRandomPlace(backendUrl, centerRef.current, recentRef.current, { signal: controller.signal, token });
            if (requestRef.current !== controller) return;
            pendingDrawRef.current = null;
            setResult(data);
            if (data.place) recentRef.current = [...recentRef.current, data.place.id].slice(-2);
        } catch (err) {
            if (requestRef.current === controller && err.name !== 'AbortError') {
                setError(err.message || t('map:randomFood.loadFailed'));
            }
        } finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setBusy(false);
            }
        }
    };

    useEffect(() => {
        const previousFocus = document.activeElement;
        closeRef.current?.focus();
        draw(true);
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
            if (previousFocus?.isConnected) previousFocus.focus();
        };
    }, [backendUrl, mapRef, token]);

    const place = result?.place;
    const distance = result?.distanceKm;
    const secondaryStyle = { background: 'transparent', color: 'var(--color-text-primary)', minHeight: 40 };

    return (
        <div aria-busy={busy}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <h3 id="random-food-title" style={{ margin: 0, fontSize: 18 }}>{t('map:randomFood.title')}</h3>
                <button ref={closeRef} type="button" onClick={onClose} aria-label={t('map:randomFood.close')}
                    style={{ ...secondaryStyle, border: 'none', cursor: 'pointer', minWidth: 40, fontSize: 22 }}>×</button>
            </div>
            <p style={{ margin: '4px 0 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                {t('map:randomFood.intro')}
            </p>
            <div aria-live="polite" aria-atomic="true">
                {busy && <p role="status">{t('map:randomFood.picking')}</p>}
                {error && <p role="alert">{error}</p>}
                {result && !place && <p>{result.message}</p>}
                {place && <Exposure feedback={feedback} placeId={place.id} surface="random" rank={0} decisionId={result.decision_id}>
                    {result.personalized && <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {t('map:randomFood.personalized')}
                    </p>}
                    <h4 style={{ margin: '0 0 8px', fontSize: 20, overflowWrap: 'anywhere' }}>{place.name}</h4>
                    <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>
                        {tx('map:randomFood.meta', { category: place.category || t('common:label.uncategorized'), distance: distance < 1 ? t('map:randomFood.meters', { distance: Math.round(distance * 1000) }) : t('map:randomFood.kilometers', { distance: distance.toFixed(1) }) })}
                        {Number(place.per_person_cost) > 0 && t('common:label.perPersonCost', { per_person_cost: place.per_person_cost })}
                    </p>
                    {place.description && <p style={{ fontSize: 14, lineHeight: 1.6, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{place.description}</p>}
                    <p style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tx('map:randomFood.candidates', { candidateCount: result.candidateCount })}</p>
                </Exposure>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {place && <Button disabled={busy} style={{ flex: 1, minHeight: 40 }}
                    onClick={() => { feedback?.record('click', 'random', place.id, { decision_id: result.decision_id || null }); onSelectPlace(place); onClose(); }}>{t('map:randomFood.viewPlace')}</Button>}
                <Button disabled={busy} style={{ ...secondaryStyle, flex: 1 }} onClick={() => draw(!centerRef.current)}>
                    {busy ? t('map:randomFood.pickingShort') : place ? t('map:randomFood.another') : t('map:randomFood.tryAgain')}
                </Button>
            </div>
            <Button disabled={busy} full style={{ ...secondaryStyle, marginTop: 8 }} onClick={() => draw(true)}>
                {t('map:randomFood.redraw')}
            </Button>
        </div>
    );
}
