import { useEffect, useRef, useState } from 'react';
import { fetchCompanionState } from '../skins/skinApi';

// 默认角色的持久化标识，替换内置模型时沿用，以保留选择与投喂记录。
export const DEFAULT_COMPANION = 'stick-figure';
// fed_at 上次投喂、adopted_at 领养时间（底栏小伙伴的饿 / 饱，见 companionBehavior.js）
const DEFAULT = { active: DEFAULT_COMPANION, satiety: 0, owned: [], fed_at: null, adopted_at: null };

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
