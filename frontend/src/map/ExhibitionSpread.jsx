import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import { useOverlayEntry } from '../components/overlay/MotionSurface';
import { useOverlayRoot, trapTabKey } from '../components/overlay/overlayContext';
import { createBackdropPressGuard } from '../components/overlay/backdropPress';
import { useMotionFlags } from '../motion/MotionProvider';
import { deckPose, EXHIBITION_ICON_SIZE } from './ExhibitionDeck';
import { t } from '../i18n/index.js';

export default function ExhibitionSpread({ show, onExitComplete, ...props }) {
    const root = useOverlayRoot();
    const target = root === undefined ? document.body : root;
    return target ? createPortal(<AnimatePresence onExitComplete={onExitComplete}>
        {show && <SpreadScene key="exhibition-spread" {...props} root={target} />}
    </AnimatePresence>, target) : null;
}

function SpreadScene({ items, activeId, origin, getOrigin, backendUrl, onClose, onSelect, root }) {
    const present = useIsPresent();
    const { reduced } = useMotionFlags();
    const viewportRef = useRef(null);
    const scrollRef = useRef(0);
    const [press] = useState(createBackdropPressGuard);
    const [bounds, setBounds] = useState(() => root.getBoundingClientRect());
    const { handleRef, order } = useOverlayEntry({ kind: 'exhibition-list', label: t('map:exhibition.all'),
        modal: true, onClose }, { portal: true, isPresent: present });
    useLayoutEffect(() => {
        const update = () => setBounds(root.getBoundingClientRect());
        const observer = new ResizeObserver(update);
        observer.observe(root);
        return () => observer.disconnect();
    }, [root]);
    useEffect(() => { viewportRef.current?.querySelector('button')?.focus({ preventScroll: true }); }, []);
    useEffect(() => { if (!present) viewportRef.current?.focus({ preventScroll: true }); }, [present]);

    const width = Math.min(290, Math.max(120, bounds.width - 32));
    const iconSize = EXHIBITION_ICON_SIZE * 1.1;
    const step = iconSize + 18;
    const totalHeight = items.length * step - 18;
    const left = Math.max(16, bounds.width - width - 16);
    const top = Math.max(24, Math.min(origin.top - bounds.top,
        bounds.height - Math.min(totalHeight, bounds.height - 48) - 24));
    const activeIndex = Math.max(0, items.findIndex(item => item.id === activeId));
    const duration = reduced ? 0.12 : 0.48;
    // Read the hidden deck again on exit: it may have moved after rotation, resizing or notice updates.
    const destination = !present ? getOrigin?.() || origin : origin;

    return <div className="fm-overlay-layer" data-overlay-id={handleRef.current?.id} data-overlay-order={order} style={{ zIndex: order || 1 }}>
        <motion.div ref={viewportRef} className="fm-exhibition-spread" data-exhibition-backdrop tabIndex={-1}
            data-phase={present ? 'open' : 'closing'}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: reduced ? 0.12 : 0.52 }}
            onKeyDown={event => trapTabKey(event, viewportRef.current)}
            onScroll={event => { scrollRef.current = event.currentTarget.scrollTop; }}
            onPointerDown={press.onPointerDown} onPointerUp={press.onPointerUp}
            onPointerCancel={press.onPointerCancel} onPointerLeave={press.onPointerLeave}
            onClick={event => { if (present && press.consumeClick(event)) onClose(); }}>
            <div role="region" aria-label={t('map:exhibition.all')} className="fm-exhibition-spread__column"
                style={{ width, marginLeft: left, paddingTop: top }}>
                {items.map((item, index) => {
                    const depth = (index - activeIndex + items.length) % items.length;
                    const pose = deckPose(depth);
                    const folded = { x: destination.left + destination.width - bounds.left - left - width + pose.x,
                        y: destination.top - bounds.top - top - index * step + pose.y,
                        rotate: pose.rotate, scale: destination.width / iconSize * pose.scale, opacity: pose.opacity };
                    const delay = reduced ? 0 : Math.min(index, 6) * 0.045;
                    return <motion.button key={item.id} type="button" className="fm-exhibition-spread__item"
                        data-exhibition-choice={item.id} disabled={!present}
                        style={{ height: iconSize, transformOrigin: 'top right', zIndex: items.length - depth }}
                        aria-label={t('map:exhibition.open', { name: item.name })}
                        initial={reduced ? { opacity: 0 } : folded}
                        animate={{ x: 0, y: 0, rotate: 0, scale: 1, opacity: 1,
                            transition: reduced ? { duration } : { type: 'spring', duration, bounce: 0.16, delay } }}
                        exit={reduced ? { opacity: 0, transition: { duration } } : {
                            ...folded, y: folded.y + scrollRef.current,
                            transition: { duration: 0.38, delay: Math.min(items.length - index - 1, 6) * 0.025, ease: [0.4, 0, 0.2, 1] }
                        }} onClick={() => onSelect(item)}>
                        <span className="fm-exhibition-spread__art" style={{ width: iconSize, height: iconSize }}><ExhibitionIcon url={item.icon_url} backendUrl={backendUrl}
                            style={{ width: '100%', height: '100%', borderRadius: 0 }} /></span>
                        <motion.span className="fm-exhibition-spread__caption" initial={{ opacity: 0 }}
                            animate={{ opacity: 1, transition: { delay: reduced ? 0 : delay + 0.15, duration: 0.2 } }}
                            exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                            <span className="fm-exhibition-spread__name">{item.name}</span>
                            {item.event_time && <time dateTime={item.event_time}>{item.event_time.replace('T', ' ')}</time>}
                        </motion.span>
                    </motion.button>;
                })}
            </div>
        </motion.div>
    </div>;
}
