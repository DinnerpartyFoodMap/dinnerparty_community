import { useEffect, useRef, useState } from 'react';
import { fetchCompanionState } from '../skins/skinApi';

export const DEFAULT_COMPANION = 'stick-figure';
const DEFAULT = { active: DEFAULT_COMPANION, satiety: 0, owned: [] };

export function useCompanion(backendUrl, token) {
    const [data, setData] = useState(null);
    const generation = useRef(0);
    const update = (state) => {
        generation.current += 1;
        setData({ token, state });
    };

    useEffect(() => {
        if (!token) return undefined;
        const controller = new AbortController();
        const refresh = () => {
            const current = ++generation.current;
            fetchCompanionState(backendUrl, token, { signal: controller.signal }).then((state) => {
                if (!controller.signal.aborted && generation.current === current) setData({ token, state });
            }).catch(() => {});
        };
        refresh();
        window.addEventListener('foodmap:companion-fed', refresh);
        window.addEventListener('focus', refresh);
        return () => {
            controller.abort();
            window.removeEventListener('foodmap:companion-fed', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [backendUrl, token]);

    return { state: data?.token === token ? data.state : DEFAULT, update };
}
