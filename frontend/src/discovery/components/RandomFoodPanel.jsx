import React, { useEffect, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import { Exposure } from "../../journey/feedback";
import MotionSurface from "../../components/overlay/MotionSurface";
import { markdownToPlainText } from "../../components/markdown/markdownText";
import { t, tx } from "../../i18n/index.js";
import IconButton from "../../components/primitives/IconButton";
import AnchoredPopover from '../../components/overlay/AnchoredPopover';
import { MapScopeMenu, radiusText } from '../../map/MapCenterMenu';

// 随机美食卡片：宽屏从按钮附近展开，窄屏浮在搜索框上方；非模态，地图仍可操作。
// 抽取由 MapUI 持有的 useRandomFood 会话负责，网页和原生共享，关闭时立即取消请求。
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
                padding: 16, boxSizing: 'border-box', borderRadius: 'var(--radius-xl)',
                background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-surface)'
            }}
        >
            {/* 换一个中心（地图 ↔ 展会）时重新挂载：收起动画未结束又打开也会按新中心抽取 */}
            <RandomFoodContent key={origin?.key || 'map'} origin={origin} onClose={onClose} {...rest} />
        </MotionSurface>
    );
}

function RandomFoodContent({ session, onClose, feedback, centerOptions = [], onPickCenter }) {
    const { result, activeOrigin, busy, error, drawNext, selectPlace, radiusKm, changeRadius } = session;
    const [centerOpen, setCenterOpen] = useState(false);
    const centerRef = useRef(null);
    const closeRef = useRef(null);
    useEffect(() => {
        const previousFocus = document.activeElement;
        closeRef.current?.focus();
        return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
    }, []);

    const place = result?.place;
    const distance = result?.distanceKm;
    const distanceText = place ? (distance < 1 ? t('map:randomFood.meters', { distance: Math.round(distance * 1000) }) : t('map:randomFood.kilometers', { distance: distance.toFixed(1) })) : '';
    const category = place ? place.category || t('common:label.uncategorized') : '';
    return (
        <div aria-busy={busy}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 id="random-food-title" style={{ margin: 0, flex: 1, fontSize: 'var(--text-title3-size)', fontWeight: 700 }}>{t('map:randomFood.title')}</h3>
                <IconButton ref={closeRef} icon="close" label={t('map:randomFood.close')} onClick={onClose} />
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
                    {/* 只显示三行摘要：去掉 Markdown 标记 */}
                    {place.description && <p style={{ fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{markdownToPlainText(place.description)}</p>}
                    <p style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tx('map:randomFood.candidates', { candidateCount: result.candidateCount })}</p>
                </Exposure>}
            </div>
            <div style={{ marginTop: 14 }}>
                <button ref={centerRef} type="button" className="fm-map-list__scope fm-pressable" disabled={busy}
                    aria-haspopup="menu" aria-expanded={centerOpen} onClick={() => setCenterOpen(open => !open)}>
                    <span className="material-symbols-outlined" aria-hidden="true">{activeOrigin?.source === 'location' ? 'my_location' : !activeOrigin || activeOrigin.source === 'map' ? 'map' : 'location_on'}</span>
                    <span className="fm-map-list__scope-text">{t('places:list.scope', { center: activeOrigin?.label || t('places:list.center.map'), distance: radiusText(radiusKm) })}</span>
                    <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
                </button>
                <AnchoredPopover open={centerOpen} onClose={() => setCenterOpen(false)} anchorRef={centerRef}
                    placement="top-start" label={t('places:list.center.pickTitle')} style={{ minWidth: 240 }}>
                    <MapScopeMenu radiusKm={radiusKm} onRadiusChange={km => { setCenterOpen(false); changeRadius(km); }}
                        options={centerOptions.map(option => ({ ...option, select: () => { setCenterOpen(false); option.select(); } }))}
                        selected={activeOrigin?.source || (activeOrigin ? 'origin' : 'map')} disabled={busy} onPickCenter={() => { setCenterOpen(false); onPickCenter?.(); }} />
                </AnchoredPopover>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {place && <Button disabled={busy} style={{ flex: 1 }}
                    onClick={selectPlace}>{t('map:randomFood.viewPlace')}</Button>}
                <Button variant="secondary" disabled={busy} style={{ flex: 1 }} onClick={drawNext}>
                    {busy ? t('map:randomFood.pickingShort') : place ? t('map:randomFood.another') : t('map:randomFood.tryAgain')}
                </Button>
            </div>
        </div>
    );
}
