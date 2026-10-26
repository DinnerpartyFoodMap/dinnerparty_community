import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import ExhibitionIcon from '../components/primitives/ExhibitionIcon';
import { useMotionFlags } from '../motion/MotionProvider';

export const EXHIBITION_ICON_SIZE = 48;

export function deckPose(depth) {
    const layer = Math.min(depth, 3);
    return { x: layer % 2 ? -4 : layer * 2, y: -layer * 2,
        rotate: layer === 0 ? 0 : layer % 2 ? -9 : 8, scale: 1 - layer * 0.035,
        opacity: depth < 3 ? 1 : 0 };
}

function orderedIds(items, activeId) {
    const index = Math.max(0, items.findIndex(item => item.id === activeId));
    return [...items.slice(index), ...items.slice(0, index)].map(item => item.id);
}

/** Stable keyed cards: the outgoing face travels sideways, then slips underneath its neighbours. */
export default function ExhibitionDeck({ items, activeId, backendUrl, paused }) {
    const { reduced } = useMotionFlags();
    const [deck, setDeck] = useState(() => ({ ids: orderedIds(items, activeId), next: null }));
    const signature = items.map(item => item.id).join(',');
    useEffect(() => {
        const next = orderedIds(items, activeId);
        setDeck(previous => {
            const sameMembers = previous.ids.length === next.length && previous.ids.every(id => next.includes(id));
            if (!sameMembers || paused || reduced) return { ids: next, next: null };
            if (previous.ids[0] === activeId) return previous;
            // Live edits/removals may move the active item by more than one position.
            return previous.ids[1] === activeId ? { ...previous, next } : { ids: next, next: null };
        });
    }, [activeId, signature, paused, reduced]);

    return <span className="fm-exhibition-deck" style={{ width: EXHIBITION_ICON_SIZE, height: EXHIBITION_ICON_SIZE }}
        aria-hidden="true" data-shuffling={deck.next ? '' : undefined}>
        {deck.ids.map((id, depth) => {
            const item = items.find(candidate => candidate.id === id);
            if (!item) return null;
            const leaving = !!deck.next && depth === 0;
            const targetDepth = deck.next ? deck.next.indexOf(id) : depth;
            const target = deckPose(targetDepth);
            const zIndex = items.length - targetDepth;
            return <motion.span key={id} className="fm-exhibition-deck__card" data-exhibition-card={id} data-depth={targetDepth}
                initial={false}
                animate={leaving ? {
                    x: [0, -44, -40, target.x], y: [0, -10, 5, target.y],
                    rotate: [0, -17, -12, target.rotate], scale: [1, 1.02, target.scale, target.scale],
                    opacity: [1, 1, 1, target.opacity], zIndex: [items.length + 1, items.length + 1, 0, zIndex]
                } : { ...target, zIndex }}
                transition={leaving ? { duration: 0.72, times: [0, 0.4, 0.62, 1], ease: [0.22, 1, 0.36, 1],
                    zIndex: { duration: 0.72, times: [0, 0.43, 0.44, 1], ease: 'linear' } }
                    : { duration: reduced ? 0 : 0.62, ease: [0.22, 1, 0.36, 1] }}
                onAnimationComplete={() => {
                    if (leaving) setDeck(previous => previous.next && previous.ids[0] === id
                        ? { ids: previous.next, next: null } : previous);
                }}>
                <ExhibitionIcon url={item.icon_url} backendUrl={backendUrl} style={{ width: '100%', height: '100%', borderRadius: 0 }} />
            </motion.span>;
        })}
    </span>;
}
