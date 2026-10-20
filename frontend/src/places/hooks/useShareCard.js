// 分享卡片的状态：按需生成横/竖版、缓存已生成的图片、分享或保存。
// 生成失败只影响卡片面板，不影响地点本身；关闭面板时释放 object URL。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPlaceShareCard } from '../shareCard';
import { describeShareResult, saveImageBlob, shareImageBlob } from '../../platform/share';
import { t } from '../../i18n/index.js';

export default function useShareCard({ onRecord, onTip } = {}) {
    const [visible, setVisible] = useState(false);
    const [orientation, setOrientation] = useState('portrait');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [view, setView] = useState(null);
    const modelRef = useRef(null);
    const viewsRef = useRef(new Map());
    const requestRef = useRef(0);
    const viewRef = useRef(null);

    const applyView = (entry) => {
        viewRef.current = entry;
        setView(entry);
    };

    const release = () => {
        for (const entry of viewsRef.current.values()) URL.revokeObjectURL(entry.url);
        viewsRef.current.clear();
        applyView(null);
    };

    const render = useCallback(async (target) => {
        const model = modelRef.current;
        if (!model) return;
        const cached = viewsRef.current.get(target);
        if (cached) {
            applyView(cached);
            setFailed(false);
            setBusy(false);
            return;
        }
        const requestId = requestRef.current + 1;
        requestRef.current = requestId;
        setBusy(true);
        setFailed(false);
        applyView(null);
        try {
            const { blob, filename } = await createPlaceShareCard(model, target);
            if (requestRef.current !== requestId) return;
            const entry = { url: URL.createObjectURL(blob), blob, filename, name: model.name };
            viewsRef.current.set(target, entry);
            applyView(entry);
        } catch (error) {
            if (requestRef.current === requestId) setFailed(true);
        } finally {
            if (requestRef.current === requestId) setBusy(false);
        }
    }, []);

    const start = useCallback((model) => {
        requestRef.current += 1;
        release();
        modelRef.current = model;
        setVisible(true);
        setOrientation('portrait');
        void render('portrait');
    }, [render]);

    const switchTo = useCallback((target) => {
        const key = target === 'landscape' ? 'landscape' : 'portrait';
        setOrientation(key);
        void render(key);
    }, [render]);

    const retry = useCallback(() => {
        void render(orientation);
    }, [render, orientation]);

    const close = useCallback(() => {
        requestRef.current += 1;
        setVisible(false);
        setBusy(false);
        setFailed(false);
        release();
        modelRef.current = null;
    }, []);

    const share = useCallback(async () => {
        const current = viewRef.current;
        if (!current) return;
        const result = await shareImageBlob(current.blob, current.filename, { title: current.name, text: current.name });
        if (result === 'shared') {
            onRecord?.('share', 'card');
            return;
        }
        if (result === 'unsupported') {
            const saved = await saveImageBlob(current.blob, current.filename, { title: current.name });
            if (saved === 'downloaded' || saved === 'shared') onRecord?.('share', 'card');
            const message = describeShareResult(saved, { savedText: t('map:ui.share.cardSaved') });
            if (message) onTip?.(message);
            return;
        }
        if (result === 'failed') onTip?.(t('map:ui.share.cardShareFailed'));
    }, [onRecord, onTip]);

    const save = useCallback(async () => {
        const current = viewRef.current;
        if (!current) return;
        const saved = await saveImageBlob(current.blob, current.filename, { title: current.name });
        if (saved === 'downloaded' || saved === 'shared') onRecord?.('share', 'card');
        const message = describeShareResult(saved, { savedText: t('map:ui.share.cardSaved') });
        if (message) onTip?.(message);
    }, [onRecord, onTip]);

    useEffect(() => () => {
        requestRef.current += 1;
        for (const entry of viewsRef.current.values()) URL.revokeObjectURL(entry.url);
        viewsRef.current.clear();
    }, []);

    return { visible, orientation, busy, failed, view, start, close, switchTo, retry, share, save };
}
