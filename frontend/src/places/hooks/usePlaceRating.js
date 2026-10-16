import { useEffect, useRef, useState } from 'react';
import * as Api from "../../api/client";

/**
 * 选中地点的评价（汇总、自己的评价、按口味加权、今日次数）。
 * 每个响应都绑定发起时的地点与账号：切换地点或账号会取消旧请求，迟到的旧响应不会覆盖新状态。
 * onSummary(placeId, summary)：拿到最新汇总后通知地图，更新该地点的评价字段（避雷图标等）。
 */
export default function usePlaceRating({ backendUrl, token, placeId, onSummary }) {
    const key = placeId == null ? null : `${placeId}|${token || ''}`;
    const keyRef = useRef(key);
    keyRef.current = key;
    const onSummaryRef = useRef(onSummary);
    onSummaryRef.current = onSummary;
    const [state, setState] = useState({ key: null, data: null, loading: false, error: '' });
    const [saving, setSaving] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (placeId == null) {
            setState({ key: null, data: null, loading: false, error: '' });
            return undefined;
        }
        const requestKey = key;
        const controller = new AbortController();
        setState((previous) => ({ key: requestKey, data: previous.key === requestKey ? previous.data : null, loading: true, error: '' }));
        Api.fetchPlaceRating(backendUrl, placeId, { token, signal: controller.signal })
            .then((data) => {
                if (keyRef.current !== requestKey) return;
                setState({ key: requestKey, data, loading: false, error: '' });
                onSummaryRef.current?.(placeId, data.summary);
            })
            .catch((error) => {
                if (error?.name === 'AbortError' || keyRef.current !== requestKey) return;
                setState((previous) => ({ ...previous, key: requestKey, loading: false, error: error.message || String(error) }));
            });
        return () => controller.abort();
    }, [backendUrl, token, placeId, reloadToken]);

    // 保存期间切换了地点：结果仍更新原地点的标记，但不写入当前面板
    const run = async (request) => {
        const requestKey = key;
        const requestPlace = placeId;
        setSaving(true);
        try {
            const data = await request();
            onSummaryRef.current?.(requestPlace, data.summary);
            if (keyRef.current === requestKey) setState({ key: requestKey, data, loading: false, error: '' });
            return data;
        } finally {
            setSaving(false);
        }
    };

    const current = state.key === key ? state : { data: null, loading: placeId != null, error: '' };
    return {
        data: current.data,
        loading: current.loading,
        error: current.error,
        saving,
        submit: (score) => run(() => Api.savePlaceRating(backendUrl, token, placeId, score)),
        withdraw: () => run(() => Api.withdrawPlaceRating(backendUrl, token, placeId)),
        reload: () => setReloadToken((value) => value + 1)
    };
}
