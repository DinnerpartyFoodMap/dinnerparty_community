import { useEffect, useMemo, useRef, useState } from 'react';
import { myComment, readPlaceComments } from '../placeComments';

const CHECKING_RECHECK_MS = 5000;
const CHECKING_RECHECKS = 3;

/**
 * 选中地点的住民评论（GET /places/:id 的 comments）。从地图快照补全过的地点自带这一字段；
 * 搜索、列表、收藏等来源的地点没有时，再读一次单店详情（loadDetail 与补全共用缓存）。
 * 自己的评论还在 AI 初筛（checking，通常几秒）时隔几秒重读，“审核中”换成结果。
 * 返回 { comments, mine, reload }；comments 为 null 表示还没读到。
 */
export default function usePlaceComments({ place, token, loadDetail }) {
    const placeId = place && place.isMarked !== false && !place.exhibitionVenue ? place.id : null;
    const key = placeId == null ? null : `${placeId}|${token || ''}`;
    const keyRef = useRef(key);
    keyRef.current = key;
    const loadRef = useRef(loadDetail);
    loadRef.current = loadDetail;
    const [state, setState] = useState({ key: null, comments: null });
    const rawInline = placeId != null ? place.comments : undefined;
    const inline = useMemo(() => readPlaceComments(rawInline), [rawInline]);

    const fetchComments = async (fresh) => {
        const requestKey = keyRef.current;
        const requestId = placeId;
        if (!requestKey || !loadRef.current) return;
        try {
            const full = await loadRef.current(requestId, { fresh });
            if (keyRef.current !== requestKey) return;
            setState({ key: requestKey, comments: readPlaceComments(full?.comments) || [] });
        } catch {
            // 读不到（限流、网络）时只显示描述
        }
    };

    useEffect(() => {
        if (!key || inline) return;
        fetchComments(false);
    }, [key, !!inline]);

    const comments = state.key === key && state.comments ? state.comments : inline;
    const mine = myComment(comments);

    // 自己的评论在初筛：过几秒重读，最多几次
    const recheckRef = useRef({ key: null, count: 0 });
    const checking = mine?.status === 'checking';
    useEffect(() => {
        if (!key || !checking) return undefined;
        if (recheckRef.current.key !== key) recheckRef.current = { key, count: 0 };
        if (recheckRef.current.count >= CHECKING_RECHECKS) return undefined;
        const timer = setTimeout(() => {
            recheckRef.current.count += 1;
            fetchComments(true);
        }, CHECKING_RECHECK_MS);
        return () => clearTimeout(timer);
    }, [key, checking, comments]);

    return {
        comments,
        mine,
        reload: () => {
            recheckRef.current = { key, count: 0 };
            return fetchComments(true);
        }
    };
}
