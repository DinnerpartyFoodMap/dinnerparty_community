import React, { useEffect, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import { fetchRandomPlace } from "../../api/client";
import { normalizeLngLat } from "../../map/utils";
import { Exposure, eventId, request } from "../../journey/feedback";
import MotionSurface from "../../components/overlay/MotionSurface";
import { t, tx } from "../../i18n/index.js";

// 随机美食卡片：宽屏从按钮附近展开，窄屏浮在搜索框上方；非模态，地图仍可操作。
// 内容组件随浮层出现而挂载（自动抽一次），退出动画结束后卸载并取消请求。
// origin（可选）：固定的本轮中心 { lat, lng, key, label }，例如展会地点；不传时用当前地图中心。
export default function RandomFoodPanel({ open, isNarrow, placement, onClose, origin = null, ...rest }) {
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
            {/* 换一个中心（地图 ↔ 展会）时重新挂载：收起动画未结束又打开也会按新中心抽取 */}
            <RandomFoodContent key={origin?.key || 'map'} origin={origin} onClose={onClose} {...rest} />
        </MotionSurface>
    );
}

function RandomFoodContent({ mapRef, backendUrl, token, onClose, onSelectPlace, feedback, origin }) {
    const [result, setResult] = useState(null);
    // 本轮的固定中心；“按当前地图中心重新抽取”后改回地图中心
    const [activeOrigin, setActiveOrigin] = useState(origin || null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const centerRef = useRef(null);
    const recentRef = useRef([]);
    const requestRef = useRef(null);
    const closeRef = useRef(null);
    const pendingDrawRef = useRef(null);

    const draw = async (reset = false, from = activeOrigin) => {
        if (requestRef.current) return;
        const center = !reset ? centerRef.current
            : from ? { lat: from.lat, lng: from.lng } : normalizeLngLat(mapRef.current?.getCenter?.());
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
    const distanceText = place ? (distance < 1 ? t('map:randomFood.meters', { distance: Math.round(distance * 1000) }) : t('map:randomFood.kilometers', { distance: distance.toFixed(1) })) : '';
    const category = place ? place.category || t('common:label.uncategorized') : '';
    const redrawAtMapCenter = () => {
        if (requestRef.current) return;
        setActiveOrigin(null);
        draw(true, null);
    };
    const secondaryStyle = { background: 'transparent', color: 'var(--color-text-primary)', minHeight: 40 };

    return (
        <div aria-busy={busy}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <h3 id="random-food-title" style={{ margin: 0, fontSize: 18 }}>{t('map:randomFood.title')}</h3>
                <button ref={closeRef} type="button" onClick={onClose} aria-label={t('map:randomFood.close')}
                    style={{ ...secondaryStyle, border: 'none', cursor: 'pointer', minWidth: 40, fontSize: 22 }}>×</button>
            </div>
            <p style={{ margin: '4px 0 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                {activeOrigin ? t('map:randomFood.introOrigin', { name: activeOrigin.label }) : t('map:randomFood.intro')}
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
                        {activeOrigin
                            ? tx('map:randomFood.metaOrigin', { category, name: activeOrigin.label, distance: distanceText })
                            : tx('map:randomFood.meta', { category, distance: distanceText })}
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
            <Button disabled={busy} full style={{ ...secondaryStyle, marginTop: 8 }} onClick={redrawAtMapCenter}>
                {t('map:randomFood.redraw')}
            </Button>
        </div>
    );
}
