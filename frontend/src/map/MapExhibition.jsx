import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import Button from '../components/primitives/Button';
import { onAppStateChange } from '../platform/lifecycle';
import { getExhibitionTop } from './exhibitionLayout';
import { exhibitionRandomOrigin } from './exhibition';
import { useLayoutPolicy } from '../motion/MotionProvider';
import { t } from '../i18n/index.js';

// Keep the entry 30px below the map's top edge when no notice overlaps it.
const HOME_TOP = 30;

/**
 * 当前展会：进入时、每 30 秒、窗口回到前台和后台发布后（exhibition-updated）重新读取。
 * enabled 为假（不在地图页）时不轮询，保留最后一次结果。内容不变时沿用旧对象，避免整页重渲染。
 */
export function useCurrentExhibition(backendUrl, enabled = true) {
    const [exhibition, setExhibition] = useState(null);

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        let controller;
        const load = async () => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            try {
                const res = await fetch(`${backendUrl}/exhibitions/current`, { signal: request.signal });
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled || request.signal.aborted) return;
                const next = data.exhibition || null;
                setExhibition(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            } catch (error) {
                if (!cancelled && !request.signal.aborted) console.warn('Failed to load exhibition', error);
            }
        };
        load();
        const timer = window.setInterval(load, 30000);
        window.addEventListener('focus', load);
        window.addEventListener('exhibition-updated', load);
        const stopLifecycle = onAppStateChange(({ active }) => { if (active) load(); });
        return () => {
            cancelled = true;
            controller?.abort();
            window.clearInterval(timer);
            window.removeEventListener('focus', load);
            window.removeEventListener('exhibition-updated', load);
            stopLifecycle();
        };
    }, [backendUrl, enabled]);

    return exhibition;
}

/** 地图右上角（宽屏右下角）的展会入口；面板由地图（MapUI）渲染，iOS 原生控件接管时为原生面板。 */
export default function MapExhibition({ exhibition, open = false, onOpen, noticeRef, noticeVisible, noticeTop, backendUrl }) {
    const { narrow } = useLayoutPolicy();
    const [top, setTop] = useState(HOME_TOP);
    const entryRef = useRef(null);

    useLayoutEffect(() => {
        const entry = entryRef.current;
        if (!entry || !narrow) return;
        const parent = entry.offsetParent;
        const notice = noticeVisible ? noticeRef?.current : null;
        const update = () => {
            const rect = entry.getBoundingClientRect();
            const parentTop = parent?.getBoundingClientRect().top || 0;
            const homeRect = { left: rect.left, right: rect.right, top: parentTop + HOME_TOP, bottom: parentTop + HOME_TOP + rect.height };
            setTop(getExhibitionTop(homeRect, notice?.getBoundingClientRect(), parentTop));
        };
        update();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        if (parent) observer?.observe(parent);
        if (notice) observer?.observe(notice);
        observer?.observe(entry);
        window.addEventListener('resize', update);
        window.visualViewport?.addEventListener('resize', update);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('resize', update);
        };
    }, [exhibition, noticeVisible, noticeRef, noticeTop, narrow]);

    if (!exhibition) return null;
    return (
        <button ref={entryRef} data-exhibition-entry type="button" onClick={() => onOpen?.()}
            aria-label={t('map:exhibition.open', { name: exhibition.name })} aria-haspopup="dialog" aria-expanded={open}
            title={exhibition.name}
            style={{ position: 'absolute', ...(narrow ? { top } : { bottom: 42 }), right: 12, zIndex: 1650, width: 88, padding: 0,
                border: 0, background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, fontFamily: 'inherit' }}>
            <ExhibitionIcon url={exhibition.icon_url} backendUrl={backendUrl} style={{ background: 'var(--color-bg-surface)', boxShadow: 'var(--shadow-surface)' }} />
            <span style={{ boxSizing: 'border-box', maxWidth: '100%', padding: '2px 5px', fontSize: 11, lineHeight: '16px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderRadius: 6, background: 'var(--color-bg-surface)' }}>
                {exhibition.name}
            </span>
        </button>
    );
}

const paragraphStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 };

const locationRowStyle = { margin: '12px 0 0', display: 'flex', gap: 6, alignItems: 'flex-start', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' };

/**
 * 网页展会面板：宽屏右侧板、窄屏全屏。有展会地点时地址可点（onShowVenue：收起面板、地图移到展会地点），
 * 并提供“展会附近随机美食”（以展会地点为中心的随机美食）。
 */
export function ExhibitionPanel({ open, exhibition, backendUrl, onClose, onRandomNearby, onShowVenue }) {
    const locationName = String(exhibition?.location_name || '').trim();
    const located = !!exhibitionRandomOrigin(exhibition);
    const canRandom = located && typeof onRandomNearby === 'function';
    const canShowVenue = located && typeof onShowVenue === 'function';
    return (
        <ResponsivePanel open={open && !!exhibition} onClose={onClose} title={exhibition?.name || ''}
            desktop="side-right" mobile="full" sideInset={12} sideTop={68} sideBottom={42} width="370px"
            backdrop draggable={false} bodyStyle={{ padding: 20 }}>
            {exhibition && <>
                <ExhibitionIcon url={exhibition.icon_url} backendUrl={backendUrl} />
                {canShowVenue
                    ? <p style={locationRowStyle}>
                        {/* 没填地点名时显示“查看位置” */}
                        <button type="button" data-exhibition-venue onClick={() => onShowVenue(exhibition)}
                            aria-label={locationName ? t('map:exhibition.showVenueLabel', { location: locationName }) : undefined}
                            style={{ display: 'inline-flex', gap: 6, alignItems: 'flex-start', padding: 0, border: 0, background: 'transparent',
                                color: 'var(--theme-primary)', font: 'inherit', textAlign: 'left', cursor: 'pointer', overflowWrap: 'anywhere' }}>
                            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>location_on</span>
                            <span style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>{locationName || t('map:exhibition.showVenue')}</span>
                        </button>
                    </p>
                    : locationName && <p style={locationRowStyle}>
                        <span className="material-symbols-outlined" role="img" aria-label={t('map:exhibition.location')} style={{ fontSize: 20 }}>location_on</span>
                        <span>{locationName}</span>
                    </p>}
                {canRandom && <div style={{ marginTop: 14 }}>
                    <Button full style={{ minHeight: 44 }} onClick={() => onRandomNearby(exhibition)}>
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20, marginRight: 6, verticalAlign: '-4px' }}>casino</span>
                        {t('map:exhibition.randomNearby')}
                    </Button>
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('map:exhibition.randomHint')}</p>
                </div>}
                <h3>{t('map:exhibition.description')}</h3>
                <p style={paragraphStyle}>{exhibition.description}</p>
                <h3>{t('map:exhibition.information')}</h3>
                <p style={paragraphStyle}>{exhibition.information}</p>
            </>}
        </ResponsivePanel>
    );
}
