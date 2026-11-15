import { useEffect, useState } from 'react';
import { startPublicPolling, freshUrl, PUBLIC_UPDATE_EVENTS } from '../platform/polling';

/**
 * Poll publications independently of rotation. Preserve the active ID across refreshes and edits.
 * 展会列表是公共缓存接口：低频轮询（platform/polling.js），管理员改了展会后立即读最新的。
 */
export function useExhibitions(backendUrl, enabled = true) {
    const [state, setState] = useState({ exhibitions: [], activeId: null });
    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        let controller;
        const load = async ({ fresh }) => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            try {
                const url = `${backendUrl}/exhibitions`;
                const res = await fetch(fresh ? freshUrl(url) : url, { signal: request.signal, ...(fresh ? { cache: 'no-store' } : {}) });
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
        const stop = startPublicPolling(load, { updateEvent: PUBLIC_UPDATE_EVENTS.exhibition });
        return () => {
            cancelled = true;
            controller?.abort();
            stop();
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
