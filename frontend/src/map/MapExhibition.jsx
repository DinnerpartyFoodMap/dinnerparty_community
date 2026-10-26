import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import ExhibitionDeck from './ExhibitionDeck';
import ExhibitionSpread from './ExhibitionSpread';
import Button from '../components/primitives/Button';
import MarqueeText from '../components/primitives/MarqueeText';
import Markdown from '../components/markdown/Markdown';
import { getExhibitionTop } from './exhibitionLayout';
import { exhibitionRandomOrigin } from './exhibition';
import { useLayoutPolicy } from '../motion/MotionProvider';
import { t } from '../i18n/index.js';
import './exhibition-stack.css';

// Keep the entry 30px below the map's top edge when no notice overlaps it.
const HOME_TOP = 30;

/** 地图右上角（宽屏右下角）的展会入口；面板由地图（MapUI）渲染，iOS 原生控件接管时为原生面板。 */
export default function MapExhibition({ exhibition, exhibitions = [], open = false, onOpen, noticeRef, noticeVisible, noticeTop, backendUrl }) {
    const { narrow } = useLayoutPolicy();
    const [top, setTop] = useState(HOME_TOP);
    const entryRef = useRef(null);
    const stackRef = useRef(null);
    const [expanded, setExpanded] = useState(false);
    const [spreadOrigin, setSpreadOrigin] = useState(null);
    const pendingSelection = useRef(null);
    const multiple = exhibitions.length > 1;
    useEffect(() => {
        if (!multiple) setExpanded(false);
    }, [multiple]);

    function readDeckOrigin() {
        const rect = entryRef.current?.querySelector('.fm-exhibition-deck')?.getBoundingClientRect();
        return rect ? { left: rect.left, top: rect.top, width: rect.width } : null;
    }

    function expand() {
        const origin = readDeckOrigin();
        if (!origin) return;
        pendingSelection.current = null;
        setSpreadOrigin(origin);
        setExpanded(true);
    }

    function finishGathering() {
        setSpreadOrigin(null);
        const selected = exhibitions.find(item => item.id === pendingSelection.current);
        pendingSelection.current = null;
        // Wait for the portal's inert boundary to clear before restoring the persistent trigger.
        requestAnimationFrame(() => {
            entryRef.current?.focus({ preventScroll: true });
            if (selected) onOpen?.(selected);
        });
    }

    useLayoutEffect(() => {
        const entry = entryRef.current;
        if (!entry || !narrow) return;
        const parent = stackRef.current?.offsetParent;
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

    return <>
        {exhibition && <div ref={stackRef} className="fm-exhibition-stack" style={{ position: 'absolute', ...(narrow ? { top } : { bottom: 42 }),
            right: 12, zIndex: 1650, width: 88, visibility: spreadOrigin ? 'hidden' : undefined }}>
            <button ref={entryRef} data-exhibition-entry type="button" onClick={() => multiple ? expand() : onOpen?.(exhibition)}
                aria-label={multiple ? t('map:exhibition.count', { count: exhibitions.length }) : t('map:exhibition.open', { name: exhibition.name })}
                aria-haspopup={multiple ? undefined : 'dialog'} aria-expanded={multiple ? expanded : open}
                title={exhibition.name} className="fm-exhibition-stack__entry">
                {multiple ? <ExhibitionDeck items={exhibitions} activeId={exhibition.id} backendUrl={backendUrl} paused={!!spreadOrigin} />
                    : <ExhibitionIcon url={exhibition.icon_url} backendUrl={backendUrl} style={{ background: 'var(--color-bg-surface)', boxShadow: 'var(--shadow-surface)' }} />}
                <span className="fm-exhibition-stack__label"><MarqueeText text={exhibition.name} /></span>
                {multiple && <span className="fm-exhibition-stack__label">{t('map:exhibition.count', { count: exhibitions.length })}</span>}
            </button>
        </div>}
        <ExhibitionSpread show={expanded && multiple} origin={spreadOrigin} getOrigin={readDeckOrigin} items={exhibitions} activeId={exhibition?.id}
            backendUrl={backendUrl} onClose={() => setExpanded(false)} onExitComplete={finishGathering}
            onSelect={item => { pendingSelection.current = item.id; setExpanded(false); }} />
    </>;
}

const paragraphStyle = { lineHeight: 1.7 };

const locationRowStyle = { margin: '12px 0 0', display: 'flex', gap: 6, alignItems: 'flex-start', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' };

/**
 * 网页展会面板：宽屏右侧板、窄屏全屏。有展会地点时地址可点（onShowVenue：收起面板、地图移到展会地点），
 * 并提供“展会附近随机美食”（以展会地点为中心的随机美食）。长展会名单行来回滚动，简介与信息按 Markdown 显示。
 */
export function ExhibitionPanel({ open, exhibition, backendUrl, onClose, onRandomNearby, onShowVenue }) {
    const locationName = String(exhibition?.location_name || '').trim();
    const located = !!exhibitionRandomOrigin(exhibition);
    const canRandom = located && typeof onRandomNearby === 'function';
    const canShowVenue = located && typeof onShowVenue === 'function';
    return (
        <ResponsivePanel open={open && !!exhibition} onClose={onClose}
            title={exhibition ? <MarqueeText text={exhibition.name} /> : ''} label={exhibition?.name || ''}
            desktop="side-right" mobile="full" sideInset={12} sideTop={68} sideBottom={42} width="370px"
            backdrop draggable={false} bodyStyle={{ padding: 20 }}>
            {exhibition && <>
                <ExhibitionIcon url={exhibition.icon_url} backendUrl={backendUrl} />
                {exhibition.event_time && <p style={locationRowStyle}><time dateTime={exhibition.event_time}>{t('map:exhibition.eventTime')}：{exhibition.event_time.replace('T', ' ')}</time></p>}
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
                <Markdown text={exhibition.description} style={paragraphStyle} />
                <h3>{t('map:exhibition.information')}</h3>
                <Markdown text={exhibition.information} style={paragraphStyle} />
            </>}
        </ResponsivePanel>
    );
}
