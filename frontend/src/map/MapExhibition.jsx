import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { onAppStateChange } from '../platform/lifecycle';
import { getExhibitionTop } from './exhibitionLayout';
import { useLayoutPolicy } from '../motion/MotionProvider';
import { t } from '../i18n/index.js';

// Keep the entry 30px below the map's top edge when no notice overlaps it.
const HOME_TOP = 30;

export default function MapExhibition({ backendUrl, noticeRef, noticeVisible, noticeTop }) {
    const { narrow } = useLayoutPolicy();
    const [exhibition, setExhibition] = useState(null);
    const [open, setOpen] = useState(false);
    const [top, setTop] = useState(HOME_TOP);
    const entryRef = useRef(null);

    useEffect(() => {
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
                setExhibition(data.exhibition || null);
                if (!data.exhibition) setOpen(false);
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
    }, [backendUrl]);

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
    return <>
        <button ref={entryRef} data-exhibition-entry type="button" onClick={() => setOpen(true)}
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
        <ResponsivePanel open={open} onClose={() => setOpen(false)} title={exhibition.name}
            desktop="side-right" mobile="full" sideInset={12} sideTop={68} sideBottom={42} width="370px"
            backdrop draggable={false} bodyStyle={{ padding: 20 }}>
            <ExhibitionIcon url={exhibition.icon_url} backendUrl={backendUrl} />
            <h3>{t('map:exhibition.description')}</h3>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 }}>{exhibition.description}</p>
            <h3>{t('map:exhibition.information')}</h3>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 }}>{exhibition.information}</p>
        </ResponsivePanel>
    </>;
}
