import { useEffect, useRef, useState } from 'react';
import { getFreshLocation } from '../../platform/geolocation';
import { isAppActive } from '../../platform/lifecycle';
import { imageThumbnailDataUrl, pickImages, prepareImageForUpload } from '../../platform/mediaPicker';
import { ratingRequestId } from '../../api/client';
import { CHECK_IN_DESCRIPTION_LIMIT, CHECK_IN_PHOTO_LIMIT, submitCheckIn } from '../checkInSubmission';
import { t } from '../../i18n';

const PHOTO_UPLOAD_LIMITS = { maxBytes: 3 * 1024 * 1024, targetBytes: 1024 * 1024, maxDimension: 1600, quality: 0.83 };
const EMPTY = Object.freeze({ description: '', score: null, photos: [], pending: '', error: '', receipt: null });

/**
 * 地点打卡的表单状态与提交：网页面板（PlaceCheckInPanel）与 iOS 原生玻璃面板（checkInChromeSheet）共用这一份。
 * sessionKey 是这一次打开的身份（地点 + 打开序号），为 null 表示没有打开；变化时清空表单、取消进行中的请求
 * （与旧网页面板卸载时相同）。thumbnails 为真时给已选照片生成小缩略图（原生面板显示用）。
 * photos 每项 { id, file, thumbnail }：id 在这次打开内递增，删除后不会错位。
 */
export default function usePlaceCheckIn({ sessionKey, placeId, backendUrl, token, thumbnails = false, onSuccess }) {
    const [state, setState] = useState(() => ({ key: sessionKey, ...EMPTY }));
    const keyRef = useRef(sessionKey);
    keyRef.current = sessionKey;
    const onSuccessRef = useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const requestId = useRef(null);
    const controller = useRef(null);
    const photoSeq = useRef(0);

    useEffect(() => {
        requestId.current = null;
        return () => {
            controller.current?.abort();
            controller.current = null;
        };
    }, [sessionKey]);

    const view = state.key === sessionKey ? state : { key: sessionKey, ...EMPTY };
    const viewRef = useRef(view);
    viewRef.current = view;

    // 只写入发起时那一次打开的状态：换了地点或关掉后，迟到的结果被丢弃
    const patch = (key, change) => setState((previous) => {
        if (keyRef.current !== key) return previous;
        const base = previous.key === key ? previous : { key, ...EMPTY };
        return { ...base, ...(typeof change === 'function' ? change(base) : change) };
    });
    // 改了内容就是新的一次提交：不再沿用上一次的请求编号
    const resetAttempt = (key) => {
        requestId.current = null;
        patch(key, { error: '' });
    };

    const setDescription = (text) => {
        const key = sessionKey;
        if (!key || viewRef.current.pending || viewRef.current.receipt) return;
        const next = String(text ?? '').slice(0, CHECK_IN_DESCRIPTION_LIMIT);
        if (next === viewRef.current.description) return;
        patch(key, { description: next });
        resetAttempt(key);
    };

    const toggleScore = (score) => {
        const key = sessionKey;
        if (!key || viewRef.current.pending || viewRef.current.receipt) return;
        patch(key, (base) => ({ score: base.score === score ? null : score }));
        resetAttempt(key);
    };

    const removePhoto = (id) => {
        const key = sessionKey;
        if (!key || viewRef.current.pending || viewRef.current.receipt) return;
        patch(key, (base) => ({ photos: base.photos.filter((photo) => photo.id !== id) }));
        resetAttempt(key);
    };

    async function choosePhotos() {
        const key = sessionKey;
        const current = viewRef.current;
        if (!key || current.pending || current.receipt || current.photos.length >= CHECK_IN_PHOTO_LIMIT) return;
        patch(key, { pending: 'photos', error: '' });
        try {
            const files = await pickImages({ multiple: true, limit: CHECK_IN_PHOTO_LIMIT - current.photos.length });
            const ready = await Promise.all(files.map((file) => prepareImageForUpload(file, PHOTO_UPLOAD_LIMITS)));
            const added = await Promise.all(ready.map(async (file) => ({
                id: ++photoSeq.current,
                file,
                thumbnail: thumbnails ? await imageThumbnailDataUrl(file) : null
            })));
            if (added.length) {
                patch(key, (base) => ({ photos: [...base.photos, ...added].slice(0, CHECK_IN_PHOTO_LIMIT) }));
                resetAttempt(key);
            }
        } catch (failure) {
            patch(key, { error: failure.message });
        } finally {
            patch(key, { pending: '' });
        }
    }

    async function submit() {
        const key = sessionKey;
        const current = viewRef.current;
        if (!key || current.pending || placeId == null) return;
        patch(key, { pending: 'submit', error: '' });
        const active = new AbortController();
        controller.current = active;
        try {
            const { ok, body: result } = await submitCheckIn({
                retry: !!requestId.current,
                hasReceipt: !!current.receipt,
                locate: () => getFreshLocation({ prompt: true, maxAccuracy: 25, signal: active.signal }),
                send: async (fix) => {
                    if (!isAppActive()) throw new Error(t('map:checkIn.failed'));
                    requestId.current ||= ratingRequestId();
                    const body = new FormData();
                    const location = fix && { lat: fix.lat, lng: fix.lng, coordSystem: fix.coordSystem, source: fix.source,
                        timestamp: fix.timestamp, accuracy: fix.accuracy };
                    body.append('payload', JSON.stringify({ request_id: requestId.current, description: current.description, score: current.score, fix: location }));
                    for (const photo of current.photos) body.append('photos', photo.file, photo.file.name);
                    const response = await fetch(`${backendUrl}/places/${encodeURIComponent(placeId)}/check-ins`, {
                        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: active.signal, body
                    });
                    const parsed = await response.json().catch(() => null);
                    if (response.ok && !parsed?.id) throw new Error(t('map:checkIn.failed'));
                    return { ok: response.ok, body: parsed || {} };
                }
            });
            if (!ok) throw new Error(result.error || t('map:checkIn.failed'));
            if (!current.receipt) window.dispatchEvent(new Event('foodmap:companion-fed'));
            patch(key, { receipt: result, error: result.rating_error || '' });
            onSuccessRef.current?.(result);
        } catch (failure) {
            if (!active.signal.aborted) patch(key, { error: failure.message || t('map:checkIn.failed') });
        } finally {
            if (!active.signal.aborted) patch(key, { pending: '' });
            if (controller.current === active) controller.current = null;
        }
    }

    const receipt = view.receipt;
    return {
        open: !!sessionKey,
        description: view.description,
        score: view.score,
        photos: view.photos,
        pending: view.pending,
        error: view.error,
        receipt,
        // 打卡已成功、只是评分没存上：主按钮改成“重试保存评分”（同一请求编号重放）
        retryRating: !!(receipt && view.score !== null && !receipt.rating_saved && receipt.rating_retryable !== false),
        setDescription,
        toggleScore,
        removePhoto,
        choosePhotos,
        submit
    };
}
