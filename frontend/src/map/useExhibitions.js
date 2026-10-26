import { useEffect, useState } from 'react';
import { onAppStateChange } from '../platform/lifecycle';

/** Poll publications independently of rotation. Preserve the active ID across refreshes and edits. */
export function useExhibitions(backendUrl, enabled = true) {
    const [state, setState] = useState({ exhibitions: [], activeId: null });
    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        let controller;
        const load = async () => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            try {
                const res = await fetch(`${backendUrl}/exhibitions`, { signal: request.signal });
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled || request.signal.aborted || !Array.isArray(data.exhibitions)) return;
                setState(previous => {
                    const next = data.exhibitions;
                    if (JSON.stringify(previous.exhibitions) === JSON.stringify(next)) return previous;
                    const activeId = next.some(item => item.id === previous.activeId) ? previous.activeId
                        : next[previous.exhibitions.length ? 0 : Math.floor(Math.random() * next.length)]?.id ?? null;
                    return { exhibitions: next, activeId };
                });
            } catch (error) {
                if (!cancelled && !request.signal.aborted) console.warn('Failed to load exhibitions', error);
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

    useEffect(() => {
        if (!enabled || state.exhibitions.length < 2) return undefined;
        const timer = window.setInterval(() => setState(previous => {
            const index = previous.exhibitions.findIndex(item => item.id === previous.activeId);
            return { ...previous, activeId: previous.exhibitions[(index + 1) % previous.exhibitions.length]?.id ?? null };
        }), 10000);
        return () => window.clearInterval(timer);
    }, [enabled, state.exhibitions.length]);

    return { exhibitions: state.exhibitions, exhibition: state.exhibitions.find(item => item.id === state.activeId) || null };
}
